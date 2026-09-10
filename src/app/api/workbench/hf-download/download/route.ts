import { NextRequest } from "next/server";
import {
  hfDownloadPython,
  hfDownloadTargetKey,
  parseHfDownloadRequest,
  redactHfDownloadError,
  spawnHfDownload,
} from "@/lib/hf-download-runtime";
import {
  activeDatasetWrite,
  beginDatasetWrite,
  finishDatasetWrite,
} from "@/lib/dataset-write-lock";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "Cross-origin downloads are not allowed." },
      { status: 403, headers: noStoreHeaders() },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Expected a JSON body." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  let parsed;
  try {
    parsed = await parseHfDownloadRequest(body);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  const revisionSha =
    body && typeof body === "object" && "revisionSha" in body
      ? (body as { revisionSha?: unknown }).revisionSha
      : null;
  if (
    typeof revisionSha !== "string" ||
    !/^[A-Fa-f0-9]{7,64}$/u.test(revisionSha)
  ) {
    return Response.json(
      { error: "A valid revisionSha from Check download is required." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  const writeKey = hfDownloadTargetKey(parsed);
  const busy = activeDatasetWrite(writeKey);
  if (busy) {
    return Response.json(
      { error: `Another dataset write (${busy.label}) is already running.` },
      { status: 409, headers: noStoreHeaders() },
    );
  }
  let python: string;
  try {
    python = await hfDownloadPython();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502, headers: noStoreHeaders() },
    );
  }
  const lease = beginDatasetWrite("hf-download", parsed.source, writeKey);
  if (!lease) {
    return Response.json(
      { error: "Another dataset write started before this download." },
      { status: 409, headers: noStoreHeaders() },
    );
  }
  let child: ReturnType<typeof spawnHfDownload> | null = null;
  let streamCancelled = false;
  const stopChild = () => {
    streamCancelled = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000);
    forceKill.unref();
  };
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let buffer = "";
        let sentError = false;
        const sendLine = (line: string) => {
          if (closed || !line.trim()) return;
          try {
            const event = JSON.parse(line) as { type?: string };
            if (event.type === "error") sentError = true;
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // Ignore non-protocol output without exposing process details.
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          finishDatasetWrite(lease);
          try {
            controller.close();
          } catch {
            // The browser may already have cancelled its reader.
          }
        };
        try {
          if (streamCancelled) {
            close();
            return;
          }
          child = spawnHfDownload(python, {
            ...parsed,
            action: "download",
            revisionSha,
          });
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "error", error: String(error) })}\n`,
            ),
          );
          close();
          return;
        }
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? "";
          for (const line of lines) sendLine(line);
        });
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (error) => {
          sendLine(JSON.stringify({ type: "error", error: error.message }));
          close();
        });
        child.on("close", (code) => {
          sendLine(buffer);
          if (code !== 0 && !sentError && !closed) {
            sendLine(
              JSON.stringify({
                type: "error",
                error: redactHfDownloadError(
                  stderr.trim().split(/\r?\n/u).pop() ||
                    `Download exited with code ${code}.`,
                  parsed.token,
                ),
              }),
            );
          }
          close();
        });
      },
      cancel() {
        stopChild();
        // Keep the lease until the process exits and its staging cleanup has
        // finished; SIGTERM can arrive while a cached file call is blocked.
      },
    }),
    { headers: noStoreHeaders("application/x-ndjson; charset=utf-8") },
  );
}

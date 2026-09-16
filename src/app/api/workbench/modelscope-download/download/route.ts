import { NextRequest } from "next/server";
import {
  downloadModelScopeDataset,
  ModelScopeDownloadCancelled,
  ModelScopeDownloadConflict,
  modelScopeDownloadTargetKey,
  parseModelScopeDownloadRequest,
  redactModelScopeDownloadError,
} from "@/lib/modelscope-download-runtime";
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
    parsed = await parseModelScopeDownloadRequest(body);
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
  const writeKey = modelScopeDownloadTargetKey(parsed);
  const busy = activeDatasetWrite(writeKey);
  if (busy) {
    return Response.json(
      { error: `Another dataset write (${busy.label}) is already running.` },
      { status: 409, headers: noStoreHeaders() },
    );
  }
  const lease = beginDatasetWrite(
    "modelscope-download",
    parsed.source,
    writeKey,
  );
  if (!lease) {
    return Response.json(
      { error: "Another dataset write started before this download." },
      { status: 409, headers: noStoreHeaders() },
    );
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const signal = AbortSignal.any([request.signal, abort.signal]);
        const send = (value: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          } catch {
            closed = true;
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
          const result = await downloadModelScopeDataset(
            parsed,
            revisionSha,
            send,
            signal,
          );
          send({ type: "result", result });
        } catch (error: unknown) {
          if (error instanceof ModelScopeDownloadCancelled) {
            send({ type: "error", code: "CANCELLED", error: error.message });
          } else if (error instanceof ModelScopeDownloadConflict) {
            send({
              type: "error",
              code: "REVISION_CONFLICT",
              error: redactModelScopeDownloadError(error, parsed.token),
            });
          } else {
            send({
              type: "error",
              code: "MODELSCOPE_DOWNLOAD_FAILED",
              error: redactModelScopeDownloadError(error, parsed.token),
            });
          }
        } finally {
          close();
        }
      },
      cancel() {
        abort.abort();
        // Keep the lease until the async downloader leaves staging cleanup.
      },
    }),
    { headers: noStoreHeaders("application/x-ndjson; charset=utf-8") },
  );
}

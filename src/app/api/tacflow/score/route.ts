import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/request-security";
import { recordWorkbenchSharedEvent } from "@/lib/workbench-shared-sync";
import {
  type ActiveTacFlowRun,
  releaseTacFlowRun,
  tryAcquireTacFlowRun,
} from "@/lib/tacflow/lock";
import {
  parseTacFlowDoctorReport,
  type TacFlowDoctorReport,
  type TacFlowScoreStreamEvent,
} from "@/lib/tacflow/scoring";
import {
  TACFLOW_ENGINE_ROOT,
  resolveTacFlowDataset,
  type TacFlowDatasetSelection,
} from "@/lib/tacflow/datasets";
import type { TacFlowArtifacts } from "@/types/tacflow.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAMBA_SH = "/home/xense/miniforge3/etc/profile.d/mamba.sh";
const MAMBA_ENV = "TacFlow-main";
const MAX_TAIL_LINES = 20;

type CapturedStreams = {
  stdout: string[];
  stderr: string[];
};

type TacFlowScoreRequestBody = {
  datasetPath?: unknown;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function commandLine(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function scoreArtifacts(dataset: TacFlowDatasetSelection): TacFlowArtifacts {
  return {
    doctorBeforeMarkdown: dataset.doctorBeforeMarkdown,
    doctorBeforeJson: dataset.doctorBeforeJson,
    autoProcess: dataset.autoProcessJson,
  };
}

function buildScript(dataset: TacFlowDatasetSelection): string {
  return [
    "set -e",
    `source ${shellQuote(MAMBA_SH)}`,
    `mamba activate ${shellQuote(MAMBA_ENV)}`,
    "unset PYTHONPATH PYTHONHOME",
    commandLine([
      "python",
      "scripts/process_dataset.py",
      dataset.sourceDataset,
    ]),
  ].join("\n");
}

function tail(lines: string[]): string[] {
  return lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_TAIL_LINES);
}

function jsonLine(event: TacFlowScoreStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

async function readDoctorReport(
  dataset: TacFlowDatasetSelection,
): Promise<TacFlowDoctorReport> {
  let content: string;
  try {
    content = await readFile(dataset.doctorBeforeJson, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read doctor-before.json at ${dataset.doctorBeforeJson}: ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid doctor-before.json: ${message}`);
  }

  return parseTacFlowDoctorReport(parsed);
}

function streamScoreRun(
  request: NextRequest,
  lock: ActiveTacFlowRun,
  dataset: TacFlowDatasetSelection,
): Response {
  let child: ChildProcessWithoutNullStreams | null = null;
  const artifacts = scoreArtifacts(dataset);

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const startedAt = Date.now();
        const streams: CapturedStreams = { stdout: [], stderr: [] };
        let closed = false;
        let stdoutBuffer = "";
        let stderrBuffer = "";

        const send = (event: TacFlowScoreStreamEvent) => {
          if (closed) return;
          try {
            controller.enqueue(jsonLine(event));
          } catch {
            releaseTacFlowRun(lock);
            closed = true;
            child?.kill("SIGTERM");
          }
        };
        const close = () => {
          releaseTacFlowRun(lock);
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const flushLine = (stream: "stdout" | "stderr", line: string) => {
          const clean = line.trimEnd();
          if (!clean) return;
          streams[stream].push(clean);
          send({ type: "log", stream, line: clean });
        };
        const appendChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
          const current =
            (stream === "stdout" ? stdoutBuffer : stderrBuffer) +
            chunk.toString();
          const parts = current.split(/\r\n|\n|\r/u);
          const nextBuffer = parts.pop() ?? "";
          for (const line of parts) flushLine(stream, line);
          if (stream === "stdout") stdoutBuffer = nextBuffer;
          else stderrBuffer = nextBuffer;
        };

        send({
          type: "status",
          status: "running",
          percent: 10,
          message: "Running TacFlow score command",
        });

        try {
          child = spawn("bash", ["-lc", buildScript(dataset)], {
            cwd: TACFLOW_ENGINE_ROOT,
            env: process.env,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          send({
            type: "status",
            status: "failed",
            percent: 100,
            message,
          });
          send({ type: "error", error: message });
          close();
          return;
        }

        const abort = () => {
          child?.kill("SIGTERM");
        };
        request.signal.addEventListener("abort", abort, { once: true });

        child.stdout.on("data", (chunk: Buffer) =>
          appendChunk("stdout", chunk),
        );
        child.stderr.on("data", (chunk: Buffer) =>
          appendChunk("stderr", chunk),
        );
        child.on("error", (error) => {
          const message = `Failed to launch TacFlow score: ${error.message}`;
          send({
            type: "status",
            status: "failed",
            percent: 100,
            message,
          });
          send({ type: "error", error: message });
          request.signal.removeEventListener("abort", abort);
          close();
        });
        child.on("close", (code) => {
          flushLine("stdout", stdoutBuffer);
          flushLine("stderr", stderrBuffer);
          stdoutBuffer = "";
          stderrBuffer = "";

          const ok = code === 0;
          const durationMs = Date.now() - startedAt;
          send({
            type: "status",
            status: ok ? "command finished" : "failed",
            percent: ok ? 90 : 100,
            message: ok
              ? "Command finished; reading doctor report"
              : `Command exited with code ${code ?? "unknown"}`,
          });

          void readDoctorReport(dataset)
            .then(async (report) => {
              send({
                type: "result",
                ok: true,
                exitCode: code,
                durationMs,
                artifacts,
                report,
                ...(ok
                  ? {}
                  : { summary: { stderrTail: tail(streams.stderr) } }),
              });
              send({
                type: "status",
                status: "done",
                percent: 100,
                message: ok
                  ? "Done"
                  : `Doctor report loaded; command exited with code ${
                      code ?? "unknown"
                    } after report generation`,
              });
              await recordWorkbenchSharedEvent({
                org: dataset.relativePath.split("/")[0] || "TacVerse",
                source: "tacflow",
                kind: "score.run",
                outcome: ok ? "success" : "failed",
                details: {
                  datasetPath: dataset.relativePath,
                  exitCode: code,
                  durationMs,
                  artifacts,
                  report,
                  stdout: streams.stdout,
                  stderr: streams.stderr,
                },
              }).catch(() => undefined);
            })
            .catch(async (error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              send({
                type: "result",
                ok: false,
                exitCode: code,
                durationMs,
                artifacts,
                summary: { stderrTail: tail(streams.stderr) },
                error: message,
              });
              send({
                type: "status",
                status: "failed",
                percent: 100,
                message,
              });
              send({ type: "error", error: message });
              await recordWorkbenchSharedEvent({
                org: dataset.relativePath.split("/")[0] || "TacVerse",
                source: "tacflow",
                kind: "score.run",
                outcome: "failed",
                details: {
                  datasetPath: dataset.relativePath,
                  exitCode: code,
                  durationMs,
                  artifacts,
                  error: message,
                  stdout: streams.stdout,
                  stderr: streams.stderr,
                },
              }).catch(() => undefined);
            })
            .finally(() => {
              request.signal.removeEventListener("abort", abort);
              close();
            });
        });
      },
      cancel() {
        child?.kill("SIGTERM");
        releaseTacFlowRun(lock);
      },
    }),
    {
      headers: {
        "cache-control": "no-store, no-transform",
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function readScoreBody(
  request: NextRequest,
): Promise<{ ok: true; datasetPath: unknown } | { ok: false; error: string }> {
  let bodyText = "";
  try {
    bodyText = await request.text();
  } catch {
    return { ok: false, error: "Request body must be readable." };
  }
  if (!bodyText.trim()) {
    return { ok: true, datasetPath: undefined };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return { ok: false, error: "Request body must be JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  return {
    ok: true,
    datasetPath: (body as TacFlowScoreRequestBody).datasetPath,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "Cross-origin TacFlow score runs are not allowed." },
      { status: 403 },
    );
  }

  const body = await readScoreBody(request);
  if (!body.ok) {
    return Response.json({ error: body.error }, { status: 400 });
  }

  const dataset = await resolveTacFlowDataset(body.datasetPath);
  if (!dataset.ok) {
    return Response.json({ error: dataset.error }, { status: 400 });
  }

  const lock = tryAcquireTacFlowRun(
    `TacFlow score ${dataset.dataset.relativePath}`,
  );
  if (!lock.ok) {
    return Response.json(
      {
        error: `${lock.active.label} has been running since ${new Date(
          lock.active.startedAt,
        ).toISOString()}.`,
      },
      { status: 409 },
    );
  }

  return streamScoreRun(request, lock.run, dataset.dataset);
}

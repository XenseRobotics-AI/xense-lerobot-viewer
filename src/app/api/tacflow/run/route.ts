import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  type ActiveTacFlowRun,
  releaseTacFlowRun,
  tryAcquireTacFlowRun,
} from "@/lib/tacflow/lock";
import {
  TACFLOW_ENGINE_ROOT,
  TACFLOW_TACTILE_ROOT,
  resolveTacFlowDataset,
  type TacFlowDatasetSelection,
} from "@/lib/tacflow/datasets";
import {
  TACFLOW_STEP_IDS,
  type TacFlowArtifacts,
  type TacFlowStepId,
  type TacFlowStreamEvent,
  type TacFlowSummary,
} from "@/types/tacflow.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAMBA_SH = "/home/xense/miniforge3/etc/profile.d/mamba.sh";
const MAMBA_ENV = "TacFlow-main";
const MAX_SUMMARY_LINES = 12;
const MAX_TAIL_LINES = 20;

type StepDefinition = {
  step: TacFlowStepId;
  cwd: string;
  command: string[];
  artifacts: TacFlowArtifacts;
  summarize: (streams: CapturedStreams) => Promise<TacFlowSummary>;
};

type CapturedStreams = {
  stdout: string[];
  stderr: string[];
};

type TacFlowRequestBody = {
  step?: unknown;
  datasetPath?: unknown;
};

const STEP_IDS = new Set<string>(TACFLOW_STEP_IDS);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function commandLine(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function buildScript(command: string[]): string {
  return [
    "set -e",
    `source ${shellQuote(MAMBA_SH)}`,
    `mamba activate ${shellQuote(MAMBA_ENV)}`,
    "unset PYTHONPATH PYTHONHOME",
    `if ! python -c ${shellQuote("import scan_dataset")} >/dev/null 2>&1; then`,
    '  echo "[tacflow] installing tactile detector requirements"',
    `  (cd ${shellQuote(TACFLOW_TACTILE_ROOT)} && python -m pip install -r requirements.txt)`,
    "fi",
    commandLine(command),
  ].join("\n");
}

async function readSummaryLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(0, MAX_SUMMARY_LINES);
  } catch {
    return [];
  }
}

async function countCsvRows(filePath: string): Promise<number | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const rows = content
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    return Math.max(0, rows.length - 1);
  } catch {
    return null;
  }
}

function streamHighlights(lines: string[]): string[] {
  const interesting = /^(Source|Repaired dataset|Manifest|Applied):/u;
  return lines.filter((line) => interesting.test(line.trim()));
}

function tail(lines: string[]): string[] {
  return lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_TAIL_LINES);
}

async function scanSummary(outputDir: string): Promise<TacFlowSummary> {
  const [summaryLines, eventCount] = await Promise.all([
    readSummaryLines(path.join(outputDir, "SUMMARY.md")),
    countCsvRows(path.join(outputDir, "events.csv")),
  ]);
  return { eventCount, summaryLines };
}

async function repairSummary(
  streams: CapturedStreams,
): Promise<TacFlowSummary> {
  return {
    highlights: streamHighlights(streams.stdout),
  };
}

function buildStepDefinitions(
  dataset: TacFlowDatasetSelection,
): Record<TacFlowStepId, StepDefinition> {
  return {
    step_1: {
      step: "step_1",
      cwd: TACFLOW_TACTILE_ROOT,
      command: [
        "python",
        "-m",
        "scan_dataset",
        "--dataset",
        dataset.sourceDataset,
        "--output",
        dataset.sourceScanOutput,
        "--config",
        "config.example.json",
        "--resize",
        "350x200",
        "--workers",
        "8",
        "--opencv-threads",
        "2",
      ],
      artifacts: {
        report: dataset.sourceReport,
        summary: path.join(dataset.sourceScanDir, "SUMMARY.md"),
        events: path.join(dataset.sourceScanDir, "events.csv"),
        frames: path.join(dataset.sourceScanDir, "frames.csv"),
      },
      summarize: () => scanSummary(dataset.sourceScanDir),
    },
    step_2: {
      step: "step_2",
      cwd: TACFLOW_ENGINE_ROOT,
      command: [
        "python",
        "scripts/repair_tactile.py",
        dataset.sourceDataset,
        "--report",
        dataset.sourceReport,
        "--output",
        dataset.repairedDataset,
        "--overwrite",
      ],
      artifacts: {
        repairedDataset: dataset.repairedDataset,
        manifest: dataset.repairManifest,
      },
      summarize: repairSummary,
    },
    step_3: {
      step: "step_3",
      cwd: TACFLOW_TACTILE_ROOT,
      command: [
        "python",
        "-m",
        "scan_dataset",
        "--dataset",
        dataset.repairedDataset,
        "--output",
        dataset.recheckOutput,
        "--config",
        "config.example.json",
        "--resize",
        "350x200",
        "--workers",
        "8",
        "--opencv-threads",
        "2",
      ],
      artifacts: {
        report: path.join(dataset.recheckDir, "report.json"),
        summary: path.join(dataset.recheckDir, "SUMMARY.md"),
        events: path.join(dataset.recheckDir, "events.csv"),
        frames: path.join(dataset.recheckDir, "frames.csv"),
      },
      summarize: () => scanSummary(dataset.recheckDir),
    },
  };
}

function normalizeBody(
  value: unknown,
): { step: TacFlowStepId; datasetPath: unknown } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Request body must be a JSON object." };
  }
  const body = value as TacFlowRequestBody;
  const step = body.step;
  if (typeof step !== "string" || !STEP_IDS.has(step)) {
    return { error: "step must be one of: step_1, step_2, step_3." };
  }
  return { step: step as TacFlowStepId, datasetPath: body.datasetPath };
}

function jsonLine(event: TacFlowStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function streamStepRun(
  definition: StepDefinition,
  request: NextRequest,
  lock: ActiveTacFlowRun,
): Response {
  let child: ChildProcessWithoutNullStreams | null = null;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const startedAt = Date.now();
        const streams: CapturedStreams = { stdout: [], stderr: [] };
        let closed = false;
        let stdoutBuffer = "";
        let stderrBuffer = "";

        const send = (event: TacFlowStreamEvent) => {
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
          send({ type: "log", step: definition.step, stream, line: clean });
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
          step: definition.step,
          status: "running",
          percent: 10,
          message: "Running TacFlow command",
        });

        try {
          child = spawn("bash", ["-lc", buildScript(definition.command)], {
            cwd: definition.cwd,
            env: process.env,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          send({
            type: "status",
            step: definition.step,
            status: "failed",
            percent: 100,
            message,
          });
          send({ type: "error", step: definition.step, error: message });
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
          const message = `Failed to launch TacFlow: ${error.message}`;
          send({
            type: "status",
            step: definition.step,
            status: "failed",
            percent: 100,
            message,
          });
          send({ type: "error", step: definition.step, error: message });
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
            step: definition.step,
            status: ok ? "command finished" : "failed",
            percent: ok ? 90 : 100,
            message: ok
              ? "Command finished; reading artifacts"
              : `Command exited with code ${code ?? "unknown"}`,
          });

          void definition
            .summarize(streams)
            .then((summary) => {
              const resultSummary = ok
                ? summary
                : { ...summary, stderrTail: tail(streams.stderr) };
              send({
                type: "result",
                step: definition.step,
                ok,
                exitCode: code,
                durationMs,
                artifacts: definition.artifacts,
                summary: resultSummary,
                ...(ok
                  ? {}
                  : {
                      error:
                        tail(streams.stderr).at(-1) ??
                        `TacFlow command exited with code ${code ?? "unknown"}.`,
                    }),
              });
              if (ok) {
                send({
                  type: "status",
                  step: definition.step,
                  status: "done",
                  percent: 100,
                  message: "Done",
                });
              } else {
                send({
                  type: "error",
                  step: definition.step,
                  error:
                    tail(streams.stderr).at(-1) ??
                    `TacFlow command exited with code ${code ?? "unknown"}.`,
                });
              }
            })
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              send({
                type: "result",
                step: definition.step,
                ok: false,
                exitCode: code,
                durationMs,
                artifacts: definition.artifacts,
                summary: { stderrTail: tail(streams.stderr) },
                error: message,
              });
              send({ type: "error", step: definition.step, error: message });
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

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "Cross-origin TacFlow runs are not allowed." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const normalized = normalizeBody(body);
  if ("error" in normalized) {
    return Response.json({ error: normalized.error }, { status: 400 });
  }

  const dataset = await resolveTacFlowDataset(normalized.datasetPath);
  if (!dataset.ok) {
    return Response.json({ error: dataset.error }, { status: 400 });
  }

  const lock = tryAcquireTacFlowRun(
    `TacFlow ${normalized.step} ${dataset.dataset.relativePath}`,
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

  const definition = buildStepDefinitions(dataset.dataset)[normalized.step];
  return streamStepRun(definition, request, lock.run);
}

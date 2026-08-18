import { NextRequest } from "next/server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  PythonUnavailableError,
  pythonSpawnEnv,
  resolvePython,
  type ResolvedPython,
} from "@/lib/python-runtime";
import { resolveHfToken } from "@/lib/hf-token-store";
import { redactHfSecrets } from "@/lib/hf-identity";
import { isSameOriginRequest } from "@/lib/request-security";
import { normalizeHfSource } from "@/utils/hfValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual Hugging Face sync — the viewer's only outbound network path.
 *
 * Browsing stays entirely local; this runs when someone presses Sync and
 * nowhere else. Transfers go through hf-mirror (see `scripts/sync_hf_dataset.py`).
 *
 * Two shapes:
 *   POST { source }                  → fast listing, transfers nothing
 *   POST { source, confirm: true }   → NDJSON stream of the actual download
 *                                      (add `force: true` to re-fetch repos
 *                                      already at the remote commit)
 *
 * The listing step is not optional politeness. `lerobot` is a public HF org with
 * ~188 datasets against 5 held locally; syncing it unprompted would pull
 * hundreds of gigabytes. The caller has to see the count and come back.
 *
 * The listing also reports `pending` — the repos that genuinely differ from the
 * local copy — so both the confirmation and the progress counter are scoped to
 * real work instead of restarting at 1-of-everything on each run.
 */

/** Org names become a path segment under the dataset root, so anything that
 *  could climb out of it is rejected outright. */
const HF_MIRROR = "https://hf-mirror.com";
const LIST_TIMEOUT_MS = 120_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 4_000;

function redactSyncMessage(
  message: string,
  token: string | null = null,
): string {
  const redacted = redactHfSecrets(message, [
    token ?? "",
    process.env.HF_TOKEN ?? "",
  ]);
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

/** One sync at a time, process-wide: concurrent runs would write the same files. */
let activeSync: { source: string; startedAt: number } | null = null;

type SyncResult = {
  org: string;
  endpoint: string;
  repos: string[];
  /** Repos that differ from the local copy — the actual work list. */
  pending: string[];
  downloaded: number;
  /** Repos left alone because they already sit at the remote commit. */
  skipped: number;
  failed: { repo: string; error: string }[];
  listOnly: boolean;
};

type SyncRequestBody = {
  source?: unknown;
  confirm?: unknown;
  force?: unknown;
};

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "sync_hf_dataset.py");
}

function spawnScript(
  pythonBin: string,
  args: string[],
  token: string | null = null,
): ChildProcessWithoutNullStreams {
  const env = {
    ...pythonSpawnEnv(),
    // Belt and braces: the script also defaults this, but setting it here
    // means the mirror holds even if the script is run through a wrapper.
    HF_ENDPOINT: process.env.HF_ENDPOINT || HF_MIRROR,
  } as NodeJS.ProcessEnv;
  // Native SourcePanel sync accepts the same credential sources as the
  // original viewer (CLI cache / HF_TOKEN), plus an explicitly validated
  // viewer token when the optional account controls were used. Never put it in
  // argv or the progress stream.
  if (token) env.HF_TOKEN = token;
  return spawn(pythonBin, [scriptPath(), ...args], {
    cwd: process.cwd(),
    env,
  });
}

/**
 * The interpreter the sync script needs. Resolved rather than assumed: the
 * first `python3` on PATH is frequently not the one holding `huggingface_hub`,
 * and the failure mode is an opaque ModuleNotFoundError from the script.
 */
function syncPython(): Promise<ResolvedPython> {
  return resolvePython(["huggingface_hub"]);
}

/** Run the script to completion, returning its parsed `result` event. */
async function runToCompletion(
  args: string[],
  timeoutMs: number,
  token: string | null = null,
): Promise<{ result: SyncResult | null; error: string | null }> {
  let python: ResolvedPython;
  try {
    python = await syncPython();
  } catch (err) {
    return {
      result: null,
      error:
        err instanceof PythonUnavailableError
          ? err.message
          : redactSyncMessage(`Failed to launch Python: ${err}`, token),
    };
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnScript(python.bin, args, token);
    } catch (err) {
      resolve({
        result: null,
        error: redactSyncMessage(`Failed to launch Python: ${err}`, token),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload: {
      result: SyncResult | null;
      error: string | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ result: null, error: `Timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      finish({
        result: null,
        error: redactSyncMessage(
          `Failed to launch ${python.bin}: ${err.message}. Is Python installed?`,
          token,
        ),
      }),
    );
    child.on("close", () => {
      let result: SyncResult | null = null;
      let error: string | null = null;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "result") result = event.result as SyncResult;
          else if (event.type === "error") error = String(event.error);
        } catch {
          // A partial line is not fatal; the result event is what matters.
        }
      }
      finish({
        result,
        error: error
          ? redactSyncMessage(error, token)
          : result
            ? null
            : redactSyncMessage(
                stderr.trim().split(/\r?\n/).pop() || "Sync failed",
                token,
              ),
      });
    });
  });
}

/** Pipe the script's NDJSON straight through to the client as it arrives. */
function streamDownload(
  source: string,
  root: string,
  force: boolean,
  pythonBin: string,
  token: string | null = null,
): Response {
  const encoder = new TextEncoder();
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const secretValues = [token ?? "", process.env.HF_TOKEN ?? ""];
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            const serialized = JSON.stringify(obj);
            controller.enqueue(
              encoder.encode(`${redactHfSecrets(serialized, secretValues)}\n`),
            );
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          try {
            controller.close();
          } catch {
            /* already torn down */
          }
        };

        try {
          const args = ["--org", source, "--root", root];
          if (force) args.push("--force");
          activeChild = spawnScript(pythonBin, args, token);
        } catch (err) {
          send({
            type: "error",
            error: redactSyncMessage(`Failed to launch Python: ${err}`, token),
          });
          activeSync = null;
          close();
          return;
        }

        const child = activeChild;
        if (!child) {
          send({ type: "error", error: "Sync process was not created." });
          activeSync = null;
          close();
          return;
        }

        let sentError = false;
        const armIdleTimeout = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (closed) return;
            send({
              type: "error",
              error: `下载进程超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 60_000} 分钟没有进展，已终止。`,
            });
            sentError = true;
            if (!child.killed) child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              if (!child.killed) child.kill("SIGKILL");
            }, 5_000);
          }, DOWNLOAD_IDLE_TIMEOUT_MS);
        };
        armIdleTimeout();

        // The script reports its own failures as an error event and then exits
        // non-zero. Track that, or the generic exit-code message below would
        // land second and overwrite the diagnosis the user actually needs.
        // The script emits one JSON object per line; hold a buffer because a
        // chunk boundary can land mid-line.
        let buffer = "";
        const forward = (line: string) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event?.type === "error") sentError = true;
            if (typeof event.error === "string") {
              event.error = redactSyncMessage(event.error, token);
            }
            send(event);
          } catch {
            /* ignore an unparseable line rather than killing the stream */
          }
        };
        child.stdout.on("data", (chunk) => {
          armIdleTimeout();
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) forward(line);
        });

        let stderr = "";
        child.stderr.on("data", (d) => {
          armIdleTimeout();
          stderr += d.toString();
        });

        child.on("error", (err) => {
          send({
            type: "error",
            error: redactSyncMessage(`Python failed: ${err.message}`, token),
          });
          activeSync = null;
          close();
        });

        child.on("close", (code) => {
          forward(buffer);
          // Only synthesise an error when the script died without explaining
          // itself — a crash or a kill. Otherwise its own message stands.
          if (code !== 0 && !sentError) {
            send({
              type: "error",
              error: redactSyncMessage(
                stderr.trim().split(/\r?\n/).pop() ||
                  `Sync exited with code ${code} and no output.`,
                token,
              ),
            });
          }
          activeChild = null;
          activeSync = null;
          close();
        });
      },
      cancel() {
        // A disconnected browser no longer has a way to show progress. Stop
        // the child instead of leaving an unbounded process holding the global
        // sync lock; snapshot_download can resume the partial files later.
        if (activeChild && !activeChild.killed) {
          activeChild.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (activeChild && !activeChild.killed) activeChild.kill("SIGKILL");
          }, 5_000);
        }
      },
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
      },
    },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      {
        error: "Cross-origin sync requests are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      { status: 403 },
    );
  }

  let body: SyncRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const source = normalizeHfSource(body.source);
  if (!source) {
    return Response.json(
      { error: "`source` must be a plain Hugging Face org name." },
      { status: 400 },
    );
  }

  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }

  if (activeSync) {
    return Response.json(
      { error: `A sync of ${activeSync.source} is already running.` },
      { status: 409 },
    );
  }

  let token: string | null = null;
  try {
    token = (await resolveHfToken(root)).token;
  } catch {
    // Credential lookup is best-effort; public datasets can still sync
    // anonymously and huggingface_hub can use its normal CLI cache.
  }

  // Listing pass — cheap, transfers nothing, and always runs first.
  if (body.confirm !== true) {
    const { result, error } = await runToCompletion(
      ["--org", source, "--root", root, "--list-only"],
      LIST_TIMEOUT_MS,
      token,
    );
    if (!result) {
      return Response.json(
        { error: redactSyncMessage(error ?? "Listing failed", token) },
        { status: 502 },
      );
    }
    return Response.json({
      source,
      endpoint: result.endpoint,
      repos: result.repos,
      count: result.repos.length,
      // `pending` may be absent if an older script is on disk; falling back to
      // "everything is work" keeps the old behaviour rather than claiming a
      // fully up-to-date corpus that was never checked.
      pending: result.pending ?? result.repos,
      confirmRequired: true,
    });
  }

  // Resolve before opening the stream: an interpreter problem is a plain 502
  // with a fixable message, not an error buried mid-transfer.
  let python: ResolvedPython;
  try {
    python = await syncPython();
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof PythonUnavailableError ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  activeSync = { source, startedAt: Date.now() };
  return streamDownload(source, root, body.force === true, python.bin, token);
}

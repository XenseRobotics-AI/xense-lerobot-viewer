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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual Hugging Face sync — the viewer's only outbound network path.
 *
 * Browsing stays entirely local; this runs when someone presses Sync and
 * nowhere else. Transfers go through hf-mirror (see `scripts/sync_hf_dataset.py`).
 *
 * Two targets, each in two steps:
 *   POST { source }                → list a whole org, transfer nothing
 *   POST { repo: "owner/name" }    → check one dataset, transfer nothing
 *   POST { …, confirm: true }      → NDJSON stream of the actual download
 *                                    (add `force: true` to re-fetch a repo
 *                                    already at the remote commit)
 *
 * The listing step is not optional politeness. `lerobot` is a public HF org with
 * ~188 datasets against 5 held locally; syncing it unprompted would pull
 * hundreds of gigabytes. The caller has to see the count and come back.
 *
 * The listing also reports `pending` — the repos that genuinely differ from the
 * local copy — so both the confirmation and the progress counter are scoped to
 * real work instead of restarting at 1-of-everything on each run.
 *
 * The single-repo target exists because the org form can only ever re-fetch
 * sources already on disk: to pull a dataset the machine has never held, there
 * is nothing to press Sync on. It also carries `details` — the repo's size and
 * file count — so its confirmation says what the transfer costs rather than
 * "1 dataset pending".
 */

/** Org names become a path segment under the dataset root, so anything that
 *  could climb out of it is rejected outright. */
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A full `owner/name` repo id. Both halves face the filesystem — the owner
 *  becomes a directory and `repo_target` uses the name as the leaf — so each is
 *  held to `SOURCE_PATTERN`, which a leading dot (and therefore `..`) fails. */
const REPO_PATTERN = new RegExp(
  `^${SOURCE_PATTERN.source.slice(1, -1)}/${SOURCE_PATTERN.source.slice(1, -1)}$`,
);

const HF_MIRROR = "https://hf-mirror.com";
const LIST_TIMEOUT_MS = 120_000;

/**
 * Sync is switched off (2026-09-01, by decision).
 *
 * The local corpus was reorganised from sibling directories (`TacVerse`,
 * `TacVerse-RAW`, `TacVerse-Failed`) into `TacVerse/{merged,raw,failed,
 * released,in-processing}/…`. That breaks the contract this path is built on:
 * `scripts/sync_hf_dataset.py:repo_target()` writes to `<root>/<org>/<name>`,
 * and `TacVerse` is *both* the Hugging Face org slug and the new container
 * directory. A sync would therefore recreate `TacVerse/<name>` beside
 * `TacVerse/merged/<name>` and re-fetch roughly 500 GB — silently, as a
 * duplication rather than an error.
 *
 * The machinery below is deliberately left intact. Re-enabling means fixing
 * `repo_target()` to target the right sub-directory — and `sync_fast.py` in
 * the engine's work tree, which documents itself as sharing that contract —
 * not just deleting this flag.
 */
// Annotated `boolean` rather than inferred: a literal `true` narrows the type
// and makes everything past the guard unreachable code to the compiler, which
// is exactly the machinery we are deliberately keeping compilable.
const SYNC_DISABLED: boolean = true;
const SYNC_DISABLED_REASON =
  "Hugging Face sync is disabled. The local corpus moved to " +
  "TacVerse/{merged,raw,failed,released,in-processing}/…, and the " +
  "<root>/<org>/<name> layout this sync writes to would recreate the old " +
  "paths and re-download the corpus. Re-enable only together with a fix to " +
  "sync_hf_dataset.py:repo_target().";

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
  /** Per-repo size/file count — only on the single-repo path. */
  details?: SyncRepoDetail[];
};

type SyncRepoDetail = {
  id: string;
  sha: string | null;
  sizeBytes: number | null;
  files: number | null;
  error: string | null;
};

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "sync_hf_dataset.py");
}

function spawnScript(
  pythonBin: string,
  args: string[],
): ChildProcessWithoutNullStreams {
  return spawn(pythonBin, [scriptPath(), ...args], {
    cwd: process.cwd(),
    env: {
      ...pythonSpawnEnv(),
      // Belt and braces: the script also defaults this, but setting it here
      // means the mirror holds even if the script is run through a wrapper.
      HF_ENDPOINT: process.env.HF_ENDPOINT || HF_MIRROR,
    },
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
          : `Failed to launch Python: ${err}`,
    };
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnScript(python.bin, args);
    } catch (err) {
      resolve({ result: null, error: `Failed to launch Python: ${err}` });
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
        error: `Failed to launch ${python.bin}: ${err.message}. Is Python installed?`,
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
        error:
          error ??
          (result ? null : stderr.trim().split(/\r?\n/).pop() || "Sync failed"),
      });
    });
  });
}

/** Pipe the script's NDJSON straight through to the client as it arrives. */
function streamDownload(args: string[], pythonBin: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already torn down */
          }
        };

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnScript(pythonBin, args);
        } catch (err) {
          send({ type: "error", error: `Failed to launch Python: ${err}` });
          activeSync = null;
          close();
          return;
        }

        // The script reports its own failures as an error event and then exits
        // non-zero. Track that, or the generic exit-code message below would
        // land second and overwrite the diagnosis the user actually needs.
        let sentError = false;

        // The script emits one JSON object per line; hold a buffer because a
        // chunk boundary can land mid-line.
        let buffer = "";
        const forward = (line: string) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line);
            if (event?.type === "error") sentError = true;
            send(event);
          } catch {
            /* ignore an unparseable line rather than killing the stream */
          }
        };
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) forward(line);
        });

        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));

        child.on("error", (err) => {
          send({ type: "error", error: `Python failed: ${err.message}` });
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
              error:
                stderr.trim().split(/\r?\n/).pop() ||
                `Sync exited with code ${code} and no output.`,
            });
          }
          activeSync = null;
          close();
        });
      },
      cancel() {
        // Client navigated away; the child keeps running to completion so a
        // half-written dataset directory isn't left behind.
        activeSync = null;
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

/**
 * The requested target as script arguments.
 *
 * `label` is what the single-run lock and its 409 report, so a blocked caller
 * is told which dataset is holding it rather than just which org.
 */
function resolveTarget(body: {
  source?: unknown;
  repo?: unknown;
}): { label: string; args: string[] } | { error: string } {
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      return {
        error: "`repo` must be a Hugging Face id of the form owner/name.",
      };
    }
    // --org is derived from the id by the script; passing it too would only
    // create a second place for the two to disagree.
    return { label: repo, args: ["--repo", repo] };
  }

  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source || !SOURCE_PATTERN.test(source)) {
    return { error: "`source` must be a plain Hugging Face org name." };
  }
  return { label: source, args: ["--org", source] };
}

export async function POST(request: NextRequest): Promise<Response> {
  // Refuse before parsing anything: the listing pass transfers no data, but a
  // caller who gets a listing back reasonably expects the confirm step to work.
  if (SYNC_DISABLED) {
    return Response.json({ error: SYNC_DISABLED_REASON }, { status: 503 });
  }

  let body: {
    source?: unknown;
    repo?: unknown;
    confirm?: unknown;
    force?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const target = resolveTarget(body);
  if ("error" in target) {
    return Response.json({ error: target.error }, { status: 400 });
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

  const baseArgs = [...target.args, "--root", root];

  // Listing pass — cheap, transfers nothing, and always runs first.
  if (body.confirm !== true) {
    const { result, error } = await runToCompletion(
      [...baseArgs, "--list-only"],
      LIST_TIMEOUT_MS,
    );
    if (!result) {
      return Response.json(
        { error: error ?? "Listing failed" },
        { status: 502 },
      );
    }
    return Response.json({
      source: result.org,
      endpoint: result.endpoint,
      repos: result.repos,
      count: result.repos.length,
      // `pending` may be absent if an older script is on disk; falling back to
      // "everything is work" keeps the old behaviour rather than claiming a
      // fully up-to-date corpus that was never checked.
      pending: result.pending ?? result.repos,
      details: result.details ?? null,
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

  activeSync = { source: target.label, startedAt: Date.now() };
  return streamDownload(
    body.force === true ? [...baseArgs, "--force"] : baseArgs,
    python.bin,
  );
}

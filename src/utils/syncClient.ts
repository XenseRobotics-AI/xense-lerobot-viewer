/**
 * Client for the manual Hugging Face sync route.
 *
 * Always two steps: `listSyncCandidates` shows what would be pulled, then
 * `runSync` streams the transfer. The listing step is deliberate — some orgs
 * hold far more on the Hub than locally, and nobody should trigger a
 * hundred-gigabyte download from a single click.
 *
 * Both steps take a `SyncTarget`: a whole org (`{ source }`) or one dataset
 * (`{ repo: "owner/name" }`). They are the same request otherwise, so they stay
 * one code path rather than two that drift.
 */

import { tStandalone } from "@/i18n/standalone";

const SYNC_URL = "/api/local-datasets/sync";

/** A whole Hugging Face org, or a single `owner/name` dataset. */
export type SyncTarget = { source: string } | { repo: string };

/** Size and file count for one repo — only the `{ repo }` target reports it. */
export type SyncRepoDetail = {
  id: string;
  sha: string | null;
  /** Null when the Hub reported no file sizes — unknown, not empty. */
  sizeBytes: number | null;
  files: number | null;
  error: string | null;
};

export type SyncListing = {
  source: string;
  endpoint: string;
  repos: string[];
  count: number;
  /**
   * The repos that actually differ from the local copy — missing, at an older
   * commit, or with files that no longer match the commit's tree. This, not
   * `repos`, is what a plain sync transfers.
   */
  pending: string[];
  /** Present only for a `{ repo }` target; null for an org listing. */
  details: SyncRepoDetail[] | null;
  confirmRequired: true;
};

export type SyncProgress = {
  phase?: "listing" | "preflight" | "downloading" | "failed" | "complete";
  repo?: string;
  /** 1-based position of the repo being transferred. */
  index?: number;
  total?: number;
  /** Overall percent, blending finished repos with progress inside the current
   *  one — repo-level counting alone barely moves on a large org. */
  percent?: number;
  /** Progress within the current repo. */
  repoPercent?: number;
  filesDone?: number;
  filesTotal?: number;
  bytes?: number;
  endpoint?: string;
  org?: string;
};

export type SyncResult = {
  org: string;
  endpoint: string;
  repos: string[];
  pending: string[];
  downloaded: number;
  /** Repos left alone because they already sit at the remote commit. */
  skipped: number;
  failed: { repo: string; error: string }[];
  listOnly: boolean;
  details?: SyncRepoDetail[];
};

/** What the sync would pull, without pulling it. */
export async function listSyncCandidates(
  target: SyncTarget,
  signal?: AbortSignal,
): Promise<SyncListing> {
  const response = await fetch(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Listing failed (${response.status})`);
  }
  return payload as SyncListing;
}

/**
 * Run the download, invoking `onProgress` for each event as it arrives.
 * Resolves with the final result; rejects on a stream-level error.
 *
 * By default only repos that differ are transferred. `force` re-fetches the
 * whole target regardless — the escape hatch for a local copy the commit check
 * cannot see through.
 */
export async function runSync(
  target: SyncTarget,
  onProgress: (progress: SyncProgress) => void,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<SyncResult> {
  const { signal, force = false } = options;
  const response = await fetch(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...target, confirm: true, force }),
    signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Sync failed (${response.status})`);
  }
  if (!response.body) throw new Error(tStandalone("err.syncNoStream"));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: SyncResult | null = null;
  let streamError: string | null = null;

  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: {
      type?: string;
      progress?: SyncProgress;
      result?: SyncResult;
      error?: string;
    };
    try {
      event = JSON.parse(line);
    } catch {
      return; // a malformed line shouldn't abort a running transfer
    }
    if (event.type === "progress" && event.progress) onProgress(event.progress);
    else if (event.type === "result" && event.result) result = event.result;
    // Keep the FIRST error: it is the one that explains what went wrong, and
    // anything after it is fallout worded more generically.
    else if (event.type === "error" && streamError === null) {
      streamError = event.error ?? "Sync failed";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  }
  handle(buffer);

  if (streamError) throw new Error(streamError);
  if (!result) throw new Error(tStandalone("err.syncNoResult"));
  return result;
}

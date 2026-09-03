"use client";

import React, { useCallback, useRef, useState } from "react";
import {
  SYNC_DISABLED,
  SYNC_DISABLED_REASON,
  listSyncCandidates,
  runSync,
  type SyncProgress,
  type SyncRepoDetail,
} from "@/utils/syncClient";
import { SyncOutcome, SyncProgressView } from "@/components/sync-progress";
import { formatBytes } from "@/utils/byteSize";
import { useLocale } from "@/context/locale-context";

/**
 * Pull one dataset from the Hub by its `owner/name` id.
 *
 * The per-source Sync button can only ever refresh a source already on disk —
 * a source with nothing local has no tab to press. This is the entry point for
 * a dataset the machine has never held, and it lives on the homepage rather
 * than inside the dashboard tabs for exactly that reason: it has to be reachable
 * when the corpus is empty.
 *
 * Same two-step contract as the org sync — check first, transfer only on a
 * second, explicit click — but the check here can report what the transfer
 * costs, so the confirmation names a size instead of a repo count.
 */

/** Mirrors the pattern the route enforces; here only to keep the button
 *  disabled until the id could possibly resolve. The server still validates. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

type FetchState =
  | { kind: "idle" }
  | { kind: "checking"; repo: string }
  | {
      kind: "confirm";
      repo: string;
      pending: boolean;
      endpoint: string;
      detail: SyncRepoDetail | null;
    }
  | { kind: "running"; progress: SyncProgress }
  | { kind: "done"; downloaded: number; skipped: number; failed: number }
  | { kind: "error"; message: string };

export default function RepoFetchPanel({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const { t, tRich } = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [input, setInput] = useState("");
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const repo = input.trim();
  const valid = REPO_PATTERN.test(repo);
  const busy = state.kind === "checking" || state.kind === "running";

  const check = useCallback(async () => {
    if (!valid) return;
    setState({ kind: "checking", repo });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const listing = await listSyncCandidates({ repo }, controller.signal);
      setState({
        kind: "confirm",
        repo,
        pending: listing.pending.length > 0,
        endpoint: listing.endpoint,
        detail: listing.details?.[0] ?? null,
      });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }, [repo, valid]);

  const download = useCallback(
    async (force: boolean) => {
      setState({ kind: "running", progress: { phase: "listing" } });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await runSync(
          { repo },
          (progress) => setState({ kind: "running", progress }),
          { signal: controller.signal, force },
        );
        setState({
          kind: "done",
          downloaded: result.downloaded,
          skipped: result.skipped,
          failed: result.failed.length,
        });
      } catch (err) {
        setState({ kind: "error", message: (err as Error).message });
      }
    },
    [repo],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  }, []);

  return (
    <section
      aria-label={t("repofetch.title")}
      className="mb-8 rounded-lg border border-white/5 bg-[var(--surface-0)]/60"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-5 py-3 text-left text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] sm:px-6"
      >
        <span
          aria-hidden
          className={`text-[var(--text-faint)] transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        {t("repofetch.title")}
      </button>

      {open && (
        <div className="space-y-3 border-t border-white/5 px-5 py-4 sm:px-6">
          {(state.kind === "idle" || state.kind === "error") && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") check();
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t("repofetch.inputAria")}
                  placeholder={t("repofetch.placeholder")}
                  className="min-w-0 flex-1 rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                />
                <button
                  type="button"
                  onClick={check}
                  // Sync is off while the corpus layout is being reorganised
                  // (see SYNC_DISABLED in `@/utils/syncClient`). The route
                  // enforces it with a 503; this stops the button from
                  // promising something it cannot deliver.
                  disabled={!valid || SYNC_DISABLED}
                  title={SYNC_DISABLED ? SYNC_DISABLED_REASON : undefined}
                  className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                >
                  {t("repofetch.check")}
                </button>
              </div>
              <p className="text-[11px] text-[var(--text-faint)]">
                {repo && !valid ? t("repofetch.invalid") : t("repofetch.hint")}
              </p>
              {state.kind === "error" && (
                <p className="text-xs text-red-300">{state.message}</p>
              )}
            </>
          )}

          {state.kind === "checking" && (
            <p className="text-xs text-[var(--text-muted)]">
              {t("repofetch.checking", { repo: state.repo })}
            </p>
          )}

          {state.kind === "confirm" && (
            <ConfirmBlock
              state={state}
              onDownload={download}
              onCancel={reset}
            />
          )}

          {state.kind === "running" && (
            <SyncProgressView progress={state.progress} />
          )}

          {state.kind === "done" && (
            <div className="space-y-3">
              <SyncOutcome
                downloaded={state.downloaded}
                skipped={state.skipped}
                failed={state.failed}
              />
              <button
                type="button"
                onClick={() => {
                  setInput("");
                  setState({ kind: "idle" });
                }}
                className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
              >
                {t("repofetch.another")}
              </button>
            </div>
          )}

          {busy && state.kind === "checking" && (
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            >
              {t("common.cancel")}
            </button>
          )}

          {/* Where it lands, shown from the moment the id is well-formed: the
              owner becomes a source directory, which is how a brand-new source
              tab appears after the transfer. */}
          {valid && state.kind !== "done" && (
            <p className="text-[11px] text-[var(--text-faint)]">
              {tRich("repofetch.target", {
                path: <span className="font-mono">{repoTargetPath(repo)}</span>,
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** `owner/name` → the `<owner>/<name>` directory the sync writes. */
function repoTargetPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${owner}/${name}`;
}

function ConfirmBlock({
  state,
  onDownload,
  onCancel,
}: {
  state: Extract<FetchState, { kind: "confirm" }>;
  onDownload: (force: boolean) => void;
  onCancel: () => void;
}) {
  const { t, tRich } = useLocale();
  const size = state.detail?.sizeBytes ?? null;
  const files = state.detail?.files ?? null;

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-[var(--text-primary)]">
        {state.pending
          ? tRich("repofetch.pendingLine", {
              repo: <span className="font-mono">{state.repo}</span>,
            })
          : tRich("repofetch.alreadyLocal", {
              repo: <span className="font-mono">{state.repo}</span>,
            })}
      </p>
      <p className="text-[11px] text-[var(--text-faint)]">
        {size !== null
          ? t("repofetch.size", {
              size: formatBytes(size),
              files: files ?? 0,
            })
          : t("repofetch.sizeUnknown")}{" "}
        {tRich("source.via", {
          endpoint: <span className="font-mono">{state.endpoint}</span>,
        })}
      </p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        {state.pending ? (
          <button
            type="button"
            onClick={() => onDownload(false)}
            className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            {size !== null
              ? t("repofetch.downloadSized", { size: formatBytes(size) })
              : t("repofetch.download")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDownload(true)}
            title={t("repofetch.redownloadTitle")}
            className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            {t("repofetch.redownload")}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

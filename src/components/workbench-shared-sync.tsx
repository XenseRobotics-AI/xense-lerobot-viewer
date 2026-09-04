"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FiCloud, FiExternalLink, FiRefreshCw } from "react-icons/fi";

type SharedSyncStatus = {
  repoId: string;
  repoUrl: string;
  public: boolean;
  organization: string;
  tokenPresent: boolean;
  pendingEvents: number;
  lastSyncAt: string | null;
  lastCommitUrl: string | null;
  readOnly?: boolean;
  message?: string;
  error?: string;
};

type WorkbenchSharedSyncProps = {
  organization: string;
  compact?: boolean;
  onSynced?: () => void;
};

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function formatSyncTime(value: string | null | undefined): string {
  if (!value) return "Not synchronized yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? "Last sync " + date.toLocaleString()
    : "Last sync unavailable";
}

async function readPayload(response: Response): Promise<SharedSyncStatus> {
  const payload = (await response
    .json()
    .catch(() => ({}))) as Partial<SharedSyncStatus>;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Unable to synchronize shared Workbench state.",
    );
  }
  return payload as SharedSyncStatus;
}

export default function WorkbenchSharedSync({
  organization,
  compact = false,
  onSynced,
}: WorkbenchSharedSyncProps) {
  const [status, setStatus] = useState<SharedSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  const sync = useCallback(
    async (signal?: AbortSignal) => {
      if (!organization.trim()) return;
      setSyncing(true);
      setError(null);
      try {
        const response = await fetch("/api/workbench/shared-sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ org: organization }),
          cache: "no-store",
          signal,
        });
        const payload = await readPayload(response);
        setStatus(payload);
        onSyncedRef.current?.();
      } catch (caught: unknown) {
        if ((caught as { name?: string })?.name !== "AbortError") {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!signal?.aborted) setSyncing(false);
      }
    },
    [organization],
  );

  useEffect(() => {
    const controller = new AbortController();
    void sync(controller.signal);
    const timer = window.setInterval(() => {
      void sync();
    }, AUTO_SYNC_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [sync]);

  return (
    <section
      aria-label="Public Workbench synchronization"
      className={
        compact
          ? "rounded-lg border border-cyan-400/15 bg-cyan-400/[0.04] px-3 py-2"
          : "rounded-xl border border-cyan-400/20 bg-gradient-to-r from-cyan-400/[0.07] to-emerald-400/[0.04] p-4"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <FiCloud
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold text-slate-200">
                Shared Workbench state
              </h3>
              <span className="rounded-full border border-amber-300/25 bg-amber-300/[0.08] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200">
                Public dataset
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              Workstation mappings, personnel mapping (including email), reward
              rules, and Workbench/TacFlow run logs.
            </p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
              <span>{formatSyncTime(status?.lastSyncAt)}</span>
              <span>{status?.pendingEvents ?? 0} pending log(s)</span>
              <span>
                {status?.tokenPresent
                  ? "HF write token available"
                  : "Public read-only mode"}
              </span>
            </div>
            {(status?.message || error) && (
              <p
                className={
                  "mt-1 text-[10px] " +
                  (error ? "text-red-300" : "text-emerald-300")
                }
                role="status"
              >
                {error ?? status?.message}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={
              status?.repoUrl ??
              "https://huggingface.co/datasets/XR-Bot0/xense-lerobot-viewer-workbenck-log"
            }
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 px-2.5 text-[10px] font-medium text-slate-300 transition-colors hover:border-cyan-300/30 hover:text-cyan-200"
          >
            Dataset
            <FiExternalLink aria-hidden="true" className="h-3 w-3" />
          </a>
          <button
            type="button"
            onClick={() => void sync()}
            disabled={syncing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-cyan-300/25 bg-cyan-300/[0.08] px-2.5 text-[10px] font-semibold text-cyan-100 transition-colors hover:bg-cyan-300/[0.14] disabled:cursor-wait disabled:opacity-60"
          >
            <FiRefreshCw
              aria-hidden="true"
              className={"h-3 w-3 " + (syncing ? "animate-spin" : "")}
            />
            {syncing ? "Syncing" : "Sync now"}
          </button>
        </div>
      </div>
    </section>
  );
}

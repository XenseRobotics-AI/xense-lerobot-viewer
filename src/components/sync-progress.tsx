"use client";

import React from "react";
import type { SyncProgress } from "@/utils/syncClient";
import { useLocale } from "@/context/locale-context";

/**
 * The live-transfer and outcome views of a Hugging Face sync.
 *
 * Shared because the two entry points — a whole source (`source-panel.tsx`) and
 * a single dataset by repo id (`repo-fetch-panel.tsx`) — differ only in what
 * they ask for. Once bytes are moving the report is the same report, and two
 * copies of it would drift.
 */

/**
 * Transferred volume, at the precision the magnitude deserves.
 *
 * Deliberately decimal (1000) and separate from `formatBytes`: this number is
 * read against what the Hub reports for the repo mid-download, whereas the
 * storage figures are read against the filesystem.
 */
export function formatTransferred(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} kB`;
}

/** Phase line, overall bar, and — while a repo is moving — its own bar. */
export function SyncProgressView({ progress }: { progress: SyncProgress }) {
  const { t } = useLocale();
  const p = progress;
  const percent = Math.max(0, Math.min(100, p.percent ?? 0));
  const repoPercent = Math.max(0, Math.min(100, p.repoPercent ?? 0));
  // Files and bytes are what tell you a large repo is moving; the overall
  // percent barely shifts while one multi-gigabyte dataset transfers.
  const detail = [
    p.filesTotal
      ? t("source.filesDetail", {
          done: p.filesDone ?? 0,
          total: p.filesTotal,
        })
      : null,
    p.bytes ? formatTransferred(p.bytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-[var(--text-primary)]">
          {p.phase === "listing" && t("source.phaseListing")}
          {p.phase === "preflight" && t("source.phasePreflight")}
          {p.phase === "downloading" &&
            t("source.phaseDownloading", { repo: p.repo ?? "" })}
          {p.phase === "failed" &&
            t("source.phaseFailed", { repo: p.repo ?? "" })}
          {p.phase === "complete" && t("source.phaseComplete")}
        </span>
        <span className="tabular shrink-0 text-[var(--text-muted)]">
          {p.index && p.total ? `${p.index}/${p.total} · ` : ""}
          {percent}%
        </span>
      </div>

      {/* Overall across the target. */}
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("source.progressAria")}
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/5"
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Current repo, so a single large dataset still shows movement. */}
      {p.phase === "downloading" && (
        <>
          <div
            role="progressbar"
            aria-valuenow={repoPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("source.repoProgressAria")}
            className="h-1 w-full overflow-hidden rounded-full bg-white/5"
          >
            <div
              className="h-full rounded-full bg-[var(--accent)]/40 transition-[width] duration-300"
              style={{ width: `${repoPercent}%` }}
            />
          </div>
          {detail && (
            <p className="tabular text-[11px] text-[var(--text-muted)]">
              {detail}
            </p>
          )}
        </>
      )}

      <p className="text-[11px] text-[var(--text-faint)]">
        {t("source.leavingNote")}
      </p>
    </div>
  );
}

/** What the finished run actually did. */
export function SyncOutcome({
  downloaded,
  skipped,
  failed,
}: {
  downloaded: number;
  skipped: number;
  failed: number;
}) {
  const { t, tRich, tpRich } = useLocale();

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-emerald-300">
        {downloaded === 0 && failed === 0 ? (
          <>{t("source.upToDate")}</>
        ) : (
          <>
            {tpRich("source.downloaded", downloaded, {
              count: <span className="tabular">{downloaded}</span>,
            })}
            {skipped > 0 && (
              <span className="text-[var(--text-muted)]">
                {" "}
                {tRich("source.alreadyCurrent", {
                  count: <span className="tabular">{skipped}</span>,
                })}
              </span>
            )}
            {failed > 0 && (
              <span className="text-amber-300">
                {" "}
                {tRich("source.failedCount", {
                  count: <span className="tabular">{failed}</span>,
                })}
              </span>
            )}
          </>
        )}
      </p>
      <p className="text-[11px] text-[var(--text-faint)]">
        {t("source.reloadNote")}
      </p>
    </div>
  );
}

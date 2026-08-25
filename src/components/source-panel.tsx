"use client";

import React, { useCallback, useRef, useState } from "react";
import type { CorpusSegment } from "@/utils/corpusStats";
import {
  formatCompact,
  formatEpisodeLength,
  formatHours,
  tapeColor,
} from "@/utils/corpusStats";
import { formatBytes } from "@/utils/byteSize";
import {
  formatDelta,
  formatDeltaBytes,
  isFlatDelta,
  type SourceDelta,
} from "@/utils/corpusHistory";
import {
  listSyncCandidates,
  runSync,
  type SyncProgress,
} from "@/utils/syncClient";
import { SyncOutcome, SyncProgressView } from "@/components/sync-progress";
import { useLocale, useT } from "@/context/locale-context";

type SourcePanelProps = {
  segment: CorpusSegment;
  colorIndex: number;
  counts: { ok: number; empty: number; incomplete: number };
  delta: SourceDelta | null;
  since: string | null;
  spanDays: number | null;
  onOpen: (prefix: string) => void;
};

type SyncState =
  | { kind: "idle" }
  | { kind: "listing" }
  | { kind: "confirm"; repos: string[]; pending: string[]; endpoint: string }
  | { kind: "running"; progress: SyncProgress }
  | { kind: "done"; downloaded: number; skipped: number; failed: number }
  | { kind: "error"; message: string };

/** Growth since the last recorded day, or an explanation of why there is none. */
function TodayStrip({
  delta,
  since,
  spanDays,
}: {
  delta: SourceDelta | null;
  since: string | null;
  spanDays: number | null;
}) {
  const t = useT();

  if (!delta || since === null) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        {t("source.noSnapshot")}
      </p>
    );
  }
  if (isFlatDelta(delta)) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        {spanDays !== null && spanDays > 1
          ? t("source.unchangedSpan", { since, days: spanDays })
          : t("source.unchanged", { since })}
      </p>
    );
  }

  const items = [
    {
      key: "hours",
      label: t("common.hours"),
      value: formatDelta(delta.hours, " h", 1),
    },
    {
      key: "episodes",
      label: t("common.episodes"),
      value: formatDelta(delta.episodes),
    },
    {
      key: "tasks",
      label: t("common.tasks"),
      value: formatDelta(delta.tasks),
    },
    // Dropped rather than shown as "n/a" when the baseline predates storage
    // tracking: one dead column on every source, for one day, teaches nothing.
    ...(delta.bytes === null
      ? []
      : [
          {
            key: "storage",
            label: t("common.storage"),
            value: formatDeltaBytes(delta.bytes),
          },
        ]),
  ];
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-7 gap-y-2">
        {items.map((item) => (
          <div key={item.key}>
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
              {item.label}
            </p>
            <p className="tabular mt-0.5 text-lg font-semibold text-emerald-300">
              {item.value}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-faint)]">
        {spanDays !== null && spanDays > 1
          ? t("source.sinceDays", { since, days: spanDays })
          : t("source.since", { since })}
      </p>
    </div>
  );
}

export default function SourcePanel({
  segment,
  colorIndex,
  counts,
  delta,
  since,
  spanDays,
  onOpen,
}: SourcePanelProps) {
  const t = useT();
  const [sync, setSync] = useState<SyncState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const startListing = useCallback(async () => {
    setSync({ kind: "listing" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const listing = await listSyncCandidates(
        { source: segment.prefix },
        controller.signal,
      );
      if (listing.count === 0) {
        setSync({ kind: "error", message: t("source.noneFound") });
        return;
      }
      setSync({
        kind: "confirm",
        repos: listing.repos,
        pending: listing.pending,
        endpoint: listing.endpoint,
      });
    } catch (err) {
      setSync({ kind: "error", message: (err as Error).message });
    }
  }, [segment.prefix, t]);

  const startDownload = useCallback(
    async (force = false) => {
      setSync({ kind: "running", progress: { phase: "listing" } });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await runSync(
          { source: segment.prefix },
          (progress) => setSync({ kind: "running", progress }),
          { signal: controller.signal, force },
        );
        setSync({
          kind: "done",
          downloaded: result.downloaded,
          skipped: result.skipped,
          failed: result.failed.length,
        });
      } catch (err) {
        setSync({ kind: "error", message: (err as Error).message });
      }
    },
    [segment.prefix],
  );

  const headline = formatHours(segment.hours);
  const issues = counts.incomplete + counts.empty;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div>
          <p className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-faint)]">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: tapeColor(colorIndex) }}
            />
            {segment.prefix}
          </p>
          <p className="mt-1.5 flex items-baseline gap-1.5">
            <span className="tabular text-[clamp(2.2rem,6vw,3rem)] font-semibold leading-[0.85] tracking-[-0.035em] text-[var(--text-primary)]">
              {headline.value}
            </span>
            <span className="text-base font-medium text-[var(--text-muted)]">
              {headline.unit}
            </span>
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:items-end sm:gap-x-8">
          {[
            {
              key: "episodes",
              label: t("common.episodes"),
              value: formatCompact(segment.episodes),
            },
            {
              key: "tasks",
              label: t("common.tasks"),
              value: formatCompact(segment.tasks),
            },
            {
              key: "perEpisode",
              label: t("source.perEpisode"),
              value: formatEpisodeLength(segment.avgEpisodeSeconds),
            },
            {
              key: "share",
              label: t("source.share"),
              value: `${Math.round(segment.share * 100)}%`,
            },
            {
              key: "storage",
              label: t("common.storage"),
              value: formatBytes(segment.bytes),
            },
          ].map((item) => (
            <div key={item.key}>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                {item.label}
              </dt>
              <dd className="tabular mt-1 text-base font-medium text-[var(--text-primary)]">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-md border border-white/5 bg-[var(--surface-1)]/40 px-4 py-3.5">
        <p className="mb-2.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-faint)]">
          {t("source.collectedSince")}
        </p>
        <TodayStrip delta={delta} since={since} spanDays={spanDays} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5 text-emerald-300/90">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="tabular">{counts.ok}</span> {t("common.healthy")}
        </span>
        {issues > 0 && (
          <span className="inline-flex items-center gap-1.5 text-amber-300/90">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="tabular">{issues}</span>{" "}
            {t("source.needAttention")}
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen(segment.prefix)}
          className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          {t("source.browseTasks", { count: segment.tasks })}
        </button>
      </div>

      {/* Sync. Listing always precedes transfer — an org can hold far more on
          the Hub than locally, and the count is the only warning you get. */}
      <div className="border-t border-white/5 pt-4">
        <SyncBlock
          state={sync}
          source={segment.prefix}
          onList={startListing}
          onConfirm={startDownload}
          onCancel={() => {
            abortRef.current?.abort();
            setSync({ kind: "idle" });
          }}
        />
      </div>
    </div>
  );
}

function SyncBlock({
  state,
  source,
  onList,
  onConfirm,
  onCancel,
}: {
  state: SyncState;
  source: string;
  onList: () => void;
  onConfirm: (force?: boolean) => void;
  onCancel: () => void;
}) {
  const { t, tp, tRich } = useLocale();

  if (state.kind === "idle" || state.kind === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onList}
          className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          {t("source.syncButton")}
        </button>
        <span className="text-[11px] text-[var(--text-faint)]">
          {t("source.syncHint", { source })}
        </span>
        {state.kind === "error" && (
          <p className="w-full text-xs text-red-300">{state.message}</p>
        )}
      </div>
    );
  }

  if (state.kind === "listing") {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        {t("source.checking", { source })}
      </p>
    );
  }

  if (state.kind === "confirm") {
    // The figure that matters is what differs, not what the org holds: a repo
    // already sitting at the remote commit is not work, and counting it as work
    // is what made every run look like a fresh full sync.
    const total = state.repos.length;
    const pending = state.pending.length;
    const current = total - pending;
    return (
      <div className="space-y-2.5">
        {pending === 0 ? (
          <p className="text-xs text-[var(--text-primary)]">
            {tRich("source.allCurrent", {
              total: <span className="tabular font-semibold">{total}</span>,
              source,
            })}
          </p>
        ) : (
          <p className="text-xs text-[var(--text-primary)]">
            {tRich("source.pending", {
              pending: (
                <span className="tabular font-semibold text-amber-300">
                  {pending}
                </span>
              ),
              total: <span className="tabular font-semibold">{total}</span>,
              source,
            })}
            {current > 0 && (
              <>
                {" "}
                {tRich("source.othersMatch", {
                  current: <span className="tabular">{current}</span>,
                })}
              </>
            )}
          </p>
        )}
        <p className="text-[11px] text-[var(--text-faint)]">
          {pending > 0 && <>{t("source.transferNote")} </>}
          {tRich("source.via", {
            endpoint: <span className="font-mono">{state.endpoint}</span>,
          })}
        </p>
        <div className="flex flex-wrap gap-2 pt-0.5">
          {pending > 0 && (
            <button
              type="button"
              onClick={() => onConfirm(false)}
              className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            >
              {tp("source.download", pending)}
            </button>
          )}
          {/* Escape hatch: the commit check reads the snapshot marker plus file
              sizes, so a copy corrupted in a way that preserves both still
              needs a way to be refetched. */}
          <button
            type="button"
            onClick={() => onConfirm(true)}
            title={t("source.recheckTitle")}
            className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            {t("source.recheckAll", { total })}
          </button>
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

  if (state.kind === "running") {
    return <SyncProgressView progress={state.progress} />;
  }

  return (
    <SyncOutcome
      downloaded={state.downloaded}
      skipped={state.skipped}
      failed={state.failed}
    />
  );
}

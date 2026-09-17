"use client";

import React, { useMemo, useState } from "react";
import type { DatasetGroup } from "@/utils/datasetGrouping";
import { computeCorpusStats } from "@/utils/corpusStats";
import type { DailyDelta } from "@/utils/corpusHistory";
import CorpusTape from "@/components/corpus-tape";
import SourcePanel from "@/components/source-panel";
import { useT } from "@/context/locale-context";

type OverallCounts = { ok: number; empty: number; incomplete: number };

type CorpusDashboardProps = {
  groups: DatasetGroup[];
  overall: OverallCounts;
  delta: DailyDelta;
  /**
   * Narrow the dataset list below to one source. It used to open a page of
   * that source's own; with the list flat, the same gesture sets its filter.
   */
  onSelectSource: (prefix: string) => void;
};

const ALL = "__all__";

/**
 * Homepage dashboard: an "All" view holding the corpus tape, plus one tab per
 * source with that source's own figures, its growth since the last snapshot,
 * and its Sync button.
 *
 * Tabs are per **source** (the top-level directory / Hugging Face org), not per
 * task — there are 231 tasks and four sources, and sync is an org-level
 * operation anyway.
 */
export default function CorpusDashboard({
  groups,
  overall,
  delta,
  onSelectSource,
}: CorpusDashboardProps) {
  const t = useT();
  const stats = useMemo(() => computeCorpusStats(groups), [groups]);
  const [tab, setTab] = useState<string>(ALL);

  const countsByPrefix = useMemo(() => {
    const map = new Map<string, OverallCounts>();
    for (const group of groups) map.set(group.prefix, group.counts);
    return map;
  }, [groups]);

  if (stats.segments.length === 0) return null;

  // A deep-linked or stale tab falls back to the overview rather than blanking.
  const active =
    tab === ALL ? null : (stats.segments.find((s) => s.prefix === tab) ?? null);
  const activeIndex = active
    ? stats.segments.findIndex((s) => s.prefix === active.prefix)
    : -1;

  const tabs = [
    { id: ALL, label: t("dash.allSources") },
    ...stats.segments.map((s) => ({ id: s.prefix, label: s.prefix })),
  ];

  return (
    <section
      aria-label={t("dash.aria")}
      className="mb-8 rounded-lg border border-white/5 bg-[var(--surface-0)]/60"
    >
      <div
        role="tablist"
        aria-label={t("dash.tablistAria")}
        className="flex flex-wrap gap-x-1 gap-y-0.5 border-b border-white/5 px-3 pt-2"
      >
        {tabs.map((entry) => {
          const selected =
            tab === entry.id || (active === null && entry.id === ALL);
          return (
            <button
              key={entry.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setTab(entry.id)}
              className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] ${
                selected
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div className="px-5 py-5 sm:px-6">
        {active === null ? (
          <CorpusTape
            groups={groups}
            overall={overall}
            onSelectSource={onSelectSource}
          />
        ) : (
          <SourcePanel
            segment={active}
            colorIndex={activeIndex}
            counts={
              countsByPrefix.get(active.prefix) ?? {
                ok: 0,
                empty: 0,
                incomplete: 0,
              }
            }
            delta={delta.bySource[active.prefix] ?? null}
            since={delta.since}
            spanDays={delta.spanDays}
            onFilterTo={onSelectSource}
          />
        )}
      </div>
    </section>
  );
}

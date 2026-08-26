"use client";

import React, { useMemo, useState } from "react";
import type { DatasetGroup } from "@/utils/datasetGrouping";
import HoverPlayVideo from "@/components/hover-play-video";
import LanguageSwitcher from "@/components/language-switcher";
import CorpusDashboard from "@/components/corpus-dashboard";
import { formatCompact } from "@/utils/corpusStats";
import type { DailyDelta } from "@/utils/corpusHistory";
import { useLocale } from "@/context/locale-context";

type OverallCounts = {
  ok: number;
  empty: number;
  incomplete: number;
};

type CategoryLandingProps = {
  root: string;
  groups: DatasetGroup[];
  overall: OverallCounts;
  errors: { path: string; message: string }[];
  delta: DailyDelta;
  onSelect: (prefix: string) => void;
};

function formatTotalEpisodes(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export default function CategoryLanding({
  root,
  groups,
  overall,
  errors,
  delta,
  onSelect,
}: CategoryLandingProps) {
  const { t, tp, tRich } = useLocale();
  const [query, setQuery] = useState("");

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.prefix.toLowerCase().includes(q) ||
        g.datasets.some((d) => d.relativePath.toLowerCase().includes(q)),
    );
  }, [groups, query]);

  return (
    <main className="px-8 py-10 max-w-7xl mx-auto">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="text-4xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-cyan-400 bg-clip-text text-transparent">
              {t("brand.part1")}
            </span>
            <span className="text-emerald-400">{t("brand.part2")}</span>
          </div>
          <h1 className="mt-3 text-xl font-medium tracking-tight text-slate-300">
            {t("home.subtitle")}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {tRich("home.browsing", {
              root: <span className="font-mono text-cyan-200/90">{root}</span>,
            })}
          </p>
        </div>
        <LanguageSwitcher className="mt-1.5" />
      </header>

      {/* Corpus dashboard. Replaces the old counts line + health pills: the same
          facts, plus where the recorded time comes from, per-source growth, and
          the Hugging Face sync. */}
      <CorpusDashboard
        groups={groups}
        overall={overall}
        delta={delta}
        onSelect={onSelect}
      />

      {errors.length > 0 && (
        <div className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <p className="font-semibold mb-1">
            {tp("home.scanErrors", errors.length)}
          </p>
          <ul className="space-y-0.5 font-mono text-amber-100/80">
            {errors.slice(0, 5).map((err, i) => (
              <li key={i} className="truncate">
                {err.path}: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
              />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("home.filterPlaceholder")}
              className="w-full rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-10 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </div>
        </div>
      )}

      {filteredGroups.length === 0 ? (
        <div className="rounded-md border border-white/10 bg-[var(--surface-1)]/40 p-10 text-center text-slate-400">
          {groups.length === 0 ? (
            <>
              {tRich("home.emptyTitle", {
                root: <span className="font-mono text-slate-200">{root}</span>,
              })}
              <br />
              <span className="text-xs text-slate-500">
                {tRich("home.emptyHint", { file: <code>meta/info.json</code> })}
              </span>
            </>
          ) : (
            <>{t("home.noMatch")}</>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {filteredGroups.map((group) => {
            const taskCount = group.datasets.length;
            const hasIssues = group.counts.incomplete + group.counts.empty > 0;
            return (
              <button
                key={group.prefix}
                type="button"
                onClick={() => onSelect(group.prefix)}
                title={t("home.groupTitle", {
                  prefix: group.prefix,
                  tasks: tp("home.taskCount", taskCount),
                })}
                data-hover-card
                className="group panel relative flex h-48 items-end overflow-hidden rounded-md border-2 border-white/10 text-left transition-colors hover:border-cyan-400/40"
              >
                {group.thumbnailVideoUrl ? (
                  <HoverPlayVideo
                    src={group.thumbnailVideoUrl}
                    className="absolute left-0 top-0 z-0 h-full w-full object-cover object-center"
                  />
                ) : (
                  <div className="absolute inset-0 z-0 bg-gradient-to-br from-slate-800 to-slate-900" />
                )}
                <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />

                {/* Task-count corner badge — top-right */}
                <div className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-full bg-cyan-500/85 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-900 shadow">
                  {tp("home.taskCount", taskCount)}
                </div>

                <div className="relative z-20 w-full px-3 py-3 text-slate-100">
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="h-4 w-4 shrink-0 text-cyan-300"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                    <div
                      className="truncate text-lg font-semibold tracking-tight"
                      title={group.prefix}
                    >
                      {group.prefix}
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-300">
                    <span className="tabular">
                      {t("home.groupEpisodes", {
                        value: formatTotalEpisodes(group.totalEpisodes),
                      })}
                    </span>
                    {group.totalFrames > 0 && (
                      <span className="tabular text-slate-400">
                        {t("home.groupFrames", {
                          value: formatCompact(group.totalFrames),
                        })}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      {t("home.groupHealthy", { count: group.counts.ok })}
                    </span>
                    {hasIssues && (
                      <span className="inline-flex items-center gap-1 text-amber-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                        {tp(
                          "home.groupIssues",
                          group.counts.incomplete + group.counts.empty,
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </main>
  );
}

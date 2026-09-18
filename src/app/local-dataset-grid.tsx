"use client";

import { isPathInsideRoot } from "@/utils/browsePath";
import React, { useCallback, useMemo, useState } from "react";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import type { DailyDelta } from "@/utils/corpusHistory";
import { groupDatasetsByPrefix } from "@/utils/datasetGrouping";
import CorpusDashboard from "@/components/corpus-dashboard";
import DatasetPathSwitcher from "@/components/dataset-path-switcher";
import LanguageSwitcher from "@/components/language-switcher";
import RepoFetchPanel from "@/components/repo-fetch-panel";
import DatasetCardGrid from "./dataset-card-grid";
import { useLocale } from "@/context/locale-context";

type LocalDatasetGridProps = {
  root: string;
  browsePath: string;
  locations: string[];
  datasets: LocalDatasetSummary[];
  errors: { path: string; message: string }[];
  delta: DailyDelta;
};

/** Anchor for the "filter to this source" scroll; see `focusSource`. */
const GRID_ANCHOR_ID = "dataset-grid";

/**
 * The homepage: everything under the currently scanned path, in one list.
 *
 * There used to be a level above this — one card per path prefix, drilled into
 * via `?org=`. It was a presentation-layer invention: the scanner already
 * returns one flat `LocalDatasetSummary[]`, and the prefix is nothing but the
 * first path segment. Switching which *set* of datasets you see is the path
 * switcher's job, and narrowing within one is what the grid's own filters are
 * for, so the middle page only cost a click on the way in.
 *
 * The prefix itself is very much alive — it keys the daily corpus history and
 * it is the Hugging Face org that per-source Sync targets. It is simply no
 * longer something you navigate.
 */
export default function LocalDatasetGrid({
  root,
  browsePath,
  locations,
  datasets,
  errors,
  delta,
}: LocalDatasetGridProps) {
  const { t, tp, tRich } = useLocale();
  /**
   * The grid's search box, lifted so the dashboard can drive it: a tape band
   * and a source panel's "filter" button both narrow the list to one source
   * rather than opening a page that no longer exists.
   */
  const [query, setQuery] = useState("");

  const groups = useMemo(() => groupDatasetsByPrefix(datasets), [datasets]);

  const overall = useMemo(() => {
    let ok = 0;
    let empty = 0;
    let incomplete = 0;
    for (const ds of datasets) {
      if (ds.integrity.status === "ok") ok += 1;
      else if (ds.integrity.status === "empty") empty += 1;
      else incomplete += 1;
    }
    return { ok, empty, incomplete };
  }, [datasets]);

  /**
   * The prefix is a whole leading path segment, and the grid's text filter
   * already matches `relativePath`, so handing it the prefix selects exactly
   * that source. Scroll too: the dashboard is tall enough that the list it
   * just changed is usually off screen.
   */
  const focusSource = useCallback((prefix: string) => {
    setQuery(prefix);
    document
      .getElementById(GRID_ANCHOR_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

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
          {/* A div, not a p: DatasetPathSwitcher renders a popover div, which
              is invalid inside a paragraph and breaks hydration. */}
          <div className="mt-2 text-sm text-slate-400">
            {tRich("home.browsing", {
              root: (
                <span className="font-mono text-cyan-200/90">{browsePath}</span>
              ),
            })}
            <DatasetPathSwitcher
              root={root}
              browsePath={browsePath}
              locations={locations}
            />
          </div>
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
        onSelectSource={focusSource}
      />

      {/* Deliberately outside the dashboard: `CorpusDashboard` renders nothing
          when no source exists yet, and an empty root is precisely when pulling
          a dataset by id is the only thing left to do — so it opens by default
          there and stays collapsed once there is a corpus to browse. */}
      <RepoFetchPanel defaultOpen={datasets.length === 0} />

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

      {/* Nothing scanned at all is a different answer from "your filters match
          nothing", which is the grid's own `grid.noMatch` — this one names the
          path and says what makes a directory a dataset. */}
      {datasets.length === 0 ? (
        <div className="rounded-md border border-white/10 bg-[var(--surface-1)]/40 p-10 text-center text-slate-400">
          {tRich("home.emptyTitle", {
            root: (
              <span className="font-mono text-slate-200">{browsePath}</span>
            ),
          })}
          <br />
          <span className="text-xs text-slate-500">
            {tRich("home.emptyHint", { file: <code>meta/info.json</code> })}
          </span>
        </div>
      ) : (
        <div id={GRID_ANCHOR_ID} className="scroll-mt-6">
          <DatasetCardGrid
            datasets={datasets}
            canDelete={isPathInsideRoot(root, browsePath)}
            query={query}
            onQueryChange={setQuery}
          />
        </div>
      )}
    </main>
  );
}

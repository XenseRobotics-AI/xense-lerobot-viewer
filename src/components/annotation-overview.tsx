"use client";

/**
 * Homepage panel for TacFlow's ④ automatic annotations: how many datasets / episodes are annotated, the outcome mix,
 * the findings by category, and one list of every data issue and operator mistake across the corpus. Each row opens
 * the episode on its Auto annotation panel at the finding's time (`?tab=annotations&t=`).
 *
 * The list has one row per dataset + kind + category (merged across episodes) and by default shows only rows someone
 * still has to look at: findings ruled on in TacFlow (`tacflow review --finding`) are hidden behind a toggle.
 *
 * Read-only, like the per-episode panel; renders nothing when no dataset under the browsed path has an annotation.
 * The labels are a vision model's reading of the head camera — claims to check, which is what the list is for.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { groupFindings, totalSummaries } from "@/types/auto-annotation.types";
import { useLocale } from "@/context/locale-context";

const OUTCOME_COLOR: Record<string, string> = {
  success: "bg-emerald-500/80",
  success_then_undone: "bg-amber-400/80",
  partial: "bg-amber-500/80",
  unclear: "bg-slate-400/70",
  failure: "bg-rose-500/80",
  unknown: "bg-slate-600/70",
};

const ROWS_COLLAPSED = 8;

export function autoAnnotationLink(
  encodedPath: string,
  episode: number,
  t: number | null,
): string {
  const time = t === null ? "" : `&t=${Math.max(0, t).toFixed(2)}`;
  return `/_local/${encodedPath}/episode_${Math.max(0, Math.floor(episode))}?tab=annotations${time}`;
}

export default function AnnotationOverview({
  datasets,
}: {
  datasets: LocalDatasetSummary[];
}) {
  const { t, tp } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const annotated = useMemo(
    () => datasets.filter((d) => d.annotation),
    [datasets],
  );
  const totals = useMemo(
    () => totalSummaries(annotated.map((d) => d.annotation!)),
    [annotated],
  );
  const groups = useMemo(
    () =>
      annotated.flatMap((d) =>
        groupFindings(d.annotation!.findings).map((g) => ({
          ...g,
          dataset: d.relativePath,
          encodedPath: d.encodedPath,
        })),
      ),
    [annotated],
  );
  const open = groups.filter((g) => g.resolved < g.count);
  const rows = showResolved ? groups : open;
  if (annotated.length === 0) return null;

  const outcomeEntries = Object.entries(totals.outcomes).sort(
    (a, b) => b[1] - a[1],
  );
  const categories = Object.entries(totals.categories).sort(
    (a, b) => b[1] - a[1],
  );
  const models = [...new Set(annotated.flatMap((d) => d.annotation!.models))];
  const shown = expanded ? rows : rows.slice(0, ROWS_COLLAPSED);

  return (
    <section
      aria-label={t("annOverview.title")}
      className="mb-8 rounded-lg border border-white/5 bg-[var(--surface-0)]/60 px-5 py-5 sm:px-6"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold text-slate-100">
          {t("annOverview.title")}
        </h2>
        <span className="text-sm text-slate-400">
          {t("annOverview.counts", {
            datasets: totals.datasets,
            all: datasets.length,
            usable: totals.usable,
            episodes: totals.episodes,
          })}
        </span>
        <span className="ml-auto text-[11px] text-slate-500">
          {models.join(", ")} ·{" "}
          {t("annOverview.spent", { usd: totals.spent.toFixed(2) })}
        </span>
      </div>

      {/* outcome mix across usable episodes */}
      <div className="flex h-3 overflow-hidden rounded bg-white/5" aria-hidden>
        {outcomeEntries.map(([k, v]) => (
          <span
            key={k}
            className={OUTCOME_COLOR[k] ?? "bg-slate-500/70"}
            style={{ width: `${(100 * v) / Math.max(1, totals.usable)}%` }}
            title={`${k}: ${v}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
        {outcomeEntries.map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-sm ${OUTCOME_COLOR[k] ?? "bg-slate-500/70"}`}
            />
            {k} <span className="tabular text-slate-200">{v}</span>
          </span>
        ))}
        {categories.length > 0 && <span className="text-slate-600">|</span>}
        {categories.map(([k, v]) => (
          <span key={k}>
            {k} <span className="tabular text-rose-200">{v}</span>
          </span>
        ))}
      </div>

      <p className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {t("annOverview.findings", { count: open.length })}
        {groups.length > open.length && (
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="ml-3 font-normal normal-case tracking-normal text-cyan-300 hover:text-cyan-200"
          >
            {showResolved
              ? t("annOverview.hideResolved")
              : t("annOverview.showResolved", {
                  count: groups.length - open.length,
                })}
          </button>
        )}
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">
          {groups.length
            ? t("annOverview.allResolved")
            : t("annOverview.noFindings")}
        </p>
      ) : (
        <ul className="divide-y divide-white/5 rounded-md border border-white/5">
          {shown.map((r) => (
            <li key={`${r.encodedPath}-${r.kind}-${r.category}`}>
              <Link
                href={autoAnnotationLink(
                  r.encodedPath,
                  r.first.episode_index,
                  r.first.t_s,
                )}
                className={`flex gap-3 px-3 py-2 text-sm hover:bg-white/5 ${
                  r.resolved === r.count ? "opacity-50" : ""
                }`}
              >
                <span
                  className="w-64 shrink-0 truncate text-slate-200"
                  title={r.dataset}
                >
                  {r.dataset}
                </span>
                <span
                  className="w-28 shrink-0 truncate tabular text-slate-500"
                  title={r.episodes.map((e) => `ep ${e}`).join(", ")}
                >
                  {r.episodes.length === 1
                    ? `ep ${r.first.episode_index} · ${r.first.t_s === null ? "—" : `${r.first.t_s.toFixed(0)}s`}`
                    : tp("annOverview.episodes", r.episodes.length)}
                </span>
                <span className="w-48 shrink-0 truncate text-rose-200">
                  {r.kind === "data_issue"
                    ? t("autoAnn.dataIssue")
                    : t("autoAnn.mistake")}
                  {r.category ? ` · ${r.category}` : ""}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-slate-300"
                  title={r.first.issue}
                >
                  {r.first.issue}
                </span>
                {r.resolved > 0 && (
                  <span className="shrink-0 text-xs text-emerald-300">
                    {t("annOverview.resolvedCount", {
                      done: r.resolved,
                      all: r.count,
                    })}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {rows.length > ROWS_COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-cyan-300 hover:text-cyan-200"
        >
          {expanded
            ? t("annOverview.collapse")
            : t("annOverview.showAll", { count: rows.length })}
        </button>
      )}
    </section>
  );
}

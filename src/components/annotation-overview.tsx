"use client";

/**
 * Homepage panel for TacFlow's ④ automatic annotations: how many datasets / episodes are annotated, the outcome mix,
 * the findings by category, and one list of every data issue and operator mistake across the corpus. Each row opens
 * the episode on its Auto annotation panel at the finding's time (`?tab=annotations&ann=auto&t=`).
 *
 * Read-only, like the per-episode panel; renders nothing when no dataset under the browsed path has an annotation.
 * The labels are a vision model's reading of the head camera — claims to check, which is what the list is for.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { totalSummaries } from "@/types/auto-annotation.types";
import { useT } from "@/context/locale-context";

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
  return `/_local/${encodedPath}/episode_${Math.max(0, Math.floor(episode))}?tab=annotations&ann=auto${time}`;
}

export default function AnnotationOverview({
  datasets,
}: {
  datasets: LocalDatasetSummary[];
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const annotated = useMemo(
    () => datasets.filter((d) => d.annotation),
    [datasets],
  );
  const totals = useMemo(
    () => totalSummaries(annotated.map((d) => d.annotation!)),
    [annotated],
  );
  const rows = useMemo(
    () =>
      annotated.flatMap((d) =>
        d.annotation!.findings.map((f) => ({
          ...f,
          dataset: d.relativePath,
          encodedPath: d.encodedPath,
        })),
      ),
    [annotated],
  );
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
        <h2 className="text-sm font-medium text-slate-200">
          {t("annOverview.title")}
        </h2>
        <span className="text-xs text-slate-500">
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
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
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

      <p className="mt-4 mb-1 text-[10px] uppercase tracking-wide text-slate-500">
        {t("annOverview.findings", { count: rows.length })}
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">{t("annOverview.noFindings")}</p>
      ) : (
        <ul className="divide-y divide-white/5 rounded-md border border-white/5">
          {shown.map((r, i) => (
            <li key={`${r.encodedPath}-${r.episode_index}-${i}`}>
              <Link
                href={autoAnnotationLink(r.encodedPath, r.episode_index, r.t_s)}
                className="flex gap-3 px-3 py-1.5 text-xs hover:bg-white/5"
              >
                <span
                  className="w-56 shrink-0 truncate text-slate-300"
                  title={r.dataset}
                >
                  {r.dataset}
                </span>
                <span className="w-24 shrink-0 tabular text-slate-500">
                  ep {r.episode_index} ·{" "}
                  {r.t_s === null ? "—" : `${r.t_s.toFixed(0)}s`}
                </span>
                <span className="w-40 shrink-0 truncate text-rose-200">
                  {r.kind === "data_issue"
                    ? t("autoAnn.dataIssue")
                    : t("autoAnn.mistake")}
                  {r.category ? ` · ${r.category}` : ""}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-slate-300"
                  title={r.issue}
                >
                  {r.issue}
                </span>
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

"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useT } from "@/context/locale-context";
import { formatCompact, formatEpisodeLength } from "@/utils/corpusStats";
import {
  EMPTY_TACVERSE_HUB_CATEGORY_SELECTION,
  serializeTacverseHubCategorySelection,
  type TacverseHubCategorySelection,
} from "@/utils/workbenchHubCategory";
import {
  filterTacverseDatasetStatistics,
  formatRelativeUpdatedAt,
  fullTimestamp,
  sortTacverseDatasetStatistics,
  summarizeTacverseDatasetStatistics,
  type TacverseDatasetSort,
  type TacverseDatasetStatisticsResponse,
  type TacverseDatasetStatisticsRow,
  type TacverseLocalStatus,
} from "@/utils/tacverseDatasetStatistics";

type Tone = "neutral" | "accent" | "ok" | "warn";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-white/10 bg-[var(--surface-1)]/65",
  accent: "border-cyan-400/25 bg-cyan-500/[0.06]",
  ok: "border-emerald-400/25 bg-emerald-500/[0.06]",
  warn: "border-amber-400/25 bg-amber-500/[0.06]",
};

function KpiCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-md border p-3 ${TONE_CLASSES[tone]}`}>
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-100">
        {value}
      </div>
    </div>
  );
}

function formatNullableCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function formatNullableHours(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 3,
  });
}

function formatSummaryHours(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 3,
  });
}

function localBadge(status: TacverseLocalStatus, t: ReturnType<typeof useT>) {
  if (status === "downloaded") {
    return {
      label: t("workbench.downloaded"),
      className: "border-emerald-400/25 bg-emerald-500/10 text-emerald-200",
    };
  }
  if (status === "incomplete") {
    return {
      label: t("workbench.incomplete"),
      className: "border-amber-400/25 bg-amber-500/10 text-amber-200",
    };
  }
  return {
    label: t("workbench.localMissing"),
    className: "border-slate-400/20 bg-slate-500/10 text-slate-400",
  };
}

export default function WorkbenchDatasetStatistics({
  categoryFilter = EMPTY_TACVERSE_HUB_CATEGORY_SELECTION,
  refreshToken = 0,
}: {
  categoryFilter?: TacverseHubCategorySelection;
  refreshToken?: number;
}) {
  const t = useT();
  const [payload, setPayload] =
    useState<TacverseDatasetStatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [query, setQuery] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [sort, setSort] = useState<TacverseDatasetSort>("updated");
  const [now, setNow] = useState(() => Date.now());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(
      "/api/workbench/dataset-statistics?category=" +
        encodeURIComponent(
          serializeTacverseHubCategorySelection(categoryFilter),
        ),
      {
        cache: "no-store",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const result = (await response
          .json()
          .catch(() => ({}))) as TacverseDatasetStatisticsResponse;
        if (!response.ok) {
          throw new Error(
            result.error ||
              `Dataset statistics request failed (${response.status})`,
          );
        }
        if (!Array.isArray(result.datasets)) {
          throw new Error(t("workbench.statisticsIncomplete"));
        }
        return result;
      })
      .then(setPayload)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [categoryFilter, refreshToken, retryToken, t]);

  const summary = useMemo(
    () =>
      summarizeTacverseDatasetStatistics(
        payload?.datasets ?? [],
        payload?.categoryTotal ?? 0,
      ),
    [payload],
  );
  const rows = useMemo(
    () =>
      filterTacverseDatasetStatistics(
        sortTacverseDatasetStatistics(payload?.datasets ?? [], sort),
        query,
        issuesOnly,
      ),
    [issuesOnly, payload, query, sort],
  );

  if (loading) {
    return (
      <section className="rounded-xl border border-white/10 bg-[var(--surface-0)]/40 p-5 text-sm text-slate-400">
        {t("workbench.loadingDashboard")}
      </section>
    );
  }

  if (error || !payload) {
    return (
      <section className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-5 text-sm text-amber-200">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium">{t("workbench.statisticsLoadFailed")}</p>
            <p className="mt-1 text-xs text-amber-200/75">
              {error || t("workbench.statisticsIncomplete")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRetryToken((value) => value + 1)}
            className="rounded-md border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 transition-colors hover:border-amber-200/70 hover:bg-amber-300/10"
          >
            {t("workbench.retry")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="dataset-statistics-title"
      className="rounded-lg border border-cyan-400/15 bg-[var(--surface-0)]/60 p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="dataset-statistics-title"
            className="text-sm font-semibold text-cyan-200"
          >
            {t("workbench.datasetStatistics")}
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            {t("workbench.hubCatalogVisible")}
            {payload.refreshedAt
              ? ` · ${t("workbench.refreshed", { date: new Date(payload.refreshedAt).toLocaleString() })}`
              : ` · ${t("workbench.notRefreshed")}`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[10px] text-slate-500">
          {t("workbench.sort")}
          <select
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as TacverseDatasetSort)
            }
            aria-label={t("workbench.sortTacVerse")}
            className="rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs text-slate-200 focus:border-cyan-400 focus:outline-none"
          >
            <option value="updated">{t("workbench.recentlyUpdated")}</option>
            <option value="created">{t("workbench.recentlyCreated")}</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          label={t("workbench.datasets")}
          value={summary.datasets.toLocaleString()}
        />
        <KpiCard
          label={t("common.episodes")}
          value={formatCompact(summary.episodes)}
        />
        <KpiCard
          label={t("common.frames")}
          value={formatCompact(summary.frames)}
        />
        <KpiCard
          label={t("common.hours")}
          value={formatSummaryHours(summary.hours)}
          tone="accent"
        />
        <KpiCard
          label={t("workbench.issuesOnly")}
          value={summary.issues.toLocaleString()}
          tone={summary.issues > 0 ? "warn" : "ok"}
        />
        <KpiCard
          label={t("workbench.downloads")}
          value={formatCompact(summary.downloads)}
        />
      </div>

      {payload.refreshedAt === null && payload.hubTotal === 0 && (
        <p className="mt-4 rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
          {t("workbench.hubCatalogEmpty")}{" "}
          {t("workbench.refreshStatisticsFirst")}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">
            {t("workbench.filterDatasetStatistics")}
          </span>
          <svg
            className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("workbench.datasetFilterPlaceholder")}
            className="w-full rounded-md border border-white/10 bg-[var(--surface-1)]/60 py-2 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={issuesOnly}
            onChange={(event) => setIssuesOnly(event.target.checked)}
            className="accent-cyan-400"
          />
          {t("workbench.issuesOnly")}
        </label>
      </div>

      {(payload.catalogFailures?.length ?? 0) > 0 && (
        <p className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/80">
          {t("workbench.metadataErrors", {
            count: payload.catalogFailures?.length.toLocaleString() ?? "0",
          })}
        </p>
      )}

      <div className="mt-3 max-h-[34rem] overflow-auto rounded-md border border-white/10">
        <table className="w-full min-w-[1080px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-3 py-2.5 font-medium">
                {t("workbench.dataset")}
              </th>
              <th className="px-3 py-2.5 font-medium">robot_type</th>
              <th className="px-3 py-2.5 font-medium">
                {t("workbench.updated")}
              </th>
              <th className="px-3 py-2.5 text-right font-medium">
                {t("workbench.downloads")}
              </th>
              <th className="px-3 py-2.5 font-medium">
                {t("workbench.local")}
              </th>
              <th className="px-3 py-2.5 text-right font-medium">
                {t("common.episodes")}
              </th>
              <th className="px-3 py-2.5 text-right font-medium">
                {t("common.frames")}
              </th>
              <th className="px-3 py-2.5 text-right font-medium">
                {t("common.hours")}
              </th>
              <th className="px-3 py-2.5 text-right font-medium">
                {t("workbench.avgPerEpisode")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((row) => {
              const renderCells = (
                item: TacverseDatasetStatisticsRow,
                child = false,
              ) => {
                const local = localBadge(item.localStatus, t);
                const averageSeconds =
                  item.episodes !== null &&
                  item.episodes > 0 &&
                  item.hours !== null
                    ? (item.hours * 3600) / item.episodes
                    : null;
                const mixedRobotTypes = item.robotTypes.length > 1;
                return (
                  <>
                    <td className="max-w-[24rem] px-3 py-2.5">
                      <div
                        className={
                          child
                            ? "flex items-start gap-2 pl-7"
                            : "flex items-start gap-2"
                        }
                      >
                        {!child && item.rowType === "folder" && (
                          <button
                            type="button"
                            aria-expanded={expandedFolders.has(item.repoId)}
                            aria-label={t("workbench.toggleChildren", {
                              repo: item.repoId,
                            })}
                            onClick={() =>
                              setExpandedFolders((current) => {
                                const next = new Set(current);
                                if (next.has(item.repoId))
                                  next.delete(item.repoId);
                                else next.add(item.repoId);
                                return next;
                              })
                            }
                            className="mt-0.5 w-4 shrink-0 text-cyan-300"
                          >
                            {expandedFolders.has(item.repoId) ? "▾" : "▸"}
                          </button>
                        )}
                        <div className="min-w-0">
                          <a
                            href={item.hubUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate font-medium text-slate-200 hover:text-cyan-200"
                            title={t("workbench.openOnHub", {
                              repo: item.repoId,
                            })}
                          >
                            {child ? item.name : item.repoId}
                          </a>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {item.rowType === "folder" && (
                              <span className="rounded border border-cyan-400/20 bg-cyan-400/5 px-1 text-[9px] uppercase text-cyan-200">
                                {t("workbench.folderChildren", {
                                  count: item.children.length,
                                })}
                              </span>
                            )}
                            {item.metricsState !== "ok" && (
                              <span
                                className="rounded border border-amber-400/20 bg-amber-400/5 px-1 text-[9px] uppercase text-amber-200"
                                title={
                                  item.metricsState === "partial"
                                    ? t("workbench.partialValues")
                                    : t("workbench.unavailableMetadata")
                                }
                              >
                                {item.metricsState === "partial"
                                  ? t("workbench.metricsPartial")
                                  : t("workbench.metricsUnavailable")}
                              </span>
                            )}
                            {item.categoryWarning && (
                              <span
                                className="rounded border border-amber-400/20 bg-amber-400/5 px-1 text-[9px] text-amber-200"
                                title={item.categoryWarning}
                              >
                                {t("workbench.robotTypeWarning")}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td
                      className="px-3 py-2.5 text-slate-400"
                      title={
                        mixedRobotTypes ? item.robotTypes.join(", ") : undefined
                      }
                    >
                      {mixedRobotTypes
                        ? t("workbench.robotTypes", {
                            count: item.robotTypes.length,
                          })
                        : (item.robotType ?? "—")}
                    </td>
                    <td
                      className="whitespace-nowrap px-3 py-2.5 text-slate-400"
                      title={fullTimestamp(item.lastModified)}
                    >
                      {child
                        ? "—"
                        : formatRelativeUpdatedAt(item.lastModified, now)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                      {formatNullableCount(item.downloads)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${local.className}`}
                      >
                        {local.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                      {formatNullableCount(item.episodes)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                      {formatNullableCount(item.frames)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                      {formatNullableHours(item.hours)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                      {formatEpisodeLength(averageSeconds)}
                    </td>
                  </>
                );
              };
              return (
                <Fragment key={row.repoId}>
                  <tr className="hover:bg-white/[0.025]">{renderCells(row)}</tr>
                  {row.rowType === "folder" &&
                    expandedFolders.has(row.repoId) &&
                    row.children.map((child) => (
                      <tr
                        key={child.repoId}
                        className="bg-cyan-400/[0.025] hover:bg-cyan-400/[0.05]"
                      >
                        {renderCells(child, true)}
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-slate-500">
            {t("workbench.noDatasetMatch")}
          </div>
        )}
      </div>
      <div className="mt-2 text-[10px] text-slate-500">
        {t("workbench.showingDatasets", {
          shown: rows.length.toLocaleString(),
          category: payload.categoryTotal.toLocaleString(),
          total: payload.hubTotal.toLocaleString(),
        })}
      </div>
    </section>
  );
}

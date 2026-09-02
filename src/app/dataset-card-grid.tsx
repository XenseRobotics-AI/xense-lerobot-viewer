"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  DatasetIntegrity,
  LocalDatasetSummary,
} from "@/lib/local-datasets-discovery";
import type { DatasetTags } from "@/lib/dataset-tags";
import DatasetTagsEditor from "@/components/dataset-tags-editor";
import {
  DeleteDatasetDialog,
  TrashStrip,
} from "@/components/dataset-trash-controls";
import HoverPlayVideo from "@/components/hover-play-video";
import LanguageSwitcher from "@/components/language-switcher";
import {
  compareDatasetsBySize,
  getDatasetTaskName,
} from "@/utils/datasetGrouping";
import { formatBytes } from "@/utils/byteSize";
import {
  BUCKET_ORDER,
  CAPTURE_CUTOFF,
  DATE_FILTER_ALL,
  DATE_FILTER_AFTER_CUTOFF,
  countFacets,
  countMatchingDate,
  matchesAnomalyOnly,
  matchesBucket,
  matchesDate,
  type BucketFilter,
  type DateFilter,
} from "@/utils/corpusFilters";
import { useLocale } from "@/context/locale-context";
import type { MessageKey } from "@/i18n/messages";

type DatasetCardGridProps = {
  root: string;
  prefix: string;
  datasets: LocalDatasetSummary[];
  onBack: () => void;
};

type HealthFilter = "all" | "ok" | "issues";

type TaskFilter = "all" | "untagged" | string;

/**
 * Bucket directory name → message key. The directory names are English by
 * necessity (they are paths on disk), but the chips they label are read by
 * people using either language, so the display name goes through i18n like
 * every other label in this grid.
 */
const BUCKET_LABEL_KEYS = {
  merged: "grid.bucketMerged",
  raw: "grid.bucketRaw",
  failed: "grid.bucketFailed",
  released: "grid.bucketReleased",
  "in-processing": "grid.bucketInProcessing",
} as const satisfies Record<(typeof BUCKET_ORDER)[number], MessageKey>;

function buildEpisodeRoute(encodedPath: string, episode: number = 0): string {
  return `/_local/${encodedPath}/episode_${Math.max(0, Math.floor(episode))}`;
}

function formatTotalFrames(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

function describeIntegrity(
  integrity: DatasetIntegrity,
  t: Translate,
): {
  label: string;
  reason: string;
  tone: "ok" | "warn" | "error";
} {
  if (integrity.status === "ok") {
    return {
      label: t("grid.healthOk"),
      reason: t("grid.healthOkReason"),
      tone: "ok",
    };
  }
  if (integrity.status === "empty") {
    return {
      label: t("grid.healthEmpty"),
      reason: t("grid.healthEmptyReason"),
      tone: "warn",
    };
  }
  const missing: string[] = [];
  if (!integrity.hasData) missing.push("data/");
  if (!integrity.hasVideos) missing.push("videos/");
  return {
    label: t("grid.healthIncomplete"),
    reason: t("grid.healthIncompleteReason", {
      missing: missing.join(", ") || t("grid.healthMissingFallback"),
    }),
    tone: "error",
  };
}

export default function DatasetCardGrid({
  root,
  prefix,
  datasets,
  onBack,
}: DatasetCardGridProps) {
  const { t, tpRich, tRich } = useLocale();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedRobot, setSelectedRobot] = useState<string>("all");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>(DATE_FILTER_ALL);
  const [anomalyOnly, setAnomalyOnly] = useState(false);
  const [episodeOverrides, setEpisodeOverrides] = useState<
    Record<string, string>
  >({});
  // Locally-mirrored tags so a Save in the editor instantly updates the grid
  // before router.refresh() re-fetches the server discovery.
  const [tagOverrides, setTagOverrides] = useState<Record<string, DatasetTags>>(
    {},
  );
  const [editingDatasetKey, setEditingDatasetKey] = useState<string | null>(
    null,
  );
  const [deletingDatasetKey, setDeletingDatasetKey] = useState<string | null>(
    null,
  );
  // Datasets moved to the trash in this session. The server discovery is
  // `force-dynamic`, but router.refresh() is a round trip — dropping the card
  // locally keeps the grid honest in the meantime.
  const [trashedKeys, setTrashedKeys] = useState<string[]>([]);
  const [trashVersion, setTrashVersion] = useState(0);

  // Apply overrides (from in-page edits) on top of server-loaded tags.
  const datasetsWithLiveTags = useMemo(
    () =>
      datasets
        .filter((ds) => !trashedKeys.includes(ds.encodedPath))
        .map((ds) =>
          tagOverrides[ds.encodedPath]
            ? { ...ds, tags: tagOverrides[ds.encodedPath] }
            : ds,
        ),
    [datasets, tagOverrides, trashedKeys],
  );

  const robotTypes = useMemo(() => {
    const set = new Set<string>();
    for (const ds of datasetsWithLiveTags) {
      if (ds.robot_type) set.add(ds.robot_type);
    }
    return Array.from(set).sort();
  }, [datasetsWithLiveTags]);

  const healthCounts = useMemo(() => {
    let ok = 0;
    let empty = 0;
    let incomplete = 0;
    for (const ds of datasetsWithLiveTags) {
      if (ds.integrity.status === "ok") ok += 1;
      else if (ds.integrity.status === "empty") empty += 1;
      else incomplete += 1;
    }
    return { ok, empty, incomplete, issues: empty + incomplete };
  }, [datasetsWithLiveTags]);

  // Count datasets per task tag (plus untagged).
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let untagged = 0;
    for (const ds of datasetsWithLiveTags) {
      if (ds.tags.task) {
        counts.set(ds.tags.task, (counts.get(ds.tags.task) ?? 0) + 1);
      } else {
        untagged += 1;
      }
    }
    return { perTask: counts, untagged };
  }, [datasetsWithLiveTags]);

  const sortedTaskKeys = useMemo(
    () => Array.from(taskCounts.perTask.keys()).sort(),
    [taskCounts],
  );

  // Bucket / capture-date / shape-anomaly counts for the facet chips. Computed
  // over the whole category so a chip's number does not change as you filter.
  const facetCounts = useMemo(
    () => countFacets(datasetsWithLiveTags),
    [datasetsWithLiveTags],
  );

  // How many the current range would keep, shown on the range button so an
  // empty result is visibly the filter's doing rather than a broken page.
  const dateMatchCount = useMemo(
    () => countMatchingDate(datasetsWithLiveTags, dateFilter),
    [datasetsWithLiveTags, dateFilter],
  );

  // Biggest first (frames, then episodes), so the top-left card is always the
  // most substantial task in the category and the order survives filtering.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = datasetsWithLiveTags.filter((ds) => {
      if (!matchesBucket(ds, bucketFilter)) return false;
      if (!matchesDate(ds, dateFilter)) return false;
      if (!matchesAnomalyOnly(ds, anomalyOnly)) return false;
      if (selectedRobot !== "all" && ds.robot_type !== selectedRobot) {
        return false;
      }
      if (healthFilter === "ok" && ds.integrity.status !== "ok") return false;
      if (healthFilter === "issues" && ds.integrity.status === "ok")
        return false;
      if (taskFilter === "untagged" && ds.tags.task) return false;
      if (
        taskFilter !== "all" &&
        taskFilter !== "untagged" &&
        ds.tags.task !== taskFilter
      )
        return false;
      if (!q) return true;
      return (
        ds.relativePath.toLowerCase().includes(q) ||
        (ds.robot_type ?? "").toLowerCase().includes(q) ||
        (ds.tags.task ?? "").toLowerCase().includes(q) ||
        (ds.tags.scene ?? "").toLowerCase().includes(q) ||
        ds.tags.objects.some((o) => o.toLowerCase().includes(q))
      );
    });
    return matches.sort(compareDatasetsBySize);
  }, [
    datasetsWithLiveTags,
    query,
    selectedRobot,
    healthFilter,
    taskFilter,
    bucketFilter,
    dateFilter,
    anomalyOnly,
  ]);

  const editingDataset = editingDatasetKey
    ? (datasetsWithLiveTags.find((d) => d.encodedPath === editingDatasetKey) ??
      null)
    : null;
  const deletingDataset = deletingDatasetKey
    ? (datasetsWithLiveTags.find((d) => d.encodedPath === deletingDatasetKey) ??
      null)
    : null;

  return (
    <main className="px-8 py-10 max-w-7xl mx-auto">
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <button
            type="button"
            onClick={onBack}
            className="group inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <svg
              className="h-4 w-4 transition-transform group-hover:-translate-x-0.5"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden
            >
              <path
                fillRule="evenodd"
                d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            {t("grid.back")}
          </button>
          <LanguageSwitcher />
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-100">
          {prefix}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          {tpRich("grid.browsingLine", datasetsWithLiveTags.length, {
            root: <span className="font-mono text-cyan-200/90">{root}</span>,
          })}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {t("grid.healthyCount", { count: healthCounts.ok })}
          </span>
          {healthCounts.incomplete > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-red-200">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
              {t("grid.incompleteCount", { count: healthCounts.incomplete })}
            </span>
          )}
          {healthCounts.empty > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-200">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              {t("grid.emptyCount", { count: healthCounts.empty })}
            </span>
          )}
        </div>
      </header>

      {sortedTaskKeys.length === 0 && datasetsWithLiveTags.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-cyan-400/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
          <svg
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 4 13.172V16h2.828l7.379-7.379-2.828-2.828z" />
          </svg>
          <div>
            {tRich("grid.tagHint", {
              task: (
                <span className="font-medium text-violet-200">
                  {t("grid.wordTask")}
                </span>
              ),
              scene: (
                <span className="font-medium text-sky-200">
                  {t("grid.wordScene")}
                </span>
              ),
              objects: (
                <span className="font-medium text-slate-200">
                  {t("grid.wordObjects")}
                </span>
              ),
              button: (
                <span className="rounded bg-black/40 px-1 font-medium text-slate-100">
                  ✎ {t("grid.tagsButton")}
                </span>
              ),
            })}
          </div>
        </div>
      )}

      {(sortedTaskKeys.length > 0 || taskCounts.untagged > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            {t("grid.taskFilterLabel")}
          </span>
          <button
            type="button"
            onClick={() => setTaskFilter("all")}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              taskFilter === "all"
                ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                : "border-white/10 bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
            }`}
          >
            {t("grid.filterAll", { count: datasetsWithLiveTags.length })}
          </button>
          {sortedTaskKeys.map((taskKey) => (
            <button
              key={taskKey}
              type="button"
              onClick={() =>
                setTaskFilter((prev) => (prev === taskKey ? "all" : taskKey))
              }
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                taskFilter === taskKey
                  ? "border-violet-400/60 bg-violet-500/30 text-violet-100"
                  : "border-violet-400/20 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20"
              }`}
            >
              {taskKey} ({taskCounts.perTask.get(taskKey) ?? 0})
            </button>
          ))}
          {taskCounts.untagged > 0 && (
            <button
              type="button"
              onClick={() =>
                setTaskFilter((prev) =>
                  prev === "untagged" ? "all" : "untagged",
                )
              }
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                taskFilter === "untagged"
                  ? "border-slate-400/60 bg-slate-500/30 text-slate-100"
                  : "border-white/10 bg-[var(--surface-1)]/60 text-slate-400 hover:text-slate-200"
              }`}
            >
              {t("grid.filterUntagged", { count: taskCounts.untagged })}
            </button>
          )}
        </div>
      )}

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
            placeholder={t("grid.filterPlaceholder")}
            className="w-full rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-10 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
          />
        </div>
        {robotTypes.length > 0 && (
          <select
            value={selectedRobot}
            onChange={(e) => setSelectedRobot(e.target.value)}
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
          >
            <option value="all">
              {t("grid.allRobots", { count: datasetsWithLiveTags.length })}
            </option>
            {robotTypes.map((robot) => {
              const count = datasetsWithLiveTags.filter(
                (d) => d.robot_type === robot,
              ).length;
              return (
                <option key={robot} value={robot}>
                  {robot} ({count})
                </option>
              );
            })}
          </select>
        )}
        <div className="inline-flex overflow-hidden rounded-md border border-white/10 text-xs">
          {(
            [
              {
                key: "all",
                label: t("grid.filterAll", {
                  count: datasetsWithLiveTags.length,
                }),
              },
              {
                key: "ok",
                label: t("grid.filterHealthy", { count: healthCounts.ok }),
              },
              {
                key: "issues",
                label: t("grid.filterIssues", { count: healthCounts.issues }),
              },
            ] as { key: HealthFilter; label: string }[]
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setHealthFilter(opt.key)}
              className={`px-3 py-2 transition-colors ${
                healthFilter === opt.key
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Corpus facets. Rendered only where they mean something: a category
          whose datasets carry no bucket has nothing to slice by, and showing
          three dead chip rows there would be worse than showing none. */}
      {facetCounts.unbucketed < datasetsWithLiveTags.length && (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-400">{t("grid.sourceLabel")}</span>
          <div className="inline-flex overflow-hidden rounded-md border border-white/10">
            {(
              [
                { key: "all" as BucketFilter, label: t("grid.sourceAll") },
                ...BUCKET_ORDER.filter(
                  (b) => (facetCounts.buckets[b] ?? 0) > 0,
                ).map((b) => ({
                  key: b as BucketFilter,
                  label: `${t(BUCKET_LABEL_KEYS[b])} ${facetCounts.buckets[b]}`,
                })),
              ] as { key: BucketFilter; label: string }[]
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setBucketFilter(opt.key)}
                className={`px-3 py-2 transition-colors ${
                  bucketFilter === opt.key
                    ? "bg-cyan-500/20 text-cyan-100"
                    : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <span className="ml-2 text-slate-400">{t("grid.dateLabel")}</span>
          <div className="inline-flex overflow-hidden rounded-md border border-white/10">
            <button
              type="button"
              onClick={() => setDateFilter(DATE_FILTER_ALL)}
              className={`px-3 py-2 transition-colors ${
                dateFilter.mode === "all"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
              }`}
            >
              {t("grid.dateAll")}
            </button>
            <button
              type="button"
              onClick={() =>
                setDateFilter((f) =>
                  f.mode === "range" ? f : { ...f, mode: "range" },
                )
              }
              className={`px-3 py-2 transition-colors ${
                dateFilter.mode === "range"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
              }`}
            >
              {t("grid.dateRange")}{" "}
              {dateFilter.mode === "range" ? dateMatchCount : ""}
            </button>
            {/* Its own mode, never a corner of the range: a seventh of the
                corpus has no date evidence at all. Sweeping them into a range
                would misreport them; dropping them with no way to ask would
                hide them. */}
            <button
              type="button"
              onClick={() =>
                setDateFilter({ mode: "unknown", from: "", to: "" })
              }
              className={`px-3 py-2 transition-colors ${
                dateFilter.mode === "unknown"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
              }`}
            >
              {t("grid.dateUnknown", { count: facetCounts.unknown })}
            </button>
          </div>

          {dateFilter.mode === "range" && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1">
              <input
                type="date"
                aria-label={t("grid.dateFrom")}
                value={dateFilter.from}
                min={facetCounts.earliest ?? undefined}
                max={facetCounts.latest ?? undefined}
                onChange={(e) =>
                  setDateFilter((f) => ({ ...f, from: e.target.value }))
                }
                className="bg-transparent text-slate-200 outline-none [color-scheme:dark]"
              />
              <span className="text-slate-500">→</span>
              <input
                type="date"
                aria-label={t("grid.dateTo")}
                value={dateFilter.to}
                min={facetCounts.earliest ?? undefined}
                max={facetCounts.latest ?? undefined}
                onChange={(e) =>
                  setDateFilter((f) => ({ ...f, to: e.target.value }))
                }
                className="bg-transparent text-slate-200 outline-none [color-scheme:dark]"
              />
              {/* Both sides are optional — an empty box means "open on this
                  side", which is what makes "everything since the cutoff"
                  expressible without a second control. */}
              <button
                type="button"
                onClick={() => setDateFilter(DATE_FILTER_AFTER_CUTOFF)}
                title={t("grid.datePresetCutoffHint", { date: CAPTURE_CUTOFF })}
                className="ml-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-300 hover:text-slate-100"
              >
                {t("grid.datePresetCutoff", { date: CAPTURE_CUTOFF })}
              </button>
              <button
                type="button"
                onClick={() =>
                  setDateFilter((f) => ({ ...f, from: "", to: "" }))
                }
                className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
              >
                {t("grid.dateClear")}
              </button>
            </span>
          )}

          {/* A shortcut, not a facet: 538 of 542 datasets share one shape, so a
              dropdown would be single-valued noise. The handful it isolates are
              the half-configured captures. */}
          {facetCounts.anomalies > 0 && (
            <button
              type="button"
              onClick={() => setAnomalyOnly((v) => !v)}
              className={`ml-2 rounded-md border px-3 py-2 transition-colors ${
                anomalyOnly
                  ? "border-amber-400/40 bg-amber-500/20 text-amber-100"
                  : "border-white/10 bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
              }`}
            >
              {t("grid.anomalyOnly", { count: facetCounts.anomalies })}
            </button>
          )}
        </div>
      )}

      <TrashStrip refreshKey={trashVersion} />

      {filtered.length === 0 ? (
        <div className="rounded-md border border-white/10 bg-[var(--surface-1)]/40 p-10 text-center text-slate-400">
          {t("grid.noMatch")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {filtered.map((ds) => {
            const health = describeIntegrity(ds.integrity, t);
            const taskName = getDatasetTaskName(ds.relativePath);
            const borderTone =
              health.tone === "error"
                ? "border-red-500/60 hover:border-red-400"
                : health.tone === "warn"
                  ? "border-amber-500/50 hover:border-amber-400"
                  : "hover:border-cyan-400/40";
            const badgeTone =
              health.tone === "error"
                ? "bg-red-500/90 text-white"
                : health.tone === "warn"
                  ? "bg-amber-500/90 text-slate-900"
                  : "bg-emerald-500/80 text-slate-900";
            return (
              <Link
                key={ds.encodedPath}
                href={buildEpisodeRoute(ds.encodedPath)}
                title={
                  health.tone === "ok"
                    ? ds.relativePath
                    : `${ds.relativePath}\n${health.label}: ${health.reason}`
                }
                data-hover-card
                className={`group panel relative flex h-48 items-end overflow-hidden rounded-md border-2 transition-colors ${borderTone}`}
              >
                {ds.thumbnailVideoUrl ? (
                  <HoverPlayVideo
                    src={ds.thumbnailVideoUrl}
                    className={`absolute left-0 top-0 z-0 h-full w-full object-cover object-center ${
                      health.tone === "ok" ? "" : "opacity-40 grayscale"
                    }`}
                  />
                ) : (
                  <div className="absolute inset-0 z-0 bg-gradient-to-br from-slate-800 to-slate-900" />
                )}
                <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

                {/* Card actions — top-left, only show on card hover */}
                <div className="absolute left-2 top-2 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditingDatasetKey(ds.encodedPath);
                    }}
                    title={t("grid.editTagsTitle")}
                    aria-label={t("grid.editTagsAria", {
                      path: ds.relativePath,
                    })}
                    className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-slate-200 backdrop-blur-sm transition-colors hover:bg-cyan-500/90 hover:text-white"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 4 13.172V16h2.828l7.379-7.379-2.828-2.828z" />
                    </svg>
                    {t("grid.tagsButton")}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDeletingDatasetKey(ds.encodedPath);
                    }}
                    title={t("grid.deleteTitle")}
                    aria-label={t("grid.deleteAria", {
                      path: ds.relativePath,
                    })}
                    className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-slate-200 backdrop-blur-sm transition-colors hover:bg-red-500/90 hover:text-white"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.5 2a1 1 0 00-.95.68L7.2 3.75H4.5a.75.75 0 000 1.5h11a.75.75 0 000-1.5h-2.7l-.35-1.07A1 1 0 0011.5 2h-3zM5.75 6.75h8.5l-.6 8.4A2 2 0 0111.66 17H8.34a2 2 0 01-1.99-1.85l-.6-8.4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t("grid.deleteButton")}
                  </button>
                </div>

                {/* Shape anomaly — sits under the health badge rather than
                    beside it, because the two are independent: a
                    half-configured capture is perfectly healthy on disk, which
                    is exactly why it needs saying out loud. */}
                {ds.facets.shapeAnomaly && (
                  <div className="absolute right-2 top-9 z-20 rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-semibold text-slate-900 shadow">
                    {t("grid.shapeBadge", {
                      dim: ds.facets.stateDim ?? "?",
                      streams: ds.facets.videoStreams,
                    })}
                  </div>
                )}

                {/* Health corner badge — top-right */}
                <div
                  className={`absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow ${badgeTone}`}
                >
                  {health.tone === "ok" ? (
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.704 5.29a1 1 0 010 1.415l-7.07 7.07a1 1 0 01-1.414 0L3.292 8.85a1 1 0 011.415-1.414l3.218 3.218 6.364-6.364a1 1 0 011.415 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.485 2.495a1.75 1.75 0 013.03 0l6.28 10.873A1.75 1.75 0 0116.28 16H3.72a1.75 1.75 0 01-1.515-2.632L8.485 2.495zM10 6a.75.75 0 01.75.75v4a.75.75 0 01-1.5 0v-4A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                  {health.label}
                </div>

                <div className="relative z-20 w-full px-3 py-2.5 text-slate-100">
                  <div
                    className="truncate text-sm font-medium"
                    title={ds.relativePath}
                  >
                    {taskName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-300">
                    {ds.robot_type && (
                      <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-cyan-200">
                        {ds.robot_type}
                      </span>
                    )}
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-slate-200">
                      {ds.codebase_version}
                    </span>
                    <span className="tabular">
                      {t("grid.epCount", { count: ds.total_episodes })}
                    </span>
                    {ds.total_frames > 0 && (
                      <span className="tabular text-slate-400">
                        ·{" "}
                        {t("grid.framesSuffix", {
                          value: formatTotalFrames(ds.total_frames),
                        })}
                      </span>
                    )}
                    {ds.sizeBytes > 0 && (
                      <span
                        className="tabular text-slate-400"
                        title={t("grid.bytesOnDisk", {
                          bytes: ds.sizeBytes.toLocaleString("en-US"),
                        })}
                      >
                        · {formatBytes(ds.sizeBytes)}
                      </span>
                    )}
                  </div>
                  {(ds.tags.task ||
                    ds.tags.scene ||
                    ds.tags.objects.length > 0) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
                      {ds.tags.task && (
                        <span
                          className="rounded bg-violet-500/25 px-1.5 py-0.5 font-medium text-violet-100"
                          title={t("grid.wordTask")}
                        >
                          {ds.tags.task}
                        </span>
                      )}
                      {ds.tags.scene && (
                        <span
                          className="rounded bg-sky-500/20 px-1.5 py-0.5 text-sky-200"
                          title={t("grid.wordScene")}
                        >
                          @{ds.tags.scene}
                        </span>
                      )}
                      {ds.tags.objects.slice(0, 4).map((o) => (
                        <span
                          key={o}
                          className="rounded bg-white/10 px-1.5 py-0.5 text-slate-300"
                          title={t("grid.wordObject")}
                        >
                          {o}
                        </span>
                      ))}
                      {ds.tags.objects.length > 4 && (
                        <span className="text-slate-500">
                          +{ds.tags.objects.length - 4}
                        </span>
                      )}
                    </div>
                  )}
                  {health.tone !== "ok" ? (
                    <div
                      className={`mt-1.5 text-[11px] ${
                        health.tone === "error"
                          ? "text-red-300"
                          : "text-amber-300"
                      }`}
                    >
                      ⚠ {health.reason}
                    </div>
                  ) : ds.total_episodes > 1 ? (
                    <div
                      className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400"
                      onClick={(e) => e.preventDefault()}
                    >
                      <span>{t("grid.open")}</span>
                      <input
                        type="number"
                        min={0}
                        max={ds.total_episodes - 1}
                        placeholder="0"
                        value={episodeOverrides[ds.encodedPath] ?? ""}
                        onChange={(e) => {
                          e.stopPropagation();
                          setEpisodeOverrides((prev) => ({
                            ...prev,
                            [ds.encodedPath]: e.target.value,
                          }));
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            const ep = Math.min(
                              Math.max(0, Number(e.currentTarget.value) || 0),
                              ds.total_episodes - 1,
                            );
                            router.push(buildEpisodeRoute(ds.encodedPath, ep));
                          }
                        }}
                        className="w-14 rounded border border-white/15 bg-black/50 px-1.5 py-0.5 text-center text-[11px] tabular text-slate-100 focus:border-cyan-400 focus:outline-none"
                      />
                      <span className="text-slate-500">
                        / {ds.total_episodes - 1}
                      </span>
                    </div>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {editingDataset && (
        <DatasetTagsEditor
          datasetRelativePath={editingDataset.relativePath}
          encodedPath={editingDataset.encodedPath}
          initialTags={editingDataset.tags}
          onClose={() => setEditingDatasetKey(null)}
          onSaved={(updated) => {
            setTagOverrides((prev) => ({
              ...prev,
              [editingDataset.encodedPath]: updated,
            }));
            setEditingDatasetKey(null);
            router.refresh();
          }}
        />
      )}

      {deletingDataset && (
        <DeleteDatasetDialog
          relativePath={deletingDataset.relativePath}
          encodedPath={deletingDataset.encodedPath}
          episodes={deletingDataset.total_episodes}
          onClose={() => setDeletingDatasetKey(null)}
          onDeleted={() => {
            setTrashedKeys((prev) => [...prev, deletingDataset.encodedPath]);
            setDeletingDatasetKey(null);
            setTrashVersion((v) => v + 1);
            router.refresh();
          }}
        />
      )}
    </main>
  );
}

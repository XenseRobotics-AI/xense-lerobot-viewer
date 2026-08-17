"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { formatCompact, formatEpisodeLength } from "@/utils/corpusStats";
import { formatDelta, type DailyDelta } from "@/utils/corpusHistory";
import {
  buildHomepageDatasetStatistics,
  filterHomepageDatasetStatisticsRows,
  type HomepageDatasetStatisticsRow,
} from "@/utils/homepageDatasetStatistics";

type HomepageDatasetStatisticsProps = {
  datasets: LocalDatasetSummary[];
  delta: DailyDelta;
};

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
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-md border p-3 ${TONE_CLASSES[tone]}`}>
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular text-slate-100">
        {value}
      </div>
      {detail && (
        <div className="mt-1 text-[10px] text-slate-500">{detail}</div>
      )}
    </div>
  );
}

function localStatus(row: HomepageDatasetStatisticsRow) {
  if (row.localStatus === "ok") {
    return {
      label: "Local",
      className: "border-emerald-400/25 bg-emerald-500/10 text-emerald-200",
    };
  }
  if (row.localStatus === "empty") {
    return {
      label: "Empty",
      className: "border-amber-400/25 bg-amber-500/10 text-amber-200",
    };
  }
  return {
    label: "Incomplete",
    className: "border-red-400/25 bg-red-500/10 text-red-200",
  };
}

function checkSummary(row: HomepageDatasetStatisticsRow) {
  if (row.failedChecks > 0) {
    return {
      label: `${row.failedChecks} failed`,
      className: "border-red-400/25 bg-red-500/10 text-red-200",
    };
  }
  if (row.warningChecks > 0) {
    return {
      label: `${row.warningChecks} warning${row.warningChecks === 1 ? "" : "s"}`,
      className: "border-amber-400/25 bg-amber-500/10 text-amber-200",
    };
  }
  return {
    label: `${row.passedChecks} passed`,
    className: "border-emerald-400/25 bg-emerald-500/10 text-emerald-200",
  };
}

function checksTitle(row: HomepageDatasetStatisticsRow): string {
  const details = row.checks.map(
    (check) =>
      `${check.title}: ${check.status.toUpperCase()} — ${check.message}`,
  );
  if (row.skippedChecks > 0) {
    details.push(
      `${row.skippedChecks} check skipped on the homepage; open Workbench for full details.`,
    );
  }
  return details.join("\n");
}

function deltaDetail(delta: DailyDelta): string {
  if (!delta.since) return "No earlier snapshot";
  if (delta.spanDays === 1) return `Since ${delta.since} (1 day)`;
  return `Since ${delta.since}${delta.spanDays ? ` (${delta.spanDays} days)` : ""}`;
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return "0.0";
  return hours.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 3,
  });
}

export default function HomepageDatasetStatistics({
  datasets,
  delta,
}: HomepageDatasetStatisticsProps) {
  const [query, setQuery] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [targetHours, setTargetHours] = useState(10);
  const statistics = useMemo(
    () => buildHomepageDatasetStatistics(datasets),
    [datasets],
  );
  const filteredRows = useMemo(
    () =>
      filterHomepageDatasetStatisticsRows(statistics.rows, query, issuesOnly),
    [statistics.rows, query, issuesOnly],
  );
  const baseline = deltaDetail(delta);
  const completion =
    targetHours > 0
      ? Math.round((delta.total.hours / targetHours) * 100)
      : null;

  return (
    <section
      aria-labelledby="dataset-statistics-title"
      className="mb-8 rounded-lg border border-cyan-400/15 bg-[var(--surface-0)]/60 p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="dataset-statistics-title"
            className="text-sm font-semibold text-cyan-200"
          >
            Dataset statistics
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            Workbench-style corpus totals and lightweight custom checks.
            Existing source cards and browsing remain independent below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[10px] text-slate-500">
            Daily target (h)
            <input
              type="number"
              min={0}
              step={1}
              value={targetHours}
              onChange={(event) =>
                setTargetHours(Math.max(0, Number(event.target.value) || 0))
              }
              className="w-16 rounded border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-right text-xs text-slate-200 focus:border-cyan-400 focus:outline-none"
            />
          </label>
          <div className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-slate-500">
            {statistics.datasets.toLocaleString()} datasets scanned
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <KpiCard
          label="Datasets"
          value={statistics.datasets.toLocaleString()}
        />
        <KpiCard label="Episodes" value={formatCompact(statistics.episodes)} />
        <KpiCard
          label="New episodes"
          value={formatDelta(delta.total.episodes)}
          detail={baseline}
          tone="accent"
        />
        <KpiCard label="Frames" value={formatCompact(statistics.frames)} />
        <KpiCard
          label="Recorded hours"
          value={formatHours(statistics.hours)}
          tone="accent"
        />
        <KpiCard
          label="New hours"
          value={formatDelta(delta.total.hours, " h", 1)}
          detail={baseline}
          tone="accent"
        />
        <KpiCard
          label="Target completion"
          value={completion === null ? "—" : `${completion}%`}
          detail={`${targetHours.toLocaleString()} h daily target`}
          tone={completion !== null && completion >= 100 ? "ok" : "accent"}
        />
        <KpiCard
          label="Issues"
          value={statistics.issues.toLocaleString()}
          tone={statistics.issues > 0 ? "warn" : "ok"}
        />
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Filter dataset statistics</span>
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
            placeholder="Filter by dataset name or robot_type"
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
          Issues only
        </label>
      </div>

      <div className="mt-3 max-h-[34rem] overflow-auto rounded-md border border-white/10">
        <table className="w-full min-w-[980px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-3 py-2.5 font-medium">Dataset</th>
              <th className="px-3 py-2.5 font-medium">robot_type</th>
              <th className="px-3 py-2.5 font-medium">Local</th>
              <th className="px-3 py-2.5 text-right font-medium">Episodes</th>
              <th className="px-3 py-2.5 text-right font-medium">Frames</th>
              <th className="px-3 py-2.5 text-right font-medium">Hours</th>
              <th className="px-3 py-2.5 text-right font-medium">Avg / ep</th>
              <th className="px-3 py-2.5 font-medium">Checks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredRows.map((row) => {
              const local = localStatus(row);
              const check = checkSummary(row);
              return (
                <tr key={row.encodedPath} className="hover:bg-white/[0.025]">
                  <td className="max-w-[24rem] px-3 py-2.5">
                    <Link
                      href={`/_local/${row.encodedPath}/episode_0`}
                      className="block truncate font-medium text-slate-200 hover:text-cyan-200"
                      title={`Open ${row.name}`}
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">
                    {row.robotType ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${local.className}`}
                    >
                      {local.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular text-slate-300">
                    {row.episodes.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular text-slate-300">
                    {row.frames.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular text-slate-300">
                    {formatHours(row.hours)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular text-slate-300">
                    {formatEpisodeLength(row.averageEpisodeSeconds)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      title={checksTitle(row)}
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${check.className}`}
                    >
                      {check.label}
                      {row.skippedChecks > 0 && (
                        <span className="ml-1 text-slate-400">
                          · {row.skippedChecks} skipped
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredRows.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-slate-500">
            No datasets match the current filters.
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-slate-500">
        <span>
          Showing {filteredRows.length.toLocaleString()} of{" "}
          {statistics.datasets.toLocaleString()} datasets
        </span>
        <span>
          Prompt checks are loaded on demand in each dataset&apos;s Workbench
          tab.
        </span>
      </div>
    </section>
  );
}

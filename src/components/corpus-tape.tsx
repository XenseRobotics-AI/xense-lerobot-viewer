"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { DatasetGroup } from "@/utils/datasetGrouping";
import {
  computeCorpusStats,
  formatCompact,
  formatEpisodeLength,
  formatHours,
  formatHoursValue,
  tapeColor,
  tapeWidths,
} from "@/utils/corpusStats";
import { formatBytes } from "@/utils/byteSize";
import { useT } from "@/context/locale-context";

type OverallCounts = { ok: number; empty: number; incomplete: number };

type CorpusTapeProps = {
  groups: DatasetGroup[];
  overall: OverallCounts;
  onSelectSource: (prefix: string) => void;
};

/**
 * Corpus summary for the homepage: one headline duration and a proportional
 * tape of where that duration comes from.
 *
 * The tape is measured in recorded hours rather than episode count, because the
 * two rank differently — a source can hold thousands of short episodes and a
 * sliver of footage. Showing both side by side is the point: the bar is
 * duration, the legend is episodes, and the gap between them is a real property
 * of the corpus that a row of separate totals cannot express.
 *
 * Segments are buttons, not decoration — clicking one filters the dataset
 * list below to that source.
 */
export default function CorpusTape({
  groups,
  overall,
  onSelectSource,
}: CorpusTapeProps) {
  const t = useT();
  const stats = useMemo(() => computeCorpusStats(groups), [groups]);
  const widths = useMemo(() => tapeWidths(stats.segments), [stats.segments]);
  const [hovered, setHovered] = useState<string | null>(null);

  // Segments grow from zero on first paint. Gated on a mount flag so the
  // server-rendered HTML starts collapsed and the transition actually runs.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (stats.segments.length === 0) return null;

  const headline = formatHours(stats.totalHours);
  const active = stats.segments.find((s) => s.prefix === hovered) ?? null;

  return (
    // Panel chrome (border, padding, spacing) belongs to the dashboard tab
    // container this renders inside; keep this component to its content.
    <div aria-label={t("tape.aria")}>
      {/* Headline duration + secondary totals. The figure is the only large
          type on the page; everything beside it stays at caption scale. */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-faint)]">
            {t("tape.recorded")}
          </p>
          <p className="mt-1.5 flex items-baseline gap-1.5">
            <span className="tabular text-[clamp(2.6rem,7vw,3.6rem)] font-semibold leading-[0.85] tracking-[-0.035em] text-[var(--text-primary)]">
              {headline.value}
            </span>
            <span className="text-lg font-medium text-[var(--text-muted)]">
              {headline.unit}
            </span>
          </p>
        </div>

        {/* 2×2 on narrow screens so a lone fourth item doesn't orphan onto its
            own row; a single flex row once there's width for it. */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:items-end sm:gap-x-8">
          {[
            {
              key: "episodes",
              label: t("common.episodes"),
              value: formatCompact(stats.totalEpisodes),
            },
            {
              key: "frames",
              label: t("common.frames"),
              value: formatCompact(stats.totalFrames),
            },
            {
              key: "tasks",
              label: t("common.tasks"),
              value: formatCompact(stats.totalTasks),
            },
            {
              key: "sources",
              label: t("tape.sources"),
              value: String(stats.segments.length),
            },
            {
              key: "storage",
              label: t("common.storage"),
              value: formatBytes(stats.totalBytes),
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

      {/* The tape. Width encodes share of recorded hours. Bands wide enough to
          hold text label themselves, so the bar is readable without the legend. */}
      <div className="mt-5 flex h-9 w-full gap-[2px]">
        {stats.segments.map((segment, i) => {
          const dim = hovered !== null && hovered !== segment.prefix;
          const roomForLabel = widths[i] >= 14;
          return (
            <button
              key={segment.prefix}
              type="button"
              onClick={() => onSelectSource(segment.prefix)}
              onMouseEnter={() => setHovered(segment.prefix)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(segment.prefix)}
              onBlur={() => setHovered(null)}
              title={t("tape.bandTitle", {
                prefix: segment.prefix,
                hours: formatHoursValue(segment.hours),
                total: `${headline.value}${headline.unit}`,
              })}
              aria-label={t("tape.bandAria", {
                prefix: segment.prefix,
                hours: formatHoursValue(segment.hours),
                episodes: segment.episodes,
                tasks: segment.tasks,
                bytes: formatBytes(segment.bytes),
              })}
              className="group/band relative h-full overflow-hidden rounded-[3px] transition-[width,opacity] duration-700 ease-out first:rounded-l-md last:rounded-r-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] motion-reduce:transition-none"
              style={{
                width: revealed ? `${widths[i]}%` : "0%",
                background: tapeColor(i),
                opacity: dim ? 0.28 : 1,
                transitionDelay: revealed ? `${i * 70}ms` : "0ms",
              }}
            >
              {roomForLabel && (
                <span className="pointer-events-none absolute inset-0 flex items-center gap-1.5 px-2.5 text-left text-[11px] font-medium text-slate-950/85">
                  <span className="truncate">{segment.prefix}</span>
                  <span className="tabular shrink-0 text-slate-950/60">
                    {formatHoursValue(segment.hours)} h
                  </span>
                </span>
              )}
              <span className="pointer-events-none absolute inset-0 bg-white/0 transition-colors group-hover/band:bg-white/15" />
            </button>
          );
        })}
      </div>

      {/* Legend carries what the bar cannot: episode count and mean episode
          length. A source can hold the most episodes and the least footage —
          the two columns next to each other are where that shows up. */}
      <ul className="mt-3.5 flex flex-wrap items-center gap-x-6 gap-y-2">
        {stats.segments.map((segment, i) => {
          const dim = hovered !== null && hovered !== segment.prefix;
          return (
            <li
              key={segment.prefix}
              className="flex items-baseline gap-1.5 text-xs transition-opacity duration-200"
              style={{ opacity: dim ? 0.4 : 1 }}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full"
                style={{ background: tapeColor(i) }}
              />
              <span className="font-medium text-[var(--text-primary)]">
                {segment.prefix}
              </span>
              <span className="tabular text-[var(--text-muted)]">
                {t("tape.epSuffix", {
                  value: formatCompact(segment.episodes),
                })}
              </span>
              <span className="tabular text-[var(--text-faint)]">
                {t("tape.perEp", {
                  value: formatEpisodeLength(segment.avgEpisodeSeconds),
                })}
              </span>
              <span className="tabular text-[var(--text-faint)]">
                {formatBytes(segment.bytes)}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Health strip. Reserved status colours; only non-zero states appear. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/5 pt-3.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-emerald-300/90">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="tabular">{overall.ok}</span> {t("common.healthy")}
        </span>
        {overall.incomplete > 0 && (
          <span className="inline-flex items-center gap-1.5 text-red-300/90">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            <span className="tabular">{overall.incomplete}</span>{" "}
            {t("common.incomplete")}
          </span>
        )}
        {overall.empty > 0 && (
          <span className="inline-flex items-center gap-1.5 text-amber-300/90">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="tabular">{overall.empty}</span> {t("common.empty")}
          </span>
        )}
        <span
          aria-live="polite"
          className="ml-auto text-[var(--text-faint)] tabular"
        >
          {active
            ? t("tape.activeSummary", {
                prefix: active.prefix,
                tasks: active.tasks,
                percent: Math.round(active.share * 100),
              })
            : t("tape.hint")}
        </span>
      </div>
    </div>
  );
}

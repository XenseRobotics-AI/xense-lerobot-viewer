"use client";

import { useMemo, useState } from "react";
import type {
  DatasetDisplayInfo,
  EpisodeLengthHistogramBin,
  EpisodeLengthInfo,
  EpisodeLengthStats,
  CameraInfo,
} from "@/types/episode-data";
import { copyTextToClipboard } from "@/utils/clipboard";
import { getDisplayNameForRepoId } from "@/utils/datasetRoute";
import {
  assignEpisodesToBins,
  type HistogramBinning,
} from "@/utils/episodeLengthHistogram";
import { useLocale } from "@/context/locale-context";

interface StatsPanelProps {
  datasetInfo: DatasetDisplayInfo;
  episodeLengthStats: EpisodeLengthStats | null;
  loading: boolean;
}

function formatTotalTime(totalFrames: number, fps: number): string {
  const totalSec = totalFrames / fps;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** SVG bar chart for the episode-length histogram */
export function EpisodeLengthHistogram({
  data,
  episodes,
  binning,
}: {
  data: EpisodeLengthHistogramBin[];
  episodes: EpisodeLengthInfo[];
  binning: HistogramBinning;
}) {
  const { t, tp } = useLocale();
  const [activeBinIndex, setActiveBinIndex] = useState(() =>
    Math.max(
      0,
      data.findIndex((bin) => bin.count > 0),
    ),
  );
  const [copiedBinIndex, setCopiedBinIndex] = useState<number | null>(null);
  // Per-bin membership is derived here rather than shipped from the server —
  // `episodes` already carries every index, so sending them per bin too would
  // put the same integers on the wire twice.
  const binEpisodeIndices = useMemo(
    () => assignEpisodesToBins(episodes, binning),
    [episodes, binning],
  );

  if (data.length === 0) return null;
  const maxCount = Math.max(...data.map((d) => d.count));
  if (maxCount === 0) return null;

  const activeBin = data[activeBinIndex] ?? data[0];
  const activeEpisodeIndices = binEpisodeIndices[activeBinIndex] ?? [];
  const copyActiveEpisodeIds = async () => {
    if (activeEpisodeIndices.length === 0) return;
    const copied = await copyTextToClipboard(activeEpisodeIndices.join(", "));
    if (copied) {
      setCopiedBinIndex(activeBinIndex);
      window.setTimeout(() => setCopiedBinIndex(null), 1500);
    } else {
      setCopiedBinIndex(null);
    }
  };

  const totalWidth = 560;
  const gap = Math.max(1, Math.min(3, Math.floor(60 / data.length)));
  const barWidth = Math.max(
    4,
    Math.floor((totalWidth - gap * data.length) / data.length),
  );
  const chartHeight = 150;
  const labelHeight = 30;
  const topPad = 16;
  const svgWidth = data.length * (barWidth + gap);
  const labelStep = Math.max(1, Math.ceil(data.length / 10));

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg
          width={svgWidth}
          height={topPad + chartHeight + labelHeight}
          className="block"
          aria-label={t("stats.histogramAria")}
        >
          {data.map((bin, i) => {
            const barH = Math.max(1, (bin.count / maxCount) * chartHeight);
            const x = i * (barWidth + gap);
            const y = topPad + chartHeight - barH;
            const isActive = i === activeBinIndex;
            const episodeIndices = binEpisodeIndices[i] ?? [];
            const titleIndices = episodeIndices.slice(0, 20).join(", ");
            const remainingIndices = Math.max(0, episodeIndices.length - 20);
            return (
              <g
                key={i}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                aria-label={tp("stats.binLabelCount", bin.count, {
                  label: bin.binLabel,
                })}
                className="cursor-pointer outline-none"
                onMouseEnter={() => setActiveBinIndex(i)}
                onFocus={() => setActiveBinIndex(i)}
                onClick={() => setActiveBinIndex(i)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveBinIndex(i);
                  }
                }}
              >
                <title>
                  {tp("stats.binLabelCount", bin.count, {
                    label: bin.binLabel,
                  })}
                  {bin.count > 0 &&
                    `\n${t("stats.binIndices", { indices: titleIndices })}${
                      remainingIndices > 0
                        ? t("stats.binMore", { count: remainingIndices })
                        : ""
                    }`}
                </title>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barH}
                  className={`${isActive ? "fill-orange-400" : "fill-orange-500/80 hover:fill-orange-400"} transition-colors`}
                  stroke={isActive ? "#fed7aa" : "transparent"}
                  strokeWidth={1}
                  rx={Math.min(2, barWidth / 4)}
                />
                {bin.count > 0 && barWidth >= 8 && (
                  <text
                    x={x + barWidth / 2}
                    y={y - 3}
                    textAnchor="middle"
                    className="fill-slate-400 pointer-events-none"
                    fontSize={Math.min(10, barWidth - 1)}
                  >
                    {bin.count}
                  </text>
                )}
              </g>
            );
          })}
          {data.map((bin, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === data.length - 1;
            if (!isFirst && !isLast && idx % labelStep !== 0) return null;
            const label = bin.binLabel.split("–")[0];
            return (
              <text
                key={idx}
                x={idx * (barWidth + gap) + barWidth / 2}
                y={topPad + chartHeight + 14}
                textAnchor="middle"
                className="fill-slate-400"
                fontSize={9}
              >
                {label}s
              </text>
            );
          })}
        </svg>
      </div>

      <div className="rounded-md border border-white/10 bg-[var(--surface-0)]/50 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-medium text-slate-200">
            {activeBin.binLabel}
          </p>
          <div className="flex items-center gap-2">
            <p className="text-xs tabular-nums text-slate-400">
              {tp("stats.episodeCount", activeBin.count)}
            </p>
            {activeEpisodeIndices.length > 0 && (
              <button
                type="button"
                onClick={() => void copyActiveEpisodeIds()}
                title={t("stats.copyIdsTitle", {
                  ids: activeEpisodeIndices.join(", "),
                })}
                aria-label={t("stats.copyIdsAria", {
                  label: activeBin.binLabel,
                })}
                className="inline-flex items-center gap-1 rounded border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[11px] font-medium text-cyan-300 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/15"
              >
                {copiedBinIndex === activeBinIndex ? (
                  <>
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-3 w-3"
                      aria-hidden
                    >
                      <path d="m7.5 13.5-3-3L3 12l4.5 4.5L17 7l-1.5-1.5z" />
                    </svg>
                    {t("stats.copiedIds")}
                  </>
                ) : (
                  <>
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-3 w-3"
                      aria-hidden
                    >
                      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
                      <path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
                    </svg>
                    {t("stats.copyIds")}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-[11px] uppercase tracking-wide text-slate-500">
          {t("stats.episodeIndices")}
        </p>
        <p className="mt-1 max-h-24 overflow-y-auto break-words font-mono text-xs leading-5 text-slate-300 select-all">
          {activeEpisodeIndices.length > 0
            ? activeEpisodeIndices
                .map((index) => t("common.epShort", { index }))
                .join(", ")
            : t("stats.none")}
        </p>
      </div>
      <p className="text-[11px] text-slate-500">{t("stats.hint")}</p>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-4 border border-white/10">
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
    </div>
  );
}

function StatsPanel({
  datasetInfo,
  episodeLengthStats,
  loading,
}: StatsPanelProps) {
  const { t, tp } = useLocale();
  const els = episodeLengthStats;
  const datasetDisplayName = getDisplayNameForRepoId(datasetInfo.repoId);

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-8">
      <div>
        <h2 className="text-xl text-slate-100">
          <span className="font-bold">{t("stats.title")}</span>{" "}
          <span className="font-normal text-slate-400">
            {datasetDisplayName}
          </span>
        </h2>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card
          label={t("stats.robotType")}
          value={datasetInfo.robot_type ?? t("stats.unknown")}
        />
        <Card
          label={t("stats.datasetVersion")}
          value={datasetInfo.codebase_version}
        />
        <Card label={t("common.tasks")} value={datasetInfo.total_tasks} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card
          label={t("stats.totalFrames")}
          value={datasetInfo.total_frames.toLocaleString()}
        />
        <Card
          label={t("stats.totalEpisodes")}
          value={datasetInfo.total_episodes.toLocaleString()}
        />
        <Card label="FPS" value={datasetInfo.fps} />
        <Card
          label={t("stats.totalTime")}
          value={formatTotalTime(datasetInfo.total_frames, datasetInfo.fps)}
        />
      </div>

      {/* Camera resolutions */}
      {datasetInfo.cameras.length > 0 && (
        <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10">
          <h3 className="text-sm font-semibold text-slate-200 mb-3">
            {t("stats.cameraResolutions")}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {datasetInfo.cameras.map((cam: CameraInfo) => (
              <div
                key={cam.name}
                className="bg-[var(--surface-0)]/50 rounded-md p-3"
              >
                <p
                  className="text-xs text-slate-400 mb-1 truncate"
                  title={cam.name}
                >
                  {cam.name}
                </p>
                <p className="text-base font-bold tabular-nums">
                  {cam.width}×{cam.height}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading spinner for async stats */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {t("stats.computing")}
        </div>
      )}

      {/* Episode length section */}
      {els && (
        <>
          <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10">
            <h3 className="text-sm font-semibold text-slate-200 mb-4">
              {t("stats.episodeLengths")}
            </h3>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-4 mb-4">
              <Card
                label={t("stats.shortest")}
                value={`${els.shortestEpisodes[0]?.lengthSeconds ?? "–"}s`}
              />
              <Card
                label={t("stats.longest")}
                value={`${els.longestEpisodes[els.longestEpisodes.length - 1]?.lengthSeconds ?? "–"}s`}
              />
              <Card
                label={t("stats.mean")}
                value={`${els.meanEpisodeLength}s`}
              />
              <Card
                label={t("stats.median")}
                value={`${els.medianEpisodeLength}s`}
              />
              <Card label={t("stats.std")} value={`${els.stdEpisodeLength}s`} />
            </div>
          </div>

          {els.episodeLengthHistogram.length > 0 && (
            <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10">
              <h3 className="text-sm font-semibold text-slate-200 mb-4">
                {t("stats.distribution")}
                <span className="text-xs text-slate-500 ml-2 font-normal">
                  {tp("stats.bins", els.episodeLengthHistogram.length)}
                </span>
              </h3>
              <EpisodeLengthHistogram
                data={els.episodeLengthHistogram}
                episodes={els.allEpisodeLengths}
                binning={els.episodeLengthHistogramBinning}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default StatsPanel;

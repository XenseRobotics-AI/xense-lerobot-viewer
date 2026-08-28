"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTimeControls, useTimeState } from "../context/time-context";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { useT } from "@/context/locale-context";
import { hasEpisodePoseTrajectories } from "@/utils/poseTrajectory3d";
import { CHART_CONFIG } from "@/utils/constants";
import { evenlySampleArray } from "@/utils/sampling";

const EpisodePose3DViewer = React.lazy(
  () => import("@/components/episode-pose-3d-viewer"),
);

type ChartRow = Record<string, number | Record<string, number>>;

type DataGraphProps = {
  data: ChartRow[][];
  velocityData?: ChartRow[][];
  /** Flat sampled rows retain the original `source | pose.axis` keys. */
  flatData?: Record<string, number>[];
  /** Dataset capture rate used to advance the 3D playback marker by frame. */
  fps?: number;
  onChartsReady?: () => void;
};

type EpisodeGraphMode = "position" | "velocity" | "threeD";

const SERIES_NAME_DELIMITER = CHART_CONFIG.SERIES_NAME_DELIMITER;
// Episode loaders retain up to 4,000 rows for analysis and 3D playback. An
// SVG chart is only a few hundred CSS pixels wide, so sending all 4,000 rows
// through every Recharts line creates multi-megabyte path strings with no
// visible gain. Keep the source data intact and thin only the render input.
const MAX_SVG_POINTS_PER_GRAPH = 800;

const CHART_COLORS = [
  "#f97316",
  "#3b82f6",
  "#22c55e",
  "#ef4444",
  "#a855f7",
  "#eab308",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
  "#f59e0b",
  "#6366f1",
  "#84cc16",
];

const DIRECTION_COLORS = {
  x: "#ef4444",
  y: "#22c55e",
  z: "#3b82f6",
} as const;

/**
 * The chart itself is intentionally not subscribed to playback time. A
 * Recharts tree can contain thousands of SVG nodes; rebuilding it for every
 * 80ms clock tick made episode switches compete with playback. Keep the
 * playhead as a tiny DOM child that alone follows the clock.
 */
const GraphPlayhead = React.memo(
  ({ minTime, maxTime }: { minTime: number; maxTime: number }) => {
    const { currentTime } = useTimeState();
    const span = maxTime - minTime;
    const ratio =
      span > 0 ? Math.min(1, Math.max(0, (currentTime - minTime) / span)) : 0;

    return (
      <div className="pointer-events-none absolute inset-y-0 left-[55px] right-3 z-10">
        <div
          className="absolute inset-y-0 w-px bg-orange-400/80"
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
    );
  },
);
GraphPlayhead.displayName = "GraphPlayhead";

type VelocityDirection = keyof typeof DIRECTION_COLORS;

function velocitySeriesInfo(key: string): {
  source: string;
  direction: VelocityDirection;
} | null {
  const parts = key.split(SERIES_NAME_DELIMITER);
  const source = parts.length > 1 ? (parts.at(-1) ?? "") : "";
  const descriptor = parts.length > 1 ? parts.slice(0, -1).join(" ") : key;
  const match = /(?:^|[.\s·])(?:v|ω)([xyz])(?:\s|\(|$)/.exec(descriptor);
  if (!match) return null;
  return {
    source,
    direction: match[1] as VelocityDirection,
  };
}

function formatLegendValue(value: number): string {
  const sign = value < 0 ? "-" : "\u2007";
  return `${sign}${Math.abs(value).toFixed(2)}`;
}

function mergeGroups(data: ChartRow[][]): ChartRow[] {
  if (data.length <= 1) return data[0] ?? [];
  const maxLen = Math.max(...data.map((g) => g.length));
  const merged: ChartRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const row: ChartRow = {};
    for (const group of data) {
      const src = group[i];
      if (!src) continue;
      for (const [k, v] of Object.entries(src)) {
        if (k === "timestamp") {
          row[k] = v;
          continue;
        }
        row[k] = v;
      }
    }
    merged.push(row);
  }
  return merged;
}

export const DataRecharts = React.memo(
  ({
    data,
    velocityData = [],
    flatData = [],
    fps,
    onChartsReady,
  }: DataGraphProps) => {
    const t = useT();
    const [hoveredTime, setHoveredTime] = useState<number | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [mode, setMode] = useState<EpisodeGraphMode>("position");
    const hasVelocityData = velocityData.length > 0;
    const hasThreeDData = useMemo(
      () => flatData.length > 0 && hasEpisodePoseTrajectories(flatData),
      [flatData],
    );
    const activeData = mode === "velocity" ? velocityData : data;

    useEffect(() => {
      if (typeof onChartsReady === "function") onChartsReady();
    }, [onChartsReady]);

    useEffect(() => {
      if (mode === "velocity" && !hasVelocityData) setMode("position");
      if (mode === "threeD" && !hasThreeDData) setMode("position");
    }, [hasThreeDData, hasVelocityData, mode]);

    const combinedData = useMemo(
      () => (expanded ? mergeGroups(activeData) : []),
      [activeData, expanded],
    );

    if (!Array.isArray(data) || data.length === 0) return null;

    const selectMode = (nextMode: EpisodeGraphMode) => {
      if (nextMode === "velocity" && !hasVelocityData) return;
      if (nextMode === "threeD" && !hasThreeDData) return;
      setMode(nextMode);
      setExpanded(false);
      setHoveredTime(null);
    };

    return (
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div
            className="inline-flex rounded-md border border-white/10 bg-[var(--surface-1)]/60 p-0.5"
            role="tablist"
            aria-label={t("chart.aria")}
          >
            {(["position", "velocity", "threeD"] as const).map((option) => {
              const active = mode === option;
              const disabled =
                (option === "velocity" && !hasVelocityData) ||
                (option === "threeD" && !hasThreeDData);
              return (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={disabled}
                  title={disabled ? t("chart.noPose") : undefined}
                  onClick={() => selectMode(option)}
                  className={`rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? "bg-cyan-400/15 text-cyan-200"
                      : "text-slate-500 hover:text-slate-200"
                  }`}
                >
                  {option === "position"
                    ? t("chart.position")
                    : option === "velocity"
                      ? t("chart.velocity")
                      : t("chart.threeD")}
                </button>
              );
            })}
          </div>

          {mode !== "threeD" && activeData.length > 1 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1.5 ${
                expanded
                  ? "bg-cyan-400/15 text-cyan-300 border border-cyan-400/40"
                  : "bg-[var(--surface-1)]/60 text-slate-400 hover:text-slate-200 border border-white/10/50"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {expanded ? (
                  <>
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </>
                ) : (
                  <>
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </>
                )}
              </svg>
              {expanded ? t("chart.split") : t("chart.combine")}
            </button>
          )}
        </div>

        {mode === "threeD" ? (
          <React.Suspense
            fallback={
              <div className="flex h-40 items-center justify-center rounded-lg border border-white/10 bg-[var(--surface-1)]/40 text-sm text-slate-500">
                {t("chart.threeDLoading")}
              </div>
            }
          >
            <EpisodePose3DViewer rows={flatData} fps={fps} />
          </React.Suspense>
        ) : expanded ? (
          <SingleDataGraph
            data={combinedData}
            hoveredTime={hoveredTime}
            setHoveredTime={setHoveredTime}
            tall
          />
        ) : (
          <div className="grid md:grid-cols-2 grid-cols-1 gap-4">
            {activeData.map((group, idx) => (
              <SingleDataGraph
                key={`${mode}-${idx}`}
                data={group}
                hoveredTime={hoveredTime}
                setHoveredTime={setHoveredTime}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);

const SingleDataGraph = React.memo(
  ({
    data,
    hoveredTime,
    setHoveredTime,
    tall,
  }: {
    data: ChartRow[];
    hoveredTime: number | null;
    setHoveredTime: (t: number | null) => void;
    tall?: boolean;
  }) => {
    const { seek } = useTimeControls();
    const flattenRow = useCallback(
      (row: Record<string, number | Record<string, number>>, prefix = "") => {
        const result: Record<string, number> = {};
        for (const [key, value] of Object.entries(row)) {
          // Special case: if this is a group value that is a primitive, assign to prefix.key
          if (typeof value === "number") {
            if (prefix) {
              result[`${prefix}${SERIES_NAME_DELIMITER}${key}`] = value;
            } else {
              result[key] = value;
            }
          } else if (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            // If it's an object, recurse
            Object.assign(
              result,
              flattenRow(
                value,
                prefix ? `${prefix}${SERIES_NAME_DELIMITER}${key}` : key,
              ),
            );
          }
        }
        if ("timestamp" in row && typeof row["timestamp"] === "number") {
          result["timestamp"] = row["timestamp"];
        }
        return result;
      },
      [],
    );

    // Flatten all rows for recharts
    const chartData = useMemo(
      () =>
        evenlySampleArray(data, MAX_SVG_POINTS_PER_GRAPH).map((row) =>
          flattenRow(row),
        ),
      [data, flattenRow],
    );

    // dataKeys is purely derived from chartData — compute it during render,
    // not via a useState + useEffect that would force an extra render and
    // briefly leak the previous chart's keys after `data` changes.
    // Vercel rule: rerender-derived-state-no-effect.
    const dataKeys = useMemo(() => {
      const first = chartData[0];
      if (!first) return [];
      return Object.keys(first).filter((k) => k !== "timestamp");
    }, [chartData]);

    // visibleKeys IS user-facing state (column toggles). Reset it whenever
    // the underlying schema changes — keying off the joined dataKeys string
    // catches both episode navigations and combine/split toggles.
    const dataKeysSig = dataKeys.join("|");
    const [visibleKeys, setVisibleKeys] = useState<string[]>(dataKeys);
    const lastSigRef = useRef(dataKeysSig);
    if (lastSigRef.current !== dataKeysSig) {
      lastSigRef.current = dataKeysSig;
      // Setting state during render is fine here — React schedules a
      // re-render and discards the in-progress one. This pattern is
      // documented as "Storing information from previous renders".
      setVisibleKeys(dataKeys);
    }

    const { groups, singles, groupColorMap, seriesColorMap } = useMemo(() => {
      const grouped: Record<string, string[]> = {};
      const singleList: string[] = [];
      dataKeys.forEach((key) => {
        const parts = key.split(SERIES_NAME_DELIMITER);
        if (parts.length > 1) {
          const group = parts[0];
          if (!grouped[group]) grouped[group] = [];
          grouped[group].push(key);
        } else {
          singleList.push(key);
        }
      });

      const allGroups = [...Object.keys(grouped), ...singleList];
      const colorMap: Record<string, string> = {};
      allGroups.forEach((group, idx) => {
        const velocity = velocitySeriesInfo(group);
        colorMap[group] = velocity
          ? DIRECTION_COLORS[velocity.direction]
          : CHART_COLORS[idx % CHART_COLORS.length];
      });
      const seriesColors: Record<string, string> = {};
      dataKeys.forEach((key) => {
        const group = key.includes(SERIES_NAME_DELIMITER)
          ? key.split(SERIES_NAME_DELIMITER)[0]
          : key;
        const velocity = velocitySeriesInfo(key);
        seriesColors[key] = velocity
          ? DIRECTION_COLORS[velocity.direction]
          : colorMap[group];
      });
      return {
        groups: grouped,
        singles: singleList,
        groupColorMap: colorMap,
        seriesColorMap: seriesColors,
      };
    }, [dataKeys]);

    // Find the closest data point to the current time for highlighting
    const findClosestDataIndex = (time: number) => {
      if (!chartData.length) return 0;
      // Find the index of the first data point whose timestamp is >= time (ceiling)
      const idx = chartData.findIndex((point) => point.timestamp >= time);
      if (idx !== -1) return idx;
      // If all timestamps are less than time, return the last index
      return chartData.length - 1;
    };

    const handleMouseLeave = () => {
      setHoveredTime(null);
    };

    const handleClick = (
      data: { activePayload?: { payload: { timestamp: number } }[] } | null,
    ) => {
      if (data?.activePayload?.length) {
        seek(data.activePayload[0].payload.timestamp);
      }
    };

    // Custom legend to show current value next to each series
    const CustomLegend = () => {
      const { currentTime } = useTimeState();
      const closestIndex = findClosestDataIndex(
        hoveredTime != null ? hoveredTime : currentTime,
      );
      const currentData = chartData[closestIndex] || {};

      const isGroupChecked = (group: string) =>
        groups[group].every((k) => visibleKeys.includes(k));
      const isGroupIndeterminate = (group: string) =>
        groups[group].some((k) => visibleKeys.includes(k)) &&
        !isGroupChecked(group);

      const handleGroupCheckboxChange = (group: string) => {
        if (isGroupChecked(group)) {
          // Uncheck all children
          setVisibleKeys((prev) =>
            prev.filter((k) => !groups[group].includes(k)),
          );
        } else {
          // Check all children
          setVisibleKeys((prev) =>
            Array.from(new Set([...prev, ...groups[group]])),
          );
        }
      };

      const handleCheckboxChange = (key: string) => {
        setVisibleKeys((prev) =>
          prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
        );
      };

      return (
        <div className="flex flex-wrap gap-x-5 gap-y-2 px-1 pt-2">
          {Object.entries(groups).map(([group, children]) => {
            const color = groupColorMap[group];
            return (
              <div key={group}>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isGroupChecked(group)}
                    ref={(el) => {
                      if (el) el.indeterminate = isGroupIndeterminate(group);
                    }}
                    onChange={() => handleGroupCheckboxChange(group)}
                    className="size-3"
                    style={{ accentColor: color }}
                  />
                  <span className="text-xs font-semibold text-slate-200">
                    {group}
                  </span>
                </label>
                <div className="pl-5 flex flex-col gap-0.5 mt-0.5">
                  {children.map((key) => {
                    const label = key.split(SERIES_NAME_DELIMITER).pop() ?? key;
                    const seriesColor = seriesColorMap[key];
                    return (
                      <label
                        key={key}
                        className="flex items-center gap-1.5 cursor-pointer select-none"
                      >
                        <input
                          type="checkbox"
                          checked={visibleKeys.includes(key)}
                          onChange={() => handleCheckboxChange(key)}
                          className="size-2.5"
                          style={{ accentColor: seriesColor }}
                        />
                        <span
                          className={`text-xs ${visibleKeys.includes(key) ? "text-slate-300" : "text-slate-500"}`}
                        >
                          {label}
                        </span>
                        <span
                          className={`ml-1 whitespace-pre font-mono text-xs tabular-nums ${visibleKeys.includes(key) ? "text-cyan-200/80" : "text-slate-600"}`}
                        >
                          {typeof currentData[key] === "number"
                            ? formatLegendValue(currentData[key])
                            : "–"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {singles.map((key) => {
            const color = seriesColorMap[key];
            return (
              <label
                key={key}
                className="flex items-center gap-1.5 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={visibleKeys.includes(key)}
                  onChange={() => handleCheckboxChange(key)}
                  className="size-3"
                  style={{ accentColor: color }}
                />
                <span
                  className={`text-xs ${visibleKeys.includes(key) ? "text-slate-200" : "text-slate-500"}`}
                >
                  {key}
                </span>
                <span
                  className={`ml-1 whitespace-pre font-mono text-xs tabular-nums ${visibleKeys.includes(key) ? "text-cyan-200/80" : "text-slate-600"}`}
                >
                  {typeof currentData[key] === "number"
                    ? formatLegendValue(currentData[key])
                    : "–"}
                </span>
              </label>
            );
          })}
        </div>
      );
    };

    // Derive chart title from the grouped feature names
    const chartTitle = useMemo(() => {
      const featureNames = Object.keys(groups);
      if (featureNames.length > 0) {
        const suffixes = featureNames.map((g) => {
          const parts = g.split(SERIES_NAME_DELIMITER);
          return parts[parts.length - 1];
        });
        return suffixes.join(", ");
      }
      return singles.join(", ");
    }, [groups, singles]);

    return (
      <div className="w-full bg-[var(--surface-1)]/40 rounded-lg border border-white/10/50 p-3">
        {chartTitle && (
          <p
            className="text-xs font-medium text-slate-300 mb-1 px-1 truncate"
            title={chartTitle}
          >
            {chartTitle}
          </p>
        )}
        <div
          className={`relative w-full ${tall ? "h-[500px]" : "h-72"}`}
          onMouseLeave={handleMouseLeave}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              syncId="episode-sync"
              margin={{ top: 12, right: 12, left: -8, bottom: 8 }}
              onClick={handleClick}
              onMouseMove={(state) => {
                const payload = state?.activePayload?.[0]?.payload as
                  | { timestamp?: number }
                  | undefined;
                setHoveredTime(payload?.timestamp ?? null);
              }}
              onMouseLeave={handleMouseLeave}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#334155"
                strokeOpacity={0.6}
              />
              <XAxis
                dataKey="timestamp"
                domain={[
                  chartData.at(0)?.timestamp ?? 0,
                  chartData.at(-1)?.timestamp ?? 0,
                ]}
                tickFormatter={(v: number) => `${v.toFixed(1)}s`}
                stroke="#64748b"
                tick={{ fontSize: 12, fill: "#94a3b8" }}
                minTickGap={30}
                allowDataOverflow={true}
              />
              <YAxis
                domain={["auto", "auto"]}
                stroke="#64748b"
                tick={{ fontSize: 12, fill: "#94a3b8" }}
                width={55}
                allowDataOverflow={true}
                tickFormatter={(v: number) => {
                  if (v === 0) return "0";
                  const abs = Math.abs(v);
                  if (abs < 0.01 || abs >= 10000) return v.toExponential(1);
                  return Number(v.toFixed(2)).toString();
                }}
              />

              <Tooltip
                content={() => null}
                active={true}
                isAnimationActive={false}
              />

              {dataKeys.map((key) => {
                const group = key.includes(SERIES_NAME_DELIMITER)
                  ? key.split(SERIES_NAME_DELIMITER)[0]
                  : key;
                const color = seriesColorMap[key];
                let strokeDasharray: string | undefined = undefined;
                const velocity = velocitySeriesInfo(key);
                if (velocity) {
                  if (velocity.source !== "action") strokeDasharray = "5 5";
                } else if (groups[group] && groups[group].length > 1) {
                  const idxInGroup = groups[group].indexOf(key);
                  if (idxInGroup > 0) strokeDasharray = "5 5";
                }
                return (
                  visibleKeys.includes(key) && (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={key}
                      stroke={color}
                      strokeDasharray={strokeDasharray}
                      dot={false}
                      activeDot={false}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                  )
                );
              })}
            </LineChart>
          </ResponsiveContainer>
          <GraphPlayhead
            minTime={chartData.at(0)?.timestamp ?? 0}
            maxTime={chartData.at(-1)?.timestamp ?? 0}
          />
        </div>
        <CustomLegend />
      </div>
    );
  },
); // End React.memo

SingleDataGraph.displayName = "SingleDataGraph";
DataRecharts.displayName = "DataGraph";
export default DataRecharts;

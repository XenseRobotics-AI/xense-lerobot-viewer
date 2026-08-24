"use client";

import React, { useMemo, useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import { CHART_CONFIG } from "@/utils/constants";
import type {
  CrossEpisodeVarianceData,
  AggVelocityStat,
  AggAutocorrelation,
  SpeedDistEntry,
  JerkyEpisode,
  AggAlignment,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { useLocale, useT } from "@/context/locale-context";
import SpatialTrajectoryViewer from "@/components/spatial-trajectory-viewer";

const FullscreenCtx = React.createContext(false);
const useIsFullscreen = () => React.useContext(FullscreenCtx);

function InfoToggle({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-0.5 rounded-full text-slate-500 hover:text-slate-300 transition-colors shrink-0"
        title={t("insights.toggleDesc")}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </>
  );
}

function FullscreenWrapper({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [fs, setFs] = useState(false);

  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFs(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fs]);

  return (
    <div className="relative">
      <button
        onClick={() => setFs((v) => !v)}
        className="absolute top-3 right-3 z-10 p-1.5 rounded bg-white/5/60 hover:bg-white/5 text-slate-400 hover:text-slate-200 transition-colors backdrop-blur-sm"
        title={fs ? t("insights.exitFullscreen") : t("insights.fullscreen")}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {fs ? (
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
      </button>
      {fs ? (
        <div className="fixed inset-0 z-50 bg-[var(--bg)]/95 overflow-auto p-6">
          <button
            onClick={() => setFs(false)}
            className="fixed top-4 right-4 z-50 p-2 rounded bg-white/5/80 hover:bg-white/5 text-slate-300 hover:text-white transition-colors"
            title={t("insights.exitFullscreenEsc")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <div className="max-w-7xl mx-auto">
            <FullscreenCtx.Provider value={true}>
              {children}
            </FullscreenCtx.Provider>
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function FlagBtn({ id }: { id: number }) {
  const t = useT();
  const { has, toggle } = useFlaggedEpisodes();
  const flagged = has(id);
  return (
    <button
      onClick={() => toggle(id)}
      title={flagged ? t("common.unflagEpisode") : t("common.flagForReview")}
      className={`p-0.5 rounded transition-colors ${flagged ? "text-cyan-300" : "text-slate-600 hover:text-slate-400"}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill={flagged ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    </button>
  );
}

function FlagAllBtn({ ids, label }: { ids: number[]; label?: string }) {
  const t = useT();
  const { addMany } = useFlaggedEpisodes();
  return (
    <button
      onClick={() => addMany(ids)}
      className="text-xs text-slate-500 hover:text-cyan-300 transition-colors flex items-center gap-1"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
      {label ?? t("filter.flagAll")}
    </button>
  );
}
const COLORS = [
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

function shortName(key: string): string {
  const parts = key.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
  return parts.length > 1 ? parts[parts.length - 1] : key;
}

function getActionKeys(row: Record<string, number>): string[] {
  return Object.keys(row)
    .filter((k) => k.startsWith("action") && k !== "timestamp")
    .sort();
}

function getStateKeys(row: Record<string, number>): string[] {
  return Object.keys(row)
    .filter(
      (k) =>
        k.includes("state") && k !== "timestamp" && !k.startsWith("action"),
    )
    .sort();
}

// ─── Autocorrelation ─────────────────────────────────────────────

function computeAutocorrelation(values: number[], maxLag: number): number[] {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const centered = values.map((v) => v - mean);
  const variance = centered.reduce((a, v) => a + v * v, 0);
  if (variance === 0) return Array(maxLag).fill(0);

  const result: number[] = [];
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let t = 0; t < n - lag; t++) sum += centered[t] * centered[t + lag];
    result.push(sum / variance);
  }
  return result;
}

function findDecorrelationLag(acf: number[], threshold = 0.5): number | null {
  const idx = acf.findIndex((v) => v < threshold);
  return idx >= 0 ? idx + 1 : null;
}

function AutocorrelationSection({
  data,
  fps,
  agg,
  numEpisodes,
}: {
  data: Record<string, number>[];
  fps: number;
  agg?: AggAutocorrelation | null;
  numEpisodes?: number;
}) {
  const { t, tRich } = useLocale();
  const isFs = useIsFullscreen();
  const actionKeys = useMemo(
    () => (data.length > 0 ? getActionKeys(data[0]) : []),
    [data],
  );
  const maxLag = useMemo(
    () => Math.min(Math.floor(data.length / 2), 100),
    [data],
  );

  const fallback = useMemo(() => {
    if (agg) return null;
    if (actionKeys.length === 0 || maxLag < 2)
      return { chartData: [], suggestedChunk: null, shortKeys: [] as string[] };

    const acfs = actionKeys.map((key) => {
      const values = data.map((row) => row[key] ?? 0);
      return computeAutocorrelation(values, maxLag);
    });

    const rows = Array.from({ length: maxLag }, (_, lag) => {
      const row: Record<string, number> = {
        lag: lag + 1,
        time: (lag + 1) / fps,
      };
      actionKeys.forEach((key, ki) => {
        row[shortName(key)] = acfs[ki][lag];
      });
      return row;
    });

    const lags = acfs
      .map((acf) => findDecorrelationLag(acf, 0.5))
      .filter(Boolean) as number[];
    const suggested =
      lags.length > 0
        ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)]
        : null;

    return {
      chartData: rows,
      suggestedChunk: suggested,
      shortKeys: actionKeys.map(shortName),
    };
  }, [data, actionKeys, maxLag, fps, agg]);

  const { chartData, suggestedChunk, shortKeys } = agg ??
    fallback ?? { chartData: [], suggestedChunk: null, shortKeys: [] };
  const isAgg = !!agg;
  const numEpisodesLabel = isAgg
    ? ` (${t("insights.scopeSampled", { count: numEpisodes ?? 0 })})`
    : ` (${t("insights.scopeCurrent")})`;

  const yDomain = useMemo(() => {
    if (chartData.length === 0 || shortKeys.length === 0)
      return [-0.2, 1] as [number, number];
    let min = Infinity;
    for (const row of chartData)
      for (const k of shortKeys) {
        const v = row[k];
        if (typeof v === "number" && v < min) min = v;
      }
    const lo = Math.floor(Math.min(min, 0) * 10) / 10;
    return [lo, 1] as [number, number];
  }, [chartData, shortKeys]);

  if (shortKeys.length === 0)
    return <p className="text-slate-500 italic">{t("insights.acNoColumns")}</p>;

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            {t("insights.acTitle")}
            <span className="text-xs text-slate-500 ml-2 font-normal">
              {numEpisodesLabel}
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              {tRich("insights.acDesc", {
                boundary: (
                  <span className="text-cyan-300 font-medium">
                    {t("insights.acBoundary")}
                  </span>
                ),
              })}
              <br />
              <span className="text-slate-500">
                {tRich("insights.acTheory", {
                  link: (
                    <a
                      href="https://arxiv.org/abs/2507.09061"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300"
                    >
                      Zhang et al., 2025
                    </a>
                  ),
                })}
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      {suggestedChunk && (
        <div className="flex items-center gap-3 bg-cyan-400/10 border border-cyan-400/30 rounded-md px-4 py-2.5">
          <span className="text-cyan-300 font-bold text-lg tabular-nums">
            {suggestedChunk}
          </span>
          <div>
            <p className="text-sm text-cyan-200 font-medium">
              {t("insights.acSuggested", {
                steps: suggestedChunk,
                seconds: (suggestedChunk / fps).toFixed(2),
              })}
            </p>
            <p className="text-xs text-slate-400">
              {t("insights.acSuggestedDesc")}
            </p>
          </div>
        </div>
      )}

      <div className={isFs ? "h-[500px]" : "h-64"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            key={isAgg ? "agg" : "ep"}
            data={chartData}
            margin={{ top: 8, right: 16, left: 0, bottom: 16 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="lag"
              stroke="#94a3b8"
              label={{
                value: t("insights.lagAxis"),
                position: "insideBottom",
                offset: -8,
                fill: "#94a3b8",
                fontSize: 13,
              }}
            />
            <YAxis
              stroke="#94a3b8"
              domain={yDomain}
              tickFormatter={(v) => Number(v.toFixed(2)).toString()}
            />
            <Tooltip
              contentStyle={{
                background: "#1e293b",
                border: "1px solid #475569",
                borderRadius: 6,
              }}
              labelFormatter={(v) =>
                t("insights.lagTooltip", {
                  lag: String(v),
                  seconds: (Number(v) / fps).toFixed(2),
                })
              }
              formatter={(v: number) => v.toFixed(3)}
            />
            <Line
              dataKey={() => 0.5}
              stroke="#64748b"
              strokeDasharray="6 4"
              dot={false}
              name="0.5 threshold"
              legendType="none"
              isAnimationActive={false}
            />
            {shortKeys.map((name, i) => (
              <Line
                key={name}
                dataKey={name}
                stroke={COLORS[i % COLORS.length]}
                dot={false}
                strokeWidth={1.5}
                legendType="none"
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Custom legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
        {shortKeys.map((name, i) => (
          <div key={name} className="flex items-center gap-1.5">
            <span
              className="w-3 h-[3px] rounded-full shrink-0"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            <span className="text-xs text-slate-400">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Action Velocity ─────────────────────────────────────────────

function ActionVelocitySection({
  data,
  agg,
  numEpisodes,
  jerkyEpisodes,
}: {
  data: Record<string, number>[];
  agg?: AggVelocityStat[];
  numEpisodes?: number;
  jerkyEpisodes?: JerkyEpisode[];
}) {
  const { t, tp, tRich } = useLocale();
  const actionKeys = useMemo(
    () => (data.length > 0 ? getActionKeys(data[0]) : []),
    [data],
  );

  const fallbackStats = useMemo(() => {
    if (agg && agg.length > 0) return null;
    if (actionKeys.length === 0 || data.length < 2) return [];

    const ACTIVITY_THRESHOLD = 0.001; // 0.1% of motor range
    const DISCRETE_THRESHOLD = 4; // ≤ this many unique values → discrete
    return actionKeys.map((key) => {
      const values = data.map((row) => row[key] ?? 0);
      const motorMin = Math.min(...values);
      const motorMax = Math.max(...values);
      const motorRange = motorMax - motorMin || 1;
      const uniqueVals = new Set(values);
      const nUnique = uniqueVals.size;
      const discrete = nUnique <= DISCRETE_THRESHOLD;
      const deltas = values.slice(1).map((v, i) => v - values[i]);
      if (deltas.length === 0)
        return {
          name: shortName(key),
          std: 0,
          maxAbs: 0,
          bins: new Array(30).fill(0),
          lo: 0,
          hi: 0,
          motorRange,
          discrete,
        };

      // Activity score: p95 of |Δa|
      const absDeltas = deltas.map(Math.abs).sort((a, b) => a - b);
      const p95 = absDeltas[Math.floor(absDeltas.length * 0.95)];
      const inactive = p95 < motorRange * ACTIVITY_THRESHOLD;

      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const rawStd = Math.sqrt(
        deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length,
      );
      const std = rawStd / motorRange;
      const maxAbsRaw = Math.max(...absDeltas);
      const maxAbs = maxAbsRaw / motorRange;

      const binCount = 30;
      const lo = Math.min(...deltas) / motorRange;
      const hi = Math.max(...deltas) / motorRange;
      const range = hi - lo || 1;
      const binW = range / binCount;
      const bins: number[] = new Array(binCount).fill(0);
      for (const d of deltas) {
        const normD = d / motorRange;
        let b = Math.floor((normD - lo) / binW);
        if (b >= binCount) b = binCount - 1;
        bins[b]++;
      }
      return {
        name: shortName(key),
        std,
        maxAbs,
        bins,
        lo,
        hi,
        motorRange,
        inactive,
        discrete,
      };
    });
  }, [data, actionKeys, agg]);

  const stats = useMemo(
    () => (agg && agg.length > 0 ? agg : (fallbackStats ?? [])),
    [agg, fallbackStats],
  );
  const isAgg = agg && agg.length > 0;

  const maxBinCount = useMemo(
    () => (stats.length > 0 ? Math.max(...stats.flatMap((s) => s.bins)) : 0),
    [stats],
  );
  const maxStd = useMemo(() => {
    const active = stats.filter((s) => !s.inactive && !s.discrete);
    return active.length > 0 ? Math.max(...active.map((s) => s.std)) : 1;
  }, [stats]);

  const insight = useMemo(() => {
    if (stats.length === 0) return null;
    const active = stats.filter((s) => !s.inactive && !s.discrete);
    const excluded = stats.filter((s) => s.inactive || s.discrete);
    const smooth = active.filter((s) => s.std / maxStd < 0.4);
    const moderate = active.filter(
      (s) => s.std / maxStd >= 0.4 && s.std / maxStd < 0.7,
    );
    const jerky = active.filter((s) => s.std / maxStd >= 0.7);
    const isGripper = (n: string) => /grip/i.test(n);
    const jerkyNonGripper = jerky.filter((s) => !isGripper(s.name));
    const jerkyGripper = jerky.filter((s) => isGripper(s.name));

    // `kind` is the branch key, never the label — the label is translated and
    // comparing against it would silently break the tip below in Chinese.
    let verdict: {
      kind: "na" | "smooth" | "moderate" | "jerky";
      label: string;
      color: string;
    };
    if (active.length === 0) {
      verdict = {
        kind: "na",
        label: t("insights.verdictNa"),
        color: "text-zinc-400",
      };
    } else {
      const smoothRatio = smooth.length / active.length;
      if (smoothRatio >= 0.6 && jerkyNonGripper.length === 0)
        verdict = {
          kind: "smooth",
          label: t("insights.verdictSmooth"),
          color: "text-green-400",
        };
      else if (jerkyNonGripper.length <= 2 && smoothRatio >= 0.3)
        verdict = {
          kind: "moderate",
          label: t("insights.verdictModerate"),
          color: "text-yellow-400",
        };
      else
        verdict = {
          kind: "jerky",
          label: t("insights.verdictJerky"),
          color: "text-red-400",
        };
    }

    const lines: string[] = [];
    const names = (group: typeof stats) =>
      group.map((entry) => entry.name).join(", ");
    if (smooth.length > 0)
      lines.push(
        t("insights.lineSmooth", {
          count: smooth.length,
          names: names(smooth),
        }),
      );
    if (moderate.length > 0)
      lines.push(
        t("insights.lineModerate", {
          count: moderate.length,
          names: names(moderate),
        }),
      );
    if (jerkyNonGripper.length > 0)
      lines.push(
        t("insights.lineJerky", {
          count: jerkyNonGripper.length,
          names: names(jerkyNonGripper),
        }),
      );
    if (jerkyGripper.length > 0)
      lines.push(tp("insights.lineGripper", jerkyGripper.length));
    if (excluded.length > 0) {
      const discreteOnly = excluded.filter((s) => s.discrete);
      const inactiveOnly = excluded.filter((s) => s.inactive && !s.discrete);
      const parts: string[] = [];
      if (discreteOnly.length > 0)
        parts.push(
          t("insights.lineDiscrete", {
            count: discreteOnly.length,
            names: names(discreteOnly),
          }),
        );
      if (inactiveOnly.length > 0)
        parts.push(
          t("insights.lineInactive", {
            count: inactiveOnly.length,
            names: names(inactiveOnly),
          }),
        );
      lines.push(t("insights.lineExcluded", { parts: parts.join("; ") }));
    }

    const tip = t(
      verdict.kind === "na"
        ? "insights.tipNa"
        : verdict.kind === "smooth"
          ? "insights.tipSmooth"
          : verdict.kind === "moderate"
            ? "insights.tipModerate"
            : "insights.tipJerky",
    );

    return { verdict, lines, tip };
  }, [stats, maxStd, t, tp]);

  if (stats.length === 0)
    return <p className="text-slate-500 italic">{t("insights.avNoData")}</p>;

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            {t("insights.avTitle")}
            <span className="text-xs text-slate-500 ml-2 font-normal">
              {isAgg
                ? `(${t("insights.scopeSampled", { count: numEpisodes ?? 0 })})`
                : `(${t("insights.scopeCurrent")})`}
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              {tRich("insights.avDesc1", {
                tPlus1: <sub>t+1</sub>,
                t: <sub>t</sub>,
                tight: (
                  <span className="text-green-400">
                    {t("insights.avTight")}
                  </span>
                ),
              })}{" "}
              {tRich("insights.avDesc2", {
                fat: (
                  <span className="text-red-400">{t("insights.avFat")}</span>
                ),
              })}
              <br />
              <span className="text-slate-500">
                {tRich("insights.avTheory", {
                  pi: <sub>π</sub>,
                  pi2: <sub>π</sub>,
                  link: (
                    <a
                      href="https://arxiv.org/abs/2507.09061"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300"
                    >
                      Zhang et al. (2025)
                    </a>
                  ),
                })}
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      {/* Per-dimension mini histograms + stats */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
      >
        {stats.map((s, si) => {
          const barH = 28;
          const dimmed = !!s.inactive || !!s.discrete;
          const tag =
            s.inactive && s.discrete
              ? t("insights.tagInactiveDiscrete")
              : s.discrete
                ? t("insights.tagDiscrete")
                : s.inactive
                  ? t("insights.tagInactive")
                  : null;
          return (
            <div
              key={s.name}
              className={`rounded-md px-2.5 py-2 space-y-1 ${dimmed ? "bg-[var(--surface-0)]/30 opacity-50" : "bg-[var(--surface-0)]/50"}`}
            >
              <p
                className={`text-xs font-medium truncate ${dimmed ? "text-slate-500" : "text-slate-200"}`}
                title={s.name}
              >
                {s.name}
                {tag && (
                  <span className="text-slate-600 ml-1 font-normal">
                    ({tag})
                  </span>
                )}
              </p>
              <div
                className={`flex gap-2 text-xs tabular-nums ${dimmed ? "text-slate-600" : "text-slate-400"}`}
              >
                <span>σ={s.std.toFixed(4)}</span>
                <span>
                  |Δ|<sub>max</sub>={s.maxAbs.toFixed(4)}
                </span>
              </div>
              <svg
                width="100%"
                viewBox={`0 0 ${s.bins.length} ${barH}`}
                preserveAspectRatio="none"
                className="h-7 rounded"
                aria-label={t("insights.avHistAria", { name: s.name })}
              >
                {[...s.bins].map((count, bi) => {
                  const h = maxBinCount > 0 ? (count / maxBinCount) * barH : 0;
                  return (
                    <rect
                      key={bi}
                      x={bi}
                      y={barH - h}
                      width={0.85}
                      height={h}
                      fill={dimmed ? "#475569" : COLORS[si % COLORS.length]}
                      opacity={dimmed ? 0.4 : 0.7}
                    />
                  );
                })}
              </svg>
              <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (s.std / maxStd) * 100)}%`,
                    background: dimmed
                      ? "#475569"
                      : s.std / maxStd < 0.4
                        ? "#22c55e"
                        : s.std / maxStd < 0.7
                          ? "#eab308"
                          : "#ef4444",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {insight && (
        <div className="bg-[var(--surface-0)]/60 rounded-md px-4 py-3 border border-white/10/60 space-y-1.5">
          <p className="text-sm font-medium text-slate-200">
            {t("insights.overall")}{" "}
            <span className={insight.verdict.color}>
              {insight.verdict.label}
            </span>
          </p>
          <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">
            {insight.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500 pt-1">{insight.tip}</p>
        </div>
      )}

      {jerkyEpisodes && jerkyEpisodes.length > 0 && (
        <JerkyEpisodesList episodes={jerkyEpisodes} />
      )}
    </div>
  );
}

function JerkyEpisodesList({ episodes }: { episodes: JerkyEpisode[] }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const display = showAll ? episodes : episodes.slice(0, 15);

  return (
    <div className="bg-[var(--surface-0)]/60 rounded-md px-4 py-3 border border-white/10/60 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-200">
          {t("insights.jerkyTitle")}{" "}
          <span className="text-xs text-slate-500 font-normal">
            {t("insights.jerkySortedBy")}
          </span>
        </p>
        <div className="flex items-center gap-3">
          <FlagAllBtn ids={display.map((e) => e.episodeIndex)} />
          {episodes.length > 15 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {showAll
                ? t("insights.showTop15")
                : t("insights.showAllN", { count: episodes.length })}
            </button>
          )}
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 border-b border-white/10">
              <th className="w-5 py-1" />
              <th className="text-left py-1 pr-3">{t("insights.thEpisode")}</th>
              <th className="text-right py-1">{t("insights.thMeanDelta")}</th>
            </tr>
          </thead>
          <tbody>
            {display.map((e) => (
              <tr
                key={e.episodeIndex}
                className="border-b border-white/5/40 text-slate-300"
              >
                <td className="py-1">
                  <FlagBtn id={e.episodeIndex} />
                </td>
                <td className="py-1 pr-3">
                  {t("common.epShort", { index: e.episodeIndex })}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {e.meanAbsDelta.toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Cross-Episode Variance Heatmap ──────────────────────────────

function VarianceHeatmap({
  data,
  loading,
}: {
  data: CrossEpisodeVarianceData | null;
  loading: boolean;
}) {
  const { t, tRich } = useLocale();
  const isFs = useIsFullscreen();

  if (loading) {
    return (
      <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10">
        <h3 className="text-sm font-semibold text-slate-200 mb-2">
          Cross-Episode Action Variance
        </h3>
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
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
          {t("insights.hmLoading")}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10">
        <h3 className="text-sm font-semibold text-slate-200 mb-2">
          {t("insights.hmTitle")}
        </h3>
        <p className="text-slate-500 italic text-sm">
          {t("insights.hmNoData")}
        </p>
      </div>
    );
  }
  const { actionNames, timeBins, variance, numEpisodes } = data;
  const numDims = actionNames.length;
  const numBins = timeBins.length;

  const maxVar = Math.max(...variance.flat(), 1e-10);

  const baseW = isFs ? 1000 : 560;
  const baseH = isFs ? 500 : 300;
  const cellW = Math.max(
    6,
    Math.min(isFs ? 24 : 14, Math.floor(baseW / numBins)),
  );
  const cellH = Math.max(
    20,
    Math.min(isFs ? 56 : 36, Math.floor(baseH / numDims)),
  );
  const labelW = 100;
  const svgW = labelW + numBins * cellW + 60;
  const svgH = numDims * cellH + 40;

  function varColor(v: number): string {
    const t = Math.sqrt(v / maxVar); // sqrt for better visual spread
    // Dark blue → teal → orange
    const r = Math.round(t * 249);
    const g = Math.round(t < 0.5 ? 80 + t * 200 : 180 - (t - 0.5) * 200);
    const b = Math.round((1 - t) * 200 + 30);
    return `rgb(${r},${g},${b})`;
  }

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            {t("insights.hmTitle")}
            <span className="text-xs text-slate-500 ml-2 font-normal">
              ({t("insights.scopeSampled", { count: numEpisodes })})
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              {tRich("insights.hmDesc", {
                high: (
                  <span className="text-cyan-300">{t("insights.hmHigh")}</span>
                ),
                low: (
                  <span className="text-blue-400">{t("insights.hmLow")}</span>
                ),
              })}
              <br />
              <span className="text-slate-500">
                {tRich("insights.hmTheory", {
                  link: (
                    <a
                      href="https://arxiv.org/abs/2507.09061"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300"
                    >
                      Zhang et al. (2025)
                    </a>
                  ),
                })}
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg width={svgW} height={svgH} className="block">
          {/* Heatmap cells */}
          {variance.map((row, bi) =>
            row.map((v, di) => (
              <rect
                key={`${bi}-${di}`}
                x={labelW + bi * cellW}
                y={di * cellH}
                width={cellW}
                height={cellH}
                fill={varColor(v)}
                stroke="#1e293b"
                strokeWidth={0.5}
              >
                <title>
                  {t("insights.hmCellTitle", {
                    name: shortName(actionNames[di]),
                    percent: (timeBins[bi] * 100).toFixed(0),
                    value: v.toFixed(5),
                  })}
                </title>
              </rect>
            )),
          )}

          {/* Y-axis: action names */}
          {actionNames.map((name, di) => (
            <text
              key={di}
              x={labelW - 4}
              y={di * cellH + cellH / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="fill-slate-400"
              fontSize={Math.min(11, cellH - 4)}
            >
              {shortName(name)}
            </text>
          ))}

          {/* X-axis labels */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const binIdx = Math.round(frac * (numBins - 1));
            return (
              <text
                key={frac}
                x={labelW + binIdx * cellW + cellW / 2}
                y={numDims * cellH + 14}
                textAnchor="middle"
                className="fill-slate-400"
                fontSize={9}
              >
                {(frac * 100).toFixed(0)}%
              </text>
            );
          })}
          <text
            x={labelW + (numBins * cellW) / 2}
            y={numDims * cellH + 30}
            textAnchor="middle"
            className="fill-slate-500"
            fontSize={10}
          >
            {t("insights.hmProgress")}
          </text>

          {/* Color bar */}
          {Array.from({ length: 10 }, (_, i) => {
            const t = i / 9;
            const barX = labelW + numBins * cellW + 16;
            const barH = (numDims * cellH) / 10;
            return (
              <rect
                key={i}
                x={barX}
                y={(9 - i) * barH}
                width={12}
                height={barH}
                fill={varColor(t * maxVar)}
              />
            );
          })}
          <text
            x={labelW + numBins * cellW + 34}
            y={10}
            className="fill-slate-500"
            fontSize={8}
            dominantBaseline="central"
          >
            {t("insights.hmHighLabel")}
          </text>
          <text
            x={labelW + numBins * cellW + 34}
            y={numDims * cellH - 4}
            className="fill-slate-500"
            fontSize={8}
            dominantBaseline="central"
          >
            {t("insights.hmLowLabel")}
          </text>
        </svg>
      </div>
    </div>
  );
}

// ─── Demonstrator Speed Variance ────────────────────────────────

function SpeedVarianceSection({
  distribution,
  numEpisodes,
}: {
  distribution: SpeedDistEntry[];
  numEpisodes: number;
}) {
  const { t, tRich } = useLocale();
  const isFs = useIsFullscreen();
  const { speeds, mean, std, cv, median, bins, lo, binW, maxBin, verdict } =
    useMemo(() => {
      const sp = distribution.map((d) => d.speed).sort((a, b) => a - b);
      const m = sp.reduce((a, b) => a + b, 0) / sp.length;
      const s = Math.sqrt(sp.reduce((a, v) => a + (v - m) ** 2, 0) / sp.length);
      const c = m > 0 ? s / m : 0;
      const med = sp[Math.floor(sp.length / 2)];

      const binCount = Math.min(30, Math.ceil(Math.sqrt(sp.length)));
      const lo = sp[0],
        hi = sp[sp.length - 1];
      const bw = (hi - lo || 1) / binCount;
      const b = new Array(binCount).fill(0);
      for (const v of sp) {
        let i = Math.floor((v - lo) / bw);
        if (i >= binCount) i = binCount - 1;
        b[i]++;
      }

      let v: { label: string; color: string; tip: string };
      if (c < 0.2)
        v = {
          label: t("insights.svConsistent"),
          color: "text-green-400",
          tip: t("insights.svTipConsistent"),
        };
      else if (c < 0.4)
        v = {
          label: t("insights.svModerate"),
          color: "text-yellow-400",
          tip: t("insights.svTipModerate"),
        };
      else
        v = {
          label: t("insights.svHigh"),
          color: "text-red-400",
          tip: t("insights.svTipHigh"),
        };

      return {
        speeds: sp,
        mean: m,
        std: s,
        cv: c,
        median: med,
        bins: b,
        lo,
        binW: bw,
        maxBin: Math.max(...b),
        verdict: v,
      };
    }, [distribution, t]);

  if (speeds.length < 3) return null;

  const barH = isFs ? 250 : 100;
  const barW = Math.max(8, Math.floor((isFs ? 900 : 500) / bins.length));

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            {t("insights.svTitle")}
            <span className="text-xs text-slate-500 ml-2 font-normal">
              ({t("insights.svScope", { count: numEpisodes })})
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              {tRich("insights.svDesc", {
                t: <sub>t</sub>,
                speeds: (
                  <span className="text-cyan-300">
                    {t("insights.svSpeeds")}
                  </span>
                ),
              })}
              <br />
              <span className="text-slate-500">{t("insights.svTheory")}</span>
            </p>
          </InfoToggle>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 overflow-x-auto">
          <svg width={bins.length * barW} height={barH + 24} className="block">
            {bins.map((count: number, i: number) => {
              const h = maxBin > 0 ? (count / maxBin) * barH : 0;
              const speed = lo + (i + 0.5) * binW;
              const ratio = median > 0 ? speed / median : 1;
              const dev = Math.abs(ratio - 1);
              const color =
                dev < 0.2 ? "#22c55e" : dev < 0.5 ? "#eab308" : "#ef4444";
              return (
                <rect
                  key={i}
                  x={i * barW}
                  y={barH - h}
                  width={barW - 1}
                  height={Math.max(1, h)}
                  fill={color}
                  opacity={0.7}
                  rx={1}
                >
                  <title>
                    {t("insights.svBarTitle", {
                      from: (lo + i * binW).toFixed(3),
                      to: (lo + (i + 1) * binW).toFixed(3),
                      count,
                      ratio: ratio.toFixed(2),
                    })}
                  </title>
                </rect>
              );
            })}
            {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
              const idx = Math.round(frac * (bins.length - 1));
              return (
                <text
                  key={frac}
                  x={idx * barW + barW / 2}
                  y={barH + 14}
                  textAnchor="middle"
                  className="fill-slate-400"
                  fontSize={9}
                >
                  {(lo + idx * binW).toFixed(2)}
                </text>
              );
            })}
          </svg>
        </div>
        <div className="flex flex-col gap-2 text-xs shrink-0 min-w-[120px]">
          <div>
            <span className="text-slate-500">{t("stats.mean")}</span>{" "}
            <span className="text-slate-200 tabular-nums ml-1">
              {mean.toFixed(4)}
            </span>
          </div>
          <div>
            <span className="text-slate-500">{t("stats.median")}</span>{" "}
            <span className="text-slate-200 tabular-nums ml-1">
              {median.toFixed(4)}
            </span>
          </div>
          <div>
            <span className="text-slate-500">{t("insights.std")}</span>{" "}
            <span className="text-slate-200 tabular-nums ml-1">
              {std.toFixed(4)}
            </span>
          </div>
          <div>
            <span className="text-slate-500">CV</span>
            <span className={`tabular-nums ml-1 font-bold ${verdict.color}`}>
              {cv.toFixed(3)}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-[var(--surface-0)]/60 rounded-md px-4 py-3 border border-white/10/60 space-y-1.5">
        <p className="text-sm font-medium text-slate-200">
          {t("insights.verdict")}{" "}
          <span className={verdict.color}>{verdict.label}</span>
        </p>
        <p className="text-xs text-slate-400">{verdict.tip}</p>
      </div>
    </div>
  );
}

// ─── State–Action Temporal Alignment ────────────────────────────

function StateActionAlignmentSection({
  data,
  fps,
  agg,
  numEpisodes,
}: {
  data: Record<string, number>[];
  fps: number;
  agg?: AggAlignment | null;
  numEpisodes?: number;
}) {
  const { t, tp, tRich } = useLocale();
  const isFs = useIsFullscreen();
  const result = useMemo(() => {
    if (agg) return { ...agg, fromAgg: true };
    if (data.length < 10) return null;
    const actionKeys = getActionKeys(data[0]);
    const stateKeys = getStateKeys(data[0]);
    if (actionKeys.length === 0 || stateKeys.length === 0) return null;
    const maxLag = Math.min(Math.floor(data.length / 4), 30);
    if (maxLag < 2) return null;

    // Match action↔state by suffix, fall back to index matching
    const pairs: [string, string][] = [];
    for (const aKey of actionKeys) {
      const match = stateKeys.find(
        (sKey) => shortName(sKey) === shortName(aKey),
      );
      if (match) pairs.push([aKey, match]);
    }
    if (pairs.length === 0) {
      const count = Math.min(actionKeys.length, stateKeys.length);
      for (let i = 0; i < count; i++) pairs.push([actionKeys[i], stateKeys[i]]);
    }
    if (pairs.length === 0) return null;

    // Per-pair cross-correlation (Δaction vs Δstate)
    const pairCorrs: number[][] = [];
    for (const [aKey, sKey] of pairs) {
      const aDeltas = data
        .slice(1)
        .map((row, i) => (row[aKey] ?? 0) - (data[i][aKey] ?? 0));
      const sDeltas = data
        .slice(1)
        .map((row, i) => (row[sKey] ?? 0) - (data[i][sKey] ?? 0));
      const n = Math.min(aDeltas.length, sDeltas.length);
      if (n < 4) {
        pairCorrs.push(Array(2 * maxLag + 1).fill(0));
        continue;
      }
      const aM = aDeltas.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const sM = sDeltas.slice(0, n).reduce((a, b) => a + b, 0) / n;

      const corrs: number[] = [];
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let sum = 0,
          aV = 0,
          sV = 0;
        for (let t = 0; t < n; t++) {
          const sIdx = t + lag;
          if (sIdx < 0 || sIdx >= n) continue;
          const a = aDeltas[t] - aM,
            s = sDeltas[sIdx] - sM;
          sum += a * s;
          aV += a * a;
          sV += s * s;
        }
        const d = Math.sqrt(aV * sV);
        corrs.push(d > 0 ? sum / d : 0);
      }
      pairCorrs.push(corrs);
    }

    // Aggregate min/mean/max per lag
    const ccData = Array.from({ length: 2 * maxLag + 1 }, (_, li) => {
      const lag = -maxLag + li;
      const vals = pairCorrs.map((pc) => pc[li]);
      return {
        lag,
        time: lag / fps,
        max: Math.max(...vals),
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        min: Math.min(...vals),
      };
    });

    // Peaks of the envelope curves
    let meanPeakLag = 0,
      meanPeakCorr = -Infinity;
    let maxPeakLag = 0,
      maxPeakCorr = -Infinity;
    let minPeakLag = 0,
      minPeakCorr = -Infinity;
    for (const row of ccData) {
      if (row.max > maxPeakCorr) {
        maxPeakCorr = row.max;
        maxPeakLag = row.lag;
      }
      if (row.mean > meanPeakCorr) {
        meanPeakCorr = row.mean;
        meanPeakLag = row.lag;
      }
      if (row.min > minPeakCorr) {
        minPeakCorr = row.min;
        minPeakLag = row.lag;
      }
    }

    // Per-pair individual peak lags (for showing the true range across dimensions)
    const perPairPeakLags = pairCorrs.map((pc) => {
      let best = -Infinity,
        bestLag = 0;
      for (let li = 0; li < pc.length; li++) {
        if (pc[li] > best) {
          best = pc[li];
          bestLag = -maxLag + li;
        }
      }
      return bestLag;
    });
    const lagRangeMin = Math.min(...perPairPeakLags);
    const lagRangeMax = Math.max(...perPairPeakLags);

    return {
      ccData,
      meanPeakLag,
      meanPeakCorr,
      maxPeakLag,
      maxPeakCorr,
      minPeakLag,
      minPeakCorr,
      lagRangeMin,
      lagRangeMax,
      numPairs: pairs.length,
      fromAgg: false,
    };
  }, [data, fps, agg]);

  if (!result) return null;
  const {
    ccData,
    meanPeakLag,
    meanPeakCorr,
    maxPeakLag,
    maxPeakCorr,
    minPeakLag,
    minPeakCorr,
    lagRangeMin,
    lagRangeMax,
    numPairs,
    fromAgg,
  } = result;
  const scopeLabel = fromAgg
    ? t("insights.scopeSampled", { count: numEpisodes ?? 0 })
    : t("insights.scopeCurrent");

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            {t("insights.saTitle")}
            <span className="text-xs text-slate-500 ml-2 font-normal">
              ({tp("insights.saScope", numPairs, { scope: scopeLabel })})
            </span>
          </h3>
          <InfoToggle>
            <p className="text-xs text-slate-400">
              {tRich("insights.saDesc", {
                d1: <sub>d</sub>,
                d2: <sub>d</sub>,
                max: (
                  <span className="text-cyan-300">{t("insights.saMax")}</span>
                ),
                mean: (
                  <span className="text-slate-200">{t("insights.saMean")}</span>
                ),
                min: (
                  <span className="text-blue-400">{t("insights.saMin")}</span>
                ),
                peak: (
                  <span className="text-cyan-300">
                    {t("insights.saPeakLag")}
                  </span>
                ),
              })}
              <br />
              <span className="text-slate-500">
                {tRich("insights.saTheory", {
                  act: (
                    <a
                      href="https://arxiv.org/abs/2304.13705"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300"
                    >
                      Zhao et al., 2023
                    </a>
                  ),
                  rtc: (
                    <a
                      href="https://arxiv.org/abs/2506.07339"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300"
                    >
                      Black et al., 2025
                    </a>
                  ),
                  ttrtc: (
                    <a
                      href="https://arxiv.org/abs/2512.05964"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300"
                    >
                      Black et al., 2025
                    </a>
                  ),
                })}
              </span>
            </p>
          </InfoToggle>
        </div>
      </div>

      {meanPeakLag !== 0 && (
        <div className="flex items-center gap-3 bg-cyan-400/10 border border-cyan-400/30 rounded-md px-4 py-2.5">
          <span className="text-cyan-300 font-bold text-lg tabular-nums">
            {meanPeakLag}
          </span>
          <div>
            <p className="text-sm text-cyan-200 font-medium">
              {tp("insights.saDelay", meanPeakLag, {
                steps: meanPeakLag,
                seconds: (meanPeakLag / fps).toFixed(3),
              })}
            </p>
            <p className="text-xs text-slate-400">
              {meanPeakLag > 0
                ? t("insights.saLagPositive", { frames: meanPeakLag })
                : t("insights.saLagNegative", { frames: -meanPeakLag })}
              {lagRangeMin !== lagRangeMax &&
                ` ${t("insights.saLagRange", {
                  min: lagRangeMin,
                  max: lagRangeMax,
                })}`}
            </p>
          </div>
        </div>
      )}

      <div className={isFs ? "h-[500px]" : "h-56"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={ccData}
            margin={{ top: 8, right: 16, left: 0, bottom: 16 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="lag"
              stroke="#94a3b8"
              label={{
                value: t("insights.lagAxis"),
                position: "insideBottom",
                offset: -8,
                fill: "#94a3b8",
                fontSize: 13,
              }}
            />
            <YAxis
              stroke="#94a3b8"
              domain={[-0.5, 1]}
              tickFormatter={(v) => Number(v.toFixed(2)).toString()}
            />
            <Tooltip
              contentStyle={{
                background: "#1e293b",
                border: "1px solid #475569",
                borderRadius: 6,
              }}
              labelFormatter={(v) =>
                t("insights.lagTooltip", {
                  lag: String(v),
                  seconds: (Number(v) / fps).toFixed(3),
                })
              }
              formatter={(v: number) => v.toFixed(3)}
            />
            <Line
              dataKey="max"
              stroke="#f97316"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
              name="max"
            />
            <Line
              dataKey="mean"
              stroke="#94a3b8"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
              name="mean"
            />
            <Line
              dataKey="min"
              stroke="#3b82f6"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
              name="min"
            />
            <Line
              dataKey={() => 0}
              stroke="#64748b"
              strokeDasharray="6 4"
              dot={false}
              name="zero"
              legendType="none"
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full shrink-0 bg-cyan-500" />
          <span className="text-xs text-slate-400">
            {t("insights.saLegend", {
              series: t("insights.saMax"),
              lag: maxPeakLag,
              r: maxPeakCorr.toFixed(3),
            })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full shrink-0 bg-slate-400" />
          <span className="text-xs text-slate-400">
            {t("insights.saLegend", {
              series: t("insights.saMean"),
              lag: meanPeakLag,
              r: meanPeakCorr.toFixed(3),
            })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full shrink-0 bg-blue-500" />
          <span className="text-xs text-slate-400">
            {t("insights.saLegend", {
              series: t("insights.saMin"),
              lag: minPeakLag,
              r: minPeakCorr.toFixed(3),
            })}
          </span>
        </div>
      </div>

      {meanPeakLag === 0 && (
        <p className="text-xs text-green-400">
          {t("insights.saAligned", { r: meanPeakCorr.toFixed(3) })}
        </p>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────

interface ActionInsightsPanelProps {
  flatChartData: Record<string, number>[];
  fps: number;
  totalEpisodes: number;
  crossEpisodeData: CrossEpisodeVarianceData | null;
  crossEpisodeLoading: boolean;
}

function SpatialTrajectorySection({
  data,
  loading,
}: {
  data: CrossEpisodeVarianceData["spatialTrajectories"] | undefined;
  loading: boolean;
}) {
  const fullscreen = useIsFullscreen();
  return (
    <SpatialTrajectoryViewer
      data={data}
      loading={loading}
      fullscreen={fullscreen}
    />
  );
}

function ActionInsightsPanel({
  flatChartData,
  fps,
  totalEpisodes,
  crossEpisodeData,
  crossEpisodeLoading,
}: ActionInsightsPanelProps) {
  const t = useT();
  const [mode, setMode] = useState<"episode" | "dataset">("dataset");
  const showAgg = mode === "dataset" && !!crossEpisodeData;
  // `meta/info.json` is the canonical dataset count. The statistical loader
  // may read a smaller sample, and episode metadata can independently be
  // incomplete; neither should change the user-facing dataset total.
  const datasetEpisodeCount = totalEpisodes;
  const sampledEpisodeCount = crossEpisodeData?.numEpisodes ?? 0;
  const showSamplingNote =
    sampledEpisodeCount > 0 && sampledEpisodeCount < datasetEpisodeCount;

  return (
    <div className="max-w-5xl mx-auto py-6 space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">
            {t("insights.title")}
          </h2>
          <p className="text-sm text-slate-400 mt-1">{t("insights.desc")}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-3">
            <span
              className={`text-sm ${mode === "episode" ? "text-slate-100 font-medium" : "text-slate-500"}`}
            >
              {t("insights.scopeEpisodeToggle")}
            </span>
            <button
              onClick={() =>
                setMode((m) => (m === "episode" ? "dataset" : "episode"))
              }
              className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors shrink-0 ${mode === "dataset" ? "bg-cyan-500" : "bg-white/10"}`}
              aria-label={t("insights.scopeToggleAria")}
            >
              <span
                className={`inline-block w-3.5 h-3.5 bg-white rounded-full transition-transform ${mode === "dataset" ? "translate-x-[18px]" : "translate-x-[3px]"}`}
              />
            </button>
            <span
              className={`text-sm ${mode === "dataset" ? "text-slate-100 font-medium" : "text-slate-500"}`}
            >
              {t("insights.scopeAllToggle")} ({datasetEpisodeCount})
            </span>
          </div>
          {showSamplingNote && (
            <span className="text-[10px] text-slate-500 tabular-nums">
              {t("insights.scopeSamplingNote", {
                sampled: sampledEpisodeCount,
                total: datasetEpisodeCount,
              })}
            </span>
          )}
        </div>
      </div>

      <FullscreenWrapper>
        <SpatialTrajectorySection
          data={crossEpisodeData?.spatialTrajectories}
          loading={crossEpisodeLoading}
        />
      </FullscreenWrapper>

      <FullscreenWrapper>
        <AutocorrelationSection
          data={flatChartData}
          fps={fps}
          agg={showAgg ? crossEpisodeData?.aggAutocorrelation : null}
          numEpisodes={crossEpisodeData?.numEpisodes}
        />
      </FullscreenWrapper>
      <FullscreenWrapper>
        <StateActionAlignmentSection
          data={flatChartData}
          fps={fps}
          agg={showAgg ? crossEpisodeData?.aggAlignment : null}
          numEpisodes={crossEpisodeData?.numEpisodes}
        />
      </FullscreenWrapper>

      {crossEpisodeData?.speedDistribution &&
        crossEpisodeData.speedDistribution.length > 2 && (
          <FullscreenWrapper>
            <SpeedVarianceSection
              distribution={crossEpisodeData.speedDistribution}
              numEpisodes={crossEpisodeData.numEpisodes}
            />
          </FullscreenWrapper>
        )}
      <FullscreenWrapper>
        <VarianceHeatmap
          data={crossEpisodeData}
          loading={crossEpisodeLoading}
        />
      </FullscreenWrapper>
    </div>
  );
}

export default ActionInsightsPanel;
export { ActionVelocitySection, FullscreenWrapper };

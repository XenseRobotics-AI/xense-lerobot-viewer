"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DatasetDisplayInfo,
  EpisodeData,
  EpisodeLengthStats,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { EpisodeLengthHistogram } from "@/components/stats-panel";
import WorkbenchDatasetStatistics from "@/components/workbench-dataset-statistics";
import WorkbenchGroupingPanel from "@/components/workbench-grouping-panel";
import { HF_MIRROR_ENDPOINT, HF_OFFICIAL_ENDPOINT } from "@/lib/hf-endpoints";
import {
  checkHfAccount,
  clearHfAccount,
  readHfAccount,
  type HfAccount,
} from "@/utils/hfAccountClient";
import { assignEpisodesToBins } from "@/utils/episodeLengthHistogram";
import { runSync } from "@/utils/syncClient";

type QualityCheckResult = {
  id: string;
  title: string;
  provider?: string;
  status: "ok" | "warn" | "fail" | "skip" | string;
  message: string;
  details?: string[];
};

type QualityResponse = {
  datasetName: string;
  tasks: Array<{ index: number; task: string }>;
  checks: QualityCheckResult[];
  aggregate: { worst: string; n_fail: number; n_warn: number };
  config?: {
    name_format?: { regex: string };
    avg_duration?: { min_sec: number; max_sec: number };
    prompt?: { min_words: number; max_words: number; illegal_chars: string[] };
  };
};

type StatisticsProgress = {
  phase: "catalog" | "stats" | "complete" | "error";
  index?: number;
  total?: number;
  percent?: number;
  repo?: string;
  repoId?: string;
};

const STATISTICS_ENDPOINTS = [
  HF_OFFICIAL_ENDPOINT,
  HF_MIRROR_ENDPOINT,
] as const;

interface DatasetReviewPanelProps {
  datasetInfo: DatasetDisplayInfo;
  episodeData?: EpisodeData;
  episodeLengthStats: EpisodeLengthStats | null;
  episodeLengthStatsLoading: boolean;
  episodeLengthStatsError: string | null;
  onRetryEpisodeStats: () => void;
  encodedPath: string | null;
  datasetName: string;
}

const qualityCache = new Map<string, QualityResponse>();
const MAX_EPISODE_ROWS_PER_BIN = 500;

function formatHours(totalFrames: number, fps: number): string {
  if (!Number.isFinite(totalFrames) || !Number.isFinite(fps) || fps <= 0) {
    return "—";
  }
  const hours = totalFrames / fps / 3600;
  return `${hours.toFixed(hours >= 100 ? 1 : 3)} h`;
}

function formatSize(megabytes: number): string {
  if (!Number.isFinite(megabytes) || megabytes <= 0) return "—";
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(2)} GB`;
  return `${megabytes.toFixed(1)} MB`;
}

function Card({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/60 p-4">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-100">
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "fail"
      ? "border-red-400/30 bg-red-400/10 text-red-300"
      : status === "warn"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
        : status === "skip"
          ? "border-slate-400/20 bg-slate-400/10 text-slate-400"
          : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  const label =
    status === "fail"
      ? "FAIL"
      : status === "warn"
        ? "WARN"
        : status === "skip"
          ? "SKIP"
          : "PASS";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${tone}`}
    >
      {label}
    </span>
  );
}

function LoadingLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-400">{children}</p>;
}

function EpisodeDurationGroups({ stats }: { stats: EpisodeLengthStats }) {
  const episodesByBin = useMemo(
    () =>
      assignEpisodesToBins(
        stats.allEpisodeLengths,
        stats.episodeLengthHistogramBinning,
      ),
    [stats],
  );
  const episodesById = useMemo(
    () =>
      new Map(
        stats.allEpisodeLengths.map((episode) => [
          episode.episodeIndex,
          episode,
        ]),
      ),
    [stats],
  );

  return (
    <div className="space-y-2">
      {stats.episodeLengthHistogram.map((bin, index) => {
        const ids = episodesByBin[index] ?? [];
        if (ids.length === 0) return null;
        return (
          <details
            key={`${bin.binLabel}-${index}`}
            className="group rounded-md border border-white/10 bg-[var(--surface-0)]/50"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-slate-300 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="mr-2 text-slate-500 group-open:text-cyan-300">
                  ▸
                </span>
                {bin.binLabel}
              </span>
              <span className="tabular-nums text-slate-500">
                {ids.length} episodes
              </span>
            </summary>
            <div className="overflow-x-auto border-t border-white/10">
              <table className="w-full min-w-[360px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Episode</th>
                    <th className="px-3 py-1.5 font-medium">Duration</th>
                    <th className="px-3 py-1.5 text-right font-medium">
                      Frames
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ids.slice(0, MAX_EPISODE_ROWS_PER_BIN).map((episodeId) => {
                    const episode = episodesById.get(episodeId);
                    if (!episode) return null;
                    return (
                      <tr
                        key={episodeId}
                        className="border-t border-white/5 text-slate-300"
                      >
                        <td className="px-3 py-1.5 font-mono">
                          ep {episode.episodeIndex}
                        </td>
                        <td className="px-3 py-1.5 tabular-nums">
                          {episode.lengthSeconds.toFixed(2)}s
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {episode.frames.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {ids.length > MAX_EPISODE_ROWS_PER_BIN && (
                <p className="border-t border-white/5 px-3 py-2 text-[11px] text-slate-500">
                  Showing the first {MAX_EPISODE_ROWS_PER_BIN.toLocaleString()}{" "}
                  episodes;{" "}
                  {(ids.length - MAX_EPISODE_ROWS_PER_BIN).toLocaleString()}{" "}
                  more are in this range.
                </p>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export default function DatasetReviewPanel({
  datasetInfo,
  episodeData,
  episodeLengthStats,
  episodeLengthStatsLoading,
  episodeLengthStatsError,
  onRetryEpisodeStats,
  encodedPath,
  datasetName,
}: DatasetReviewPanelProps) {
  const organization = datasetName.split("/", 1)[0]?.trim() ?? "";
  const [quality, setQuality] = useState<QualityResponse | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [statisticsRefreshToken, setStatisticsRefreshToken] = useState(0);
  const [statisticsAction, setStatisticsAction] = useState<"refresh" | null>(
    null,
  );
  const [statisticsRefreshError, setStatisticsRefreshError] = useState<
    string | null
  >(null);
  const [statisticsRefreshMessage, setStatisticsRefreshMessage] = useState<
    string | null
  >(null);
  const [statisticsEndpoint, setStatisticsEndpoint] =
    useState(HF_OFFICIAL_ENDPOINT);
  const [statisticsToken, setStatisticsToken] = useState("");
  const [showStatisticsToken, setShowStatisticsToken] = useState(false);
  const [hfAccount, setHfAccount] = useState<HfAccount | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [statisticsProgress, setStatisticsProgress] =
    useState<StatisticsProgress | null>(null);
  const [statisticsProgressError, setStatisticsProgressError] = useState<
    string | null
  >(null);
  const [workbenchView, setWorkbenchView] = useState<
    "dataset-statistics" | "checks" | "grouping"
  >("grouping");
  const qualityRequestIdRef = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setHfAccount(null);
    readHfAccount(controller.signal, organization || undefined)
      .then(setHfAccount)
      .catch(() => undefined);
    return () => controller.abort();
  }, [organization]);

  const statisticsRefreshAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const requestId = ++qualityRequestIdRef.current;
    if (!encodedPath) {
      setQuality(null);
      setQualityError("Custom checks are available only for local datasets.");
      setQualityLoading(false);
      return;
    }

    const cached = qualityCache.get(encodedPath);
    if (cached && refreshToken === 0) {
      setQuality(cached);
      setQualityError(null);
      setQualityLoading(false);
      return;
    }

    const controller = new AbortController();
    setQuality(null);
    setQualityLoading(true);
    setQualityError(null);
    fetch(`/api/local-datasets/${encodedPath}/quality`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as
          | QualityResponse
          | { error?: string };
        if (!response.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : `Request failed (${response.status})`,
          );
        }
        return payload as QualityResponse;
      })
      .then((payload) => {
        if (qualityRequestIdRef.current !== requestId) return;
        qualityCache.set(encodedPath, payload);
        setQuality(payload);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (qualityRequestIdRef.current !== requestId) return;
        setQualityError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (qualityRequestIdRef.current === requestId) setQualityLoading(false);
      });

    return () => controller.abort();
  }, [encodedPath, refreshToken]);

  const checkSummary = quality
    ? quality.aggregate.n_fail > 0
      ? `${quality.aggregate.n_fail} failed`
      : quality.aggregate.n_warn > 0
        ? `${quality.aggregate.n_warn} warnings`
        : "All custom checks passed"
    : null;
  const displayDatasetName = quality?.datasetName || datasetName;

  const refreshStatistics = async () => {
    if (!organization) {
      setStatisticsRefreshError(
        "Workbench statistics requires a dataset organization.",
      );
      setStatisticsRefreshMessage(null);
      return;
    }
    statisticsRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    statisticsRefreshAbortRef.current = controller;
    setStatisticsAction("refresh");
    const explicitToken = statisticsToken.trim();
    setStatisticsRefreshError(null);
    setStatisticsRefreshMessage(null);
    setStatisticsProgressError(null);
    setStatisticsProgress({ phase: "catalog", percent: 0 });
    try {
      const response = await fetch("/api/hf/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          org: organization,
          endpoint: statisticsEndpoint,
          ...(explicitToken ? { token: explicitToken } : {}),
        }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error || `Statistics refresh failed (${response.status}).`,
        );
      }
      if (!response.body) {
        throw new Error("Statistics refresh returned no stream.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let refreshError: string | null = null;
      let catalogCount: number | null = null;
      const handleCatalogLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            error?: string;
            progress?: {
              index?: number;
              total?: number;
              percent?: number;
              repoId?: string;
            };
            result?: { datasets?: unknown[] };
          };
          if (event.type === "progress" && event.progress) {
            const progress = event.progress;
            const total =
              typeof progress.total === "number" ? progress.total : undefined;
            const index =
              typeof progress.index === "number" ? progress.index : undefined;
            setStatisticsProgress({
              phase: "catalog",
              index,
              total,
              percent:
                typeof progress.percent === "number"
                  ? progress.percent
                  : total && index
                    ? Math.round((index / total) * 100)
                    : undefined,
              repoId:
                typeof progress.repoId === "string"
                  ? progress.repoId
                  : undefined,
            });
          }
          if (event.type === "error" && !refreshError) {
            refreshError = event.error || "Statistics refresh failed.";
          }
          if (
            event.type === "result" &&
            Array.isArray(event.result?.datasets)
          ) {
            catalogCount = event.result.datasets.length;
          }
        } catch {
          // Progress lines are best-effort; final API errors are handled above.
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleCatalogLine(line);
      }
      handleCatalogLine(buffer);
      if (refreshError) throw new Error(refreshError);

      setStatisticsProgress({ phase: "stats", percent: 0 });
      const result = await runSync(
        organization,
        (progress) => {
          setStatisticsProgress({
            phase: progress.phase === "complete" ? "complete" : "stats",
            index: progress.index,
            total: progress.total,
            percent: progress.percent,
            repo: progress.repo,
          });
        },
        {
          signal: controller.signal,
          metadataOnly: true,
          endpoint: statisticsEndpoint,
          ...(explicitToken ? { token: explicitToken } : {}),
        },
      );
      setStatisticsProgress({ phase: "complete", percent: 100 });
      setStatisticsRefreshToken((value) => value + 1);
      const formatCatalogMessage = (count: number | null): string =>
        count === null
          ? "Catalog refreshed."
          : `Catalog refreshed: ${count.toLocaleString()} datasets visible to the current credential.`;
      const catalogMessage = formatCatalogMessage(
        catalogCount as number | null,
      );
      const syncMessage =
        result.failed.length === 0
          ? result.downloaded === 0
            ? "Stats files are already up to date."
            : `Stats files synced: ${result.downloaded.toLocaleString()} datasets.`
          : `Stats files synced: ${result.downloaded.toLocaleString()} datasets, ${result.failed.length.toLocaleString()} failed.`;
      setStatisticsRefreshMessage(`${catalogMessage} ${syncMessage}`);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message =
        error instanceof Error ? error.message : "Statistics refresh failed.";
      setStatisticsProgressError(message);
      setStatisticsProgress((current) => ({
        ...(current ?? {}),
        phase: "error",
      }));
      setStatisticsRefreshError(message);
    } finally {
      if (statisticsRefreshAbortRef.current === controller) {
        statisticsRefreshAbortRef.current = null;
      }
      if (!controller.signal.aborted) setStatisticsAction(null);
    }
  };

  const verifyStatisticsAccount = async () => {
    if (!organization) return;
    setAccountBusy(true);
    setStatisticsRefreshError(null);
    try {
      const token = statisticsToken.trim();
      const account = await checkHfAccount(
        token || undefined,
        undefined,
        organization,
        statisticsEndpoint,
      );
      setHfAccount(account);
      if (token) {
        setStatisticsToken("");
        setShowStatisticsToken(false);
      }
    } catch (error: unknown) {
      setStatisticsRefreshError(
        error instanceof Error ? error.message : "HF account check failed.",
      );
    } finally {
      setAccountBusy(false);
    }
  };

  const clearStatisticsAccount = async () => {
    setAccountBusy(true);
    try {
      setHfAccount(await clearHfAccount());
    } catch (error: unknown) {
      setStatisticsRefreshError(
        error instanceof Error ? error.message : "Unable to clear HF token.",
      );
    } finally {
      setAccountBusy(false);
    }
  };

  const progressPercent =
    typeof statisticsProgress?.percent === "number"
      ? Math.max(0, Math.min(100, Math.round(statisticsProgress.percent)))
      : null;
  const progressLabel =
    statisticsProgress?.phase === "catalog"
      ? "Refreshing Hub catalog"
      : statisticsProgress?.phase === "stats"
        ? "Syncing stats files"
        : statisticsProgress?.phase === "complete"
          ? "Statistics refresh complete"
          : statisticsProgress?.phase === "error"
            ? "Statistics refresh failed"
            : null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">
            Workbench
          </p>
          <h2
            className="mt-1 truncate text-xl font-semibold text-slate-100"
            title={displayDatasetName}
          >
            {displayDatasetName}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Read-only dataset statistics and Workbench custom checks. Doctor and
            Parquet remain independent.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {encodedPath && workbenchView === "checks" && (
            <button
              type="button"
              onClick={() => setRefreshToken((value) => value + 1)}
              className="rounded-md border border-white/10 bg-[var(--surface-1)]/70 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
            >
              Refresh checks
            </button>
          )}
          <button
            type="button"
            onClick={refreshStatistics}
            disabled={statisticsAction !== null || accountBusy || !organization}
            className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {statisticsAction === "refresh"
              ? "Refreshing statistics…"
              : "Refresh statistics"}
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>Hub</span>
            <select
              value={statisticsEndpoint}
              onChange={(event) => setStatisticsEndpoint(event.target.value)}
              aria-label="Hugging Face endpoint"
              className="rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50"
            >
              {STATISTICS_ENDPOINTS.map((endpoint) => (
                <option key={endpoint} value={endpoint}>
                  {endpoint === HF_OFFICIAL_ENDPOINT
                    ? "huggingface.co (official)"
                    : "hf-mirror.com (mirror)"}
                </option>
              ))}
            </select>
          </label>
          <span
            className="max-w-[16rem] truncate text-[11px] text-slate-400"
            title={hfAccount?.endpoint ?? undefined}
          >
            {hfAccount?.authenticated
              ? `HF: ${hfAccount.username ?? "authenticated"}`
              : hfAccount?.tokenPresent
                ? "HF token configured (not checked)"
                : "HF: not signed in"}
          </span>
          <button
            type="button"
            onClick={() => setShowStatisticsToken((value) => !value)}
            className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
          >
            {hfAccount?.authenticated ? "Change token" : "HF token"}
          </button>
          <button
            type="button"
            onClick={() => void verifyStatisticsAccount()}
            disabled={accountBusy || statisticsAction !== null || !organization}
            className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {accountBusy ? "Checking account…" : "Check account"}
          </button>
          {hfAccount?.source === "viewer" && (
            <button
              type="button"
              onClick={() => void clearStatisticsAccount()}
              disabled={accountBusy || statisticsAction !== null}
              className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-500 transition-colors hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear local token
            </button>
          )}
        </div>
      </div>

      {statisticsEndpoint === HF_MIRROR_ENDPOINT && (
        <p className="-mt-2 text-[11px] text-amber-200/80">
          hf-mirror.com may not serve metadata files. Use huggingface.co when
          Refresh statistics needs to download stats JSON.
        </p>
      )}

      {showStatisticsToken && (
        <div className="-mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[var(--surface-1)]/40 p-3">
          <input
            type="password"
            value={statisticsToken}
            onChange={(event) => setStatisticsToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void verifyStatisticsAccount();
            }}
            placeholder="hf_…"
            autoComplete="new-password"
            aria-label="Hugging Face token"
            className="min-w-[18rem] flex-1 rounded-md border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void verifyStatisticsAccount()}
            disabled={accountBusy || !statisticsToken.trim()}
            className="rounded-md bg-cyan-400/80 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {accountBusy ? "Verifying…" : "Verify and save"}
          </button>
          <p className="w-full text-[11px] text-slate-500">
            The token is sent only to this local backend and saved under
            .xense-viewer/secrets after successful verification.
          </p>
        </div>
      )}

      {progressLabel && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-cyan-400/15 bg-cyan-400/5 px-3 py-2.5 text-xs text-slate-300"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{progressLabel}</span>
            <span className="tabular-nums text-cyan-200">
              {progressPercent === null ? "…" : `${progressPercent}%`}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent ?? 0}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-cyan-300 transition-[width] duration-300"
              style={{ width: `${progressPercent ?? 0}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {statisticsProgress?.index && statisticsProgress.total
              ? `${statisticsProgress.index.toLocaleString()} / ${statisticsProgress.total.toLocaleString()}`
              : "Waiting for progress events…"}
            {(statisticsProgress?.repo || statisticsProgress?.repoId) &&
              ` · ${statisticsProgress.repo || statisticsProgress.repoId}`}
          </p>
          {statisticsProgressError && (
            <p className="mt-1 text-[11px] text-amber-200">
              {statisticsProgressError}
            </p>
          )}
        </div>
      )}

      {(statisticsRefreshError || statisticsRefreshMessage) && (
        <div
          className={`rounded-lg border p-3 text-xs ${
            statisticsRefreshError
              ? "border-amber-400/25 bg-amber-400/5 text-amber-200"
              : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
          }`}
        >
          {statisticsRefreshError || statisticsRefreshMessage}
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-white/10 pb-1">
        {(
          [
            ["grouping", "Grouped statistics"],
            ["dataset-statistics", "Dataset statistics"],
            ["checks", "Current dataset checks"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setWorkbenchView(value)}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
              workbenchView === value
                ? "bg-cyan-400/15 text-cyan-200"
                : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {workbenchView === "dataset-statistics" ? (
        <WorkbenchDatasetStatistics
          organization={organization}
          refreshToken={statisticsRefreshToken}
          episodeData={episodeData}
        />
      ) : workbenchView === "grouping" ? (
        <WorkbenchGroupingPanel
          organization={organization}
          refreshToken={statisticsRefreshToken}
          episodeData={episodeData}
        />
      ) : (
        <>
          <section className="rounded-xl border border-cyan-400/20 bg-[var(--surface-1)]/30 p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">
                  Dataset Statistics
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Summary derived from meta/info.json and episode metadata.
                </p>
              </div>
              {episodeLengthStatsLoading && (
                <span className="text-xs text-slate-500">
                  Loading episode metadata…
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card
                label="Total Episodes"
                value={datasetInfo.total_episodes.toLocaleString()}
              />
              <Card
                label="Total Frames"
                value={datasetInfo.total_frames.toLocaleString()}
              />
              <Card
                label="Recording Time"
                value={formatHours(datasetInfo.total_frames, datasetInfo.fps)}
              />
              <Card
                label="Average Episode"
                value={
                  episodeLengthStats
                    ? `${episodeLengthStats.meanEpisodeLength.toFixed(2)}s`
                    : "—"
                }
              />
              <Card
                label="Dataset Size"
                value={formatSize(datasetInfo.dataset_size_mb)}
              />
              <Card label="FPS" value={datasetInfo.fps || "—"} />
              <Card
                label="Tasks"
                value={datasetInfo.total_tasks.toLocaleString()}
              />
              <Card
                label="Robot Type"
                value={datasetInfo.robot_type ?? "unknown"}
              />
            </div>

            {episodeLengthStatsError && (
              <div className="mt-5 rounded-lg border border-red-400/30 bg-red-400/5 p-4 text-sm text-red-200">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-red-100">
                      Episode statistics could not be loaded
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200/85">
                      {episodeLengthStatsError}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onRetryEpisodeStats}
                    className="shrink-0 rounded-md border border-red-300/30 px-3 py-1.5 text-xs text-red-100 transition-colors hover:border-red-200/70 hover:bg-red-300/10"
                  >
                    Retry statistics
                  </button>
                </div>
              </div>
            )}

            {episodeLengthStatsLoading ? (
              <div className="mt-5 rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
                <LoadingLine>
                  Computing episode length distribution…
                </LoadingLine>
              </div>
            ) : episodeLengthStats ? (
              <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
                <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                      Episode Length Distribution
                    </h4>
                    <span className="text-[10px] text-slate-500">
                      {episodeLengthStats.allEpisodeLengths.length.toLocaleString()}{" "}
                      episodes
                    </span>
                  </div>
                  <EpisodeLengthHistogram
                    data={episodeLengthStats.episodeLengthHistogram}
                    episodes={episodeLengthStats.allEpisodeLengths}
                    binning={episodeLengthStats.episodeLengthHistogramBinning}
                  />
                </div>
                <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                      Episode Details
                    </h4>
                    <span className="text-[10px] text-slate-500">
                      expand a duration range
                    </span>
                  </div>
                  <EpisodeDurationGroups stats={episodeLengthStats} />
                </div>
              </div>
            ) : !episodeLengthStatsError ? (
              <div className="mt-5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 text-xs text-amber-200/80">
                Episode duration metadata is unavailable for this dataset
                version.
              </div>
            ) : null}
          </section>

          <section className="rounded-xl border border-emerald-400/20 bg-[var(--surface-1)]/30 p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-200">
                  Custom Checks
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Workbench rules only: name format, average duration, and
                  prompt quality. PICO MoTracker is intentionally excluded.
                </p>
              </div>
              {checkSummary && (
                <span className="text-xs text-slate-400">{checkSummary}</span>
              )}
            </div>

            {qualityLoading ? (
              <LoadingLine>
                Loading task metadata and custom checks…
              </LoadingLine>
            ) : qualityError ? (
              <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200">
                {qualityError}
              </div>
            ) : quality ? (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-500">
                  <span className="rounded border border-white/10 px-2 py-1">
                    {quality.tasks.length.toLocaleString()} task prompts loaded
                  </span>
                  {quality.config?.avg_duration && (
                    <span className="rounded border border-white/10 px-2 py-1">
                      Average duration target:{" "}
                      {quality.config.avg_duration.min_sec}–
                      {quality.config.avg_duration.max_sec}s
                    </span>
                  )}
                  {quality.config?.prompt && (
                    <span className="rounded border border-white/10 px-2 py-1">
                      Prompt target: {quality.config.prompt.min_words}–
                      {quality.config.prompt.max_words} words
                    </span>
                  )}
                </div>
                {quality.checks.map((check) => (
                  <div
                    key={check.id}
                    className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-200">
                          {check.title}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {check.message}
                        </p>
                      </div>
                      <StatusBadge status={check.status} />
                    </div>
                    {check.details && check.details.length > 0 && (
                      <details className="mt-2 text-xs text-slate-500">
                        <summary className="cursor-pointer select-none hover:text-slate-300">
                          {check.details.length} detail
                          {check.details.length === 1 ? "" : "s"}
                        </summary>
                        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto border-l border-white/10 pl-3">
                          {check.details.map((detail, index) => (
                            <li key={`${check.id}-${index}`}>{detail}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <LoadingLine>Custom checks have not run yet.</LoadingLine>
            )}
          </section>
        </>
      )}
    </div>
  );
}

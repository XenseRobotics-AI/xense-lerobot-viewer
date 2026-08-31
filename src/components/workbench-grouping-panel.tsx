"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import {
  WORKBENCH_LEFT_SN_DAILY_TARGET_HOURS,
  WORKBENCH_LEFT_SN_REWARD_AMOUNT,
  computeWorkbenchAdditionRollup,
  computeWorkbenchAdditionTimeline,
  formatWorkbenchRewardCoins,
  workbenchAdditionAvailableDays,
  workbenchGroupAdditionDatasetNames,
  getWorkbenchDefaultDateRange,
  getWorkbenchOkrAchievementRate,
  getWorkbenchLeftSnWorkstation,
  getWorkbenchLeftSnTargetHours,
  getWorkbenchOkrRewardAmount,
  getWorkbenchOkrSymbol,
  normalizeWorkbenchDateRange,
  type WorkbenchDailyAddition,
  type WorkbenchRollupDataset,
  type WorkbenchRollupDimension,
  type WorkbenchRollupRow,
} from "@/utils/workbenchRollup";

const DIMENSIONS: Array<{
  value: WorkbenchRollupDimension;
  label: string;
}> = [
  { value: "uploader", label: "上传者" },
  { value: "task", label: "任务" },
  { value: "robot_type", label: "robot_type" },
  { value: "left_gripper_sn", label: "Left SN" },
  { value: "source", label: "source" },
];

type WorkbenchDataset = LocalDatasetSummary & {
  hf?: {
    lastModified?: string | null;
    uploader?: string | null;
    uploaderDisplayName?: string | null;
  };
  lastModified?: string | null;
  uploader?: string | null;
  uploaderDisplayName?: string | null;
  dailyAdditions?: WorkbenchDailyAddition[];
};

type WorkbenchWorkstationMappingsPayload = {
  mappings?: Record<string, string>;
  defaults?: Record<string, string>;
  source?: "stored" | "defaults";
  updatedAt?: string | null;
};

type WorkbenchStatisticsPayload = {
  datasets?: WorkbenchDataset[];
  errors?: Array<{ path: string; message: string }>;
  workstationMappings?: WorkbenchWorkstationMappingsPayload;
  error?: string;
};

function formatHours(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatRows(rows: WorkbenchRollupRow[]): string {
  return rows.length === 1 ? "1 group" : `${rows.length} groups`;
}

function yAxisWidth(rows: WorkbenchRollupRow[]): number {
  const longest = rows.reduce((max, row) => Math.max(max, row.group.length), 0);
  return Math.min(180, Math.max(72, longest * 7));
}

function datasetNamesTitle(names: string[] | undefined): string | undefined {
  if (!names?.length) return undefined;
  return `Datasets:\n${names.join("\n")}`;
}

function cleanStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    output[key] = value;
  }
  return output;
}

function stringRecordsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left).filter((key) => left[key]?.trim());
  const rightKeys = Object.keys(right).filter((key) => right[key]?.trim());
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key]?.trim() === right[key]?.trim());
}

export default function WorkbenchGroupingPanel({
  organization,
  refreshToken = 0,
}: {
  organization: string;
  refreshToken?: number;
}) {
  const [dimension, setDimension] =
    useState<WorkbenchRollupDimension>("uploader");
  const [datasets, setDatasets] = useState<WorkbenchDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefreshToken, setLocalRefreshToken] = useState(0);
  const [defaultDateRange] = useState(() => getWorkbenchDefaultDateRange());
  const [startDate, setStartDate] = useState(defaultDateRange.startDate ?? "");
  const [endDate, setEndDate] = useState(defaultDateRange.endDate ?? "");
  const [leftSnDailyTargetHours, setLeftSnDailyTargetHours] = useState(
    WORKBENCH_LEFT_SN_DAILY_TARGET_HOURS,
  );
  const [leftSnRewardAmount, setLeftSnRewardAmount] = useState(
    WORKBENCH_LEFT_SN_REWARD_AMOUNT,
  );
  const [workstationMappings, setWorkstationMappings] = useState<
    Record<string, string>
  >({});
  const [workstationDefaults, setWorkstationDefaults] = useState<
    Record<string, string>
  >({});
  const [workstationDraft, setWorkstationDraft] = useState<
    Record<string, string>
  >({});
  const [workstationSource, setWorkstationSource] = useState<
    "stored" | "defaults"
  >("defaults");
  const [mappingsOpen, setMappingsOpen] = useState(false);
  const [mappingsSaving, setMappingsSaving] = useState(false);
  const [mappingsError, setMappingsError] = useState<string | null>(null);
  const [mappingsMessage, setMappingsMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/workbench/statistics?org=${encodeURIComponent(organization)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => ({}))) as WorkbenchStatisticsPayload;
        if (!response.ok) {
          throw new Error(
            payload.error ||
              `Workbench statistics request failed (${response.status})`,
          );
        }
        if (!payload.datasets) {
          throw new Error("Workbench statistics response is incomplete.");
        }
        return payload;
      })
      .then((payload) => {
        const mappings = cleanStringRecord(
          payload.workstationMappings?.mappings,
        );
        const defaults = cleanStringRecord(
          payload.workstationMappings?.defaults,
        );
        setDatasets(payload.datasets ?? []);
        setWorkstationMappings(mappings);
        setWorkstationDefaults(defaults);
        setWorkstationDraft(mappings);
        setWorkstationSource(
          payload.workstationMappings?.source === "stored"
            ? "stored"
            : "defaults",
        );
        setMappingsError(null);
        setMappingsMessage(null);
        if ((payload.errors?.length ?? 0) > 0) {
          setError(
            `${payload.errors?.length} dataset path(s) could not be scanned. The visible rows are still grouped.`,
          );
        }
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organization, refreshToken, localRefreshToken]);

  const rollupDatasets = useMemo<WorkbenchRollupDataset[]>(
    () =>
      datasets.map((dataset) => ({
        ...dataset,
        lastModified: dataset.lastModified ?? dataset.hf?.lastModified ?? null,
        uploader: dataset.uploader ?? dataset.hf?.uploader ?? null,
        uploaderDisplayName:
          dataset.uploaderDisplayName ??
          dataset.hf?.uploaderDisplayName ??
          null,
      })),
    [datasets],
  );

  const availableDays = useMemo(
    () => workbenchAdditionAvailableDays(rollupDatasets),
    [rollupDatasets],
  );
  const defaultRange = defaultDateRange;
  const range = useMemo(
    () => normalizeWorkbenchDateRange(startDate, endDate, availableDays),
    [availableDays, endDate, startDate],
  );
  const effectiveStartDate = startDate || defaultRange.startDate || "";
  const effectiveEndDate = endDate || defaultRange.endDate || "";
  const missingDates = availableDays.length === 0 && rollupDatasets.length > 0;

  const rows = useMemo(
    () =>
      computeWorkbenchAdditionRollup(rollupDatasets, dimension, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [dimension, range.endDate, range.startDate, rollupDatasets],
  );
  const leftSnDatasetNames = useMemo(
    () =>
      workbenchGroupAdditionDatasetNames(rollupDatasets, "left_gripper_sn", {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, rollupDatasets],
  );
  const timeline = useMemo(
    () =>
      computeWorkbenchAdditionTimeline(rollupDatasets, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, rollupDatasets],
  );
  const chartRows = rows.slice(0, 20).map((row) => ({
    ...row,
    label: row.group,
  }));
  const timelineRows = timeline.rows.map((row) => ({
    ...row,
    date: row.day.slice(5),
  }));
  const showLeftSnOkr = dimension === "left_gripper_sn";
  const leftSnTargetHours = showLeftSnOkr
    ? getWorkbenchLeftSnTargetHours(range, leftSnDailyTargetHours)
    : null;
  const workstationEditorRows = showLeftSnOkr
    ? rows.filter((row) => row.group !== "—")
    : [];
  const workstationDraftIsDirty = !stringRecordsEqual(
    workstationDraft,
    workstationMappings,
  );

  const saveWorkstationMappings = async () => {
    setMappingsSaving(true);
    setMappingsError(null);
    setMappingsMessage(null);
    try {
      const response = await fetch(
        `/api/workbench/workstation-mappings?org=${encodeURIComponent(
          organization,
        )}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mappings: workstationDraft }),
          cache: "no-store",
        },
      );
      const payload = (await response
        .json()
        .catch(() => ({}))) as WorkbenchWorkstationMappingsPayload & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error ||
            `Workbench mappings save failed (${response.status})`,
        );
      }
      const mappings = cleanStringRecord(payload.mappings);
      const defaults = cleanStringRecord(payload.defaults);
      setWorkstationMappings(mappings);
      setWorkstationDraft(mappings);
      if (Object.keys(defaults).length > 0) setWorkstationDefaults(defaults);
      setWorkstationSource(payload.source === "stored" ? "stored" : "defaults");
      setMappingsMessage("Workstation mappings saved.");
    } catch (reason: unknown) {
      setMappingsError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setMappingsSaving(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">
            Grouped statistics
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Strict Workbench additions by HF commit diff date. Dates use UTC,
            the end date is exclusive, and filters do not touch parquet or video
            files.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>Group by</span>
            <select
              value={dimension}
              onChange={(event) =>
                setDimension(event.target.value as WorkbenchRollupDimension)
              }
              className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none"
            >
              {DIMENSIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>Start</span>
            <input
              type="date"
              value={effectiveStartDate}
              max={effectiveEndDate || undefined}
              disabled={availableDays.length === 0}
              onChange={(event) => setStartDate(event.target.value)}
              className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>End</span>
            <input
              type="date"
              value={effectiveEndDate}
              min={effectiveStartDate || undefined}
              disabled={availableDays.length === 0}
              onChange={(event) => setEndDate(event.target.value)}
              className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
            />
          </label>
          {showLeftSnOkr && (
            <>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span>Daily OKR h</span>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  value={leftSnDailyTargetHours}
                  onChange={(event) =>
                    setLeftSnDailyTargetHours(
                      parseNonNegativeNumber(event.target.value),
                    )
                  }
                  className="w-24 rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-right tabular-nums text-slate-200 focus:border-cyan-400 focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span>Reward</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={leftSnRewardAmount}
                  onChange={(event) =>
                    setLeftSnRewardAmount(
                      parseNonNegativeNumber(event.target.value),
                    )
                  }
                  className="w-24 rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-right tabular-nums text-slate-200 focus:border-cyan-400 focus:outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => setMappingsOpen((value) => !value)}
                className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200"
              >
                Workstation mappings
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              const next = getWorkbenchDefaultDateRange();
              setStartDate(next.startDate ?? "");
              setEndDate(next.endDate ?? "");
            }}
            disabled={
              startDate === defaultRange.startDate &&
              endDate === defaultRange.endDate
            }
            className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
          >
            Reset range
          </button>
          <button
            type="button"
            onClick={() => setLocalRefreshToken((value) => value + 1)}
            disabled={loading}
            className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
          >
            Reload local data
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-200">
          {error}
        </div>
      )}

      {missingDates && !loading && (
        <div className="rounded-lg border border-white/10 bg-white/[0.025] p-3 text-xs text-slate-500">
          Strict HF addition metadata is not cached for these datasets yet.
          Refresh statistics can update lightweight metadata; commit-diff
          history is read from the local Workbench cache when available.
        </div>
      )}

      {showLeftSnOkr && mappingsOpen && !loading && (
        <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Workstation mappings
              </h4>
              <p className="mt-1 text-[11px] text-slate-500">
                {workstationSource === "stored"
                  ? "Saved config"
                  : "Default mapping"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setWorkstationDraft({ ...workstationDefaults })}
                disabled={mappingsSaving}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
              >
                Import defaults
              </button>
              <button
                type="button"
                onClick={() => setWorkstationDraft({ ...workstationMappings })}
                disabled={mappingsSaving || !workstationDraftIsDirty}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={saveWorkstationMappings}
                disabled={mappingsSaving || !workstationDraftIsDirty}
                className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:opacity-50"
              >
                {mappingsSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          {(mappingsError || mappingsMessage) && (
            <div
              className={`mb-3 rounded-md border px-3 py-2 text-xs ${
                mappingsError
                  ? "border-amber-400/25 bg-amber-400/5 text-amber-200"
                  : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
              }`}
            >
              {mappingsError || mappingsMessage}
            </div>
          )}
          <div className="overflow-x-auto rounded-md border border-white/10">
            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
              <thead className="bg-[var(--surface-2)] text-slate-400">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Group</th>
                  <th className="px-3 py-2.5 font-medium">Workstation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {workstationEditorRows.map((row) => (
                  <tr key={row.group} className="text-slate-200">
                    <td className="px-3 py-2.5 font-mono text-[11px]">
                      {row.group}
                    </td>
                    <td className="px-3 py-2.5">
                      <input
                        type="text"
                        value={workstationDraft[row.group] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setWorkstationDraft((current) => ({
                            ...current,
                            [row.group]: value,
                          }));
                        }}
                        placeholder="—"
                        className="w-32 rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {workstationEditorRows.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-slate-500">
                No left SN groups are available in this date range.
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-5 text-sm text-slate-400">
          Loading Workbench statistics…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-5 text-sm text-slate-400">
          No strict additions are available for this grouping and date range.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full table-fixed border-collapse text-left text-xs">
              <colgroup>
                <col style={{ width: showLeftSnOkr ? "18%" : "40%" }} />
                {showLeftSnOkr && <col style={{ width: "11%" }} />}
                <col style={{ width: showLeftSnOkr ? "9%" : "15%" }} />
                <col style={{ width: showLeftSnOkr ? "10%" : "15%" }} />
                <col style={{ width: showLeftSnOkr ? "11%" : "15%" }} />
                <col style={{ width: showLeftSnOkr ? "8%" : "15%" }} />
                {showLeftSnOkr && <col style={{ width: "7%" }} />}
                {showLeftSnOkr && <col style={{ width: "10%" }} />}
                {showLeftSnOkr && <col style={{ width: "16%" }} />}
              </colgroup>
              <thead className="bg-[var(--surface-2)] text-slate-400">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Group</th>
                  {showLeftSnOkr && (
                    <th className="px-3 py-2.5 font-medium">Workstation</th>
                  )}
                  <th className="px-3 py-2.5 text-right font-medium">
                    Datasets
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Episodes
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">Hours</th>
                  <th className="px-3 py-2.5 text-right font-medium">Share</th>
                  {showLeftSnOkr && (
                    <th className="px-3 py-2.5 text-center font-medium">OKR</th>
                  )}
                  {showLeftSnOkr && (
                    <th className="px-3 py-2.5 text-right font-medium">
                      OKR达成率
                    </th>
                  )}
                  {showLeftSnOkr && (
                    <th className="px-3 py-2.5 text-right font-medium">
                      Reward
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rows.map((row) => {
                  const workstation = getWorkbenchLeftSnWorkstation(
                    row.group,
                    workstationMappings,
                  );
                  const okrSymbol =
                    leftSnTargetHours === null
                      ? "—"
                      : getWorkbenchOkrSymbol(row.hours, leftSnTargetHours);
                  const achievementRate =
                    leftSnTargetHours === null
                      ? null
                      : getWorkbenchOkrAchievementRate(
                          row.hours,
                          leftSnTargetHours,
                        );
                  const rewardAmount =
                    leftSnTargetHours === null
                      ? null
                      : getWorkbenchOkrRewardAmount(
                          row.hours,
                          leftSnTargetHours,
                          leftSnRewardAmount,
                        );
                  const groupTitle = showLeftSnOkr
                    ? datasetNamesTitle(leftSnDatasetNames.get(row.group))
                    : row.group;
                  return (
                    <tr key={row.group} className="text-slate-200">
                      <td
                        className="truncate px-3 py-2.5 font-medium"
                        title={groupTitle}
                      >
                        {row.group}
                      </td>
                      {showLeftSnOkr && (
                        <td
                          className="px-3 py-2.5 font-medium text-slate-300"
                          title={workstation}
                        >
                          {workstation}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {row.count.toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {row.episodes.toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {formatHours(row.hours)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {row.pctHours.toFixed(1)}%
                      </td>
                      {showLeftSnOkr && (
                        <td className="px-3 py-2.5 text-center text-base leading-none">
                          {okrSymbol}
                        </td>
                      )}
                      {showLeftSnOkr && (
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {achievementRate === null
                            ? "—"
                            : `${achievementRate.toFixed(1)}%`}
                        </td>
                      )}
                      {showLeftSnOkr && (
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {rewardAmount === null
                            ? "—"
                            : formatWorkbenchRewardCoins(rewardAmount)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)]">
            <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Hours by group
                </h4>
                <span className="text-[10px] text-slate-500">
                  {formatRows(rows)}
                </span>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartRows}
                    layout="vertical"
                    margin={{ top: 4, right: 16, bottom: 4, left: 4 }}
                  >
                    <CartesianGrid
                      stroke="rgba(148,163,184,0.12)"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      stroke="#64748b"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(value) => `${value}`}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={yAxisWidth(chartRows)}
                      stroke="#64748b"
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 6,
                        color: "#e2e8f0",
                        fontSize: 12,
                      }}
                      formatter={(value) => [
                        `${formatHours(Number(value))} h`,
                        "Hours",
                      ]}
                    />
                    <Bar dataKey="hours" fill="#fb923c" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="space-y-4">
              <div className="overflow-x-auto rounded-lg border border-white/10">
                <table className="w-full min-w-[540px] border-collapse text-left text-xs">
                  <thead className="bg-[var(--surface-2)] text-slate-400">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">Date</th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        Datasets
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        Episodes
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        Hours
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        Cumulative h
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {timeline.rows.map((row) => (
                      <tr key={row.day} className="text-slate-200">
                        <td className="px-3 py-2.5 font-medium">{row.day}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {row.datasets.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {row.episodes.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {formatHours(row.hours)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {formatHours(row.cumulativeHours)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {timeline.rows.length === 0 && (
                  <div className="px-4 py-8 text-center text-xs text-slate-500">
                    No dated HF metadata is available in the selected range.
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    Daily trend
                  </h4>
                  <span className="text-[10px] text-slate-500">
                    {timeline.total.datasets.toLocaleString()} datasets ·{" "}
                    {formatHours(timeline.total.hours)} h
                  </span>
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={timelineRows}
                      margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid stroke="rgba(148,163,184,0.12)" />
                      <XAxis
                        dataKey="date"
                        stroke="#64748b"
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis
                        stroke="#64748b"
                        tick={{ fontSize: 10 }}
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#0f172a",
                          border: "1px solid rgba(255,255,255,0.12)",
                          borderRadius: 6,
                          color: "#e2e8f0",
                          fontSize: 12,
                        }}
                        formatter={(value, name) => [
                          typeof value === "number" &&
                          String(name).includes("Hours")
                            ? `${formatHours(value)} h`
                            : Number(value).toLocaleString(),
                          name,
                        ]}
                        labelFormatter={(_, entries) =>
                          entries?.[0]?.payload?.day ?? ""
                        }
                      />
                      <Line
                        type="monotone"
                        dataKey="hours"
                        name="Daily Hours"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="cumulativeHours"
                        name="Cumulative Hours"
                        stroke="#fb923c"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
  computeWorkbenchAdditionTimeline,
  computeWorkbenchAdditionRollup,
  countHalfOpenDays,
  getWorkbenchDefaultDateTimeRange,
  getWorkbenchOkrAchievementRate,
  normalizeWorkbenchDateRange,
  workbenchAdditionAvailableDays,
  workbenchGroupAdditionDatasetNames,
  workbenchGroupSourceRepoIds,
  type WorkbenchDailyAddition,
  type WorkbenchRollupDataset,
  type WorkbenchRollupDimension,
  type WorkbenchRollupRow,
} from "@/utils/workbenchRollup";
import {
  countWorkbenchRewardTargetHours,
  evaluateWorkbenchRewardRules,
  formatWorkbenchRewardAmount,
  type WorkbenchRewardRuleLevel,
  type WorkbenchRewardRulesConfig,
} from "@/utils/workbenchRewards";
import WorkbenchMailComposer from "@/components/workbench-mail-composer";

const DIMENSIONS: Array<{
  value: WorkbenchRollupDimension;
  label: string;
}> = [
  { value: "robot_id", label: "Robot ID" },
  { value: "uploader", label: "上传者" },
  { value: "task", label: "任务" },
  { value: "robot_type", label: "robot_type" },
  { value: "left_gripper_sn", label: "Left SN (legacy)" },
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
  legacyMappings?: Record<string, string>;
  defaults?: Record<string, string>;
  legacyDefaults?: Record<string, string>;
  source?: "stored" | "defaults";
  updatedAt?: string | null;
};

type WorkbenchRewardRulesPayload = WorkbenchRewardRulesConfig & {
  org?: string;
  source?: "stored" | "defaults";
  updatedAt?: string | null;
  defaults?: WorkbenchRewardRulesConfig;
};

type WorkbenchStatisticsPayload = {
  datasets?: WorkbenchDataset[];
  errors?: Array<{ path: string; message: string }>;
  workstationMappings?: WorkbenchWorkstationMappingsPayload;
  rewardRules?: WorkbenchRewardRulesPayload;
  rewardRuleDefaults?: WorkbenchRewardRulesConfig;
  error?: string;
};

type WorkbenchDashboardRow = WorkbenchRollupRow & {
  robotId: string | null;
  leftGripperSn: string | null;
  workstation: string;
  reward: ReturnType<typeof evaluateWorkbenchRewardRules>;
  sourceRepoIds: string[];
  dailyHours: Record<string, number>;
};

type RewardRulesDraft = WorkbenchRewardRulesConfig & { org: string };

type HeatmapRow = {
  robotId: string;
  leftGripperSn: string | null;
  workstation: string;
  hoursByDay: Record<string, number>;
  totalHours: number;
};

type AlertItem = {
  kind: "warn" | "info" | "error";
  title: string;
  detail: string;
};

function formatHours(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatChange(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatHours(value)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function cleanStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    output[key.trim()] = trimmed;
  }
  return output;
}

function recordsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left).filter((key) => left[key]?.trim());
  const rightKeys = Object.keys(right).filter((key) => right[key]?.trim());
  if (leftKeys.length !== rightKeys.length) return false;
  leftKeys.sort();
  rightKeys.sort();
  return leftKeys.every((key, index) => {
    const rightKey = rightKeys[index];
    return key === rightKey && left[key]?.trim() === right[rightKey]?.trim();
  });
}

function cloneRewardLevels(
  levels: WorkbenchRewardRuleLevel[],
): WorkbenchRewardRuleLevel[] {
  return levels.map((level) => ({ ...level }));
}

function cloneRewardDraft(
  config: WorkbenchRewardRulesConfig,
  org: string,
): RewardRulesDraft {
  return {
    org,
    enabled: config.enabled,
    dailyTargetHours: config.dailyTargetHours,
    levels: cloneRewardLevels(config.levels),
  };
}

function emptyRewardDraft(org: string): RewardRulesDraft {
  return {
    org,
    enabled: true,
    dailyTargetHours: 6,
    levels: [
      {
        id: "below-80",
        label: "不达标",
        minPercent: 0,
        maxPercent: 80,
        amount: -160,
      },
      {
        id: "80-90",
        label: "接近",
        minPercent: 80,
        maxPercent: 90,
        amount: -60,
      },
      {
        id: "90-100",
        label: "临界",
        minPercent: 90,
        maxPercent: 100,
        amount: 0,
      },
      {
        id: "100-plus",
        label: "达标",
        minPercent: 100,
        maxPercent: null,
        amount: 200,
      },
    ],
  };
}

function validateRewardDraft(draft: RewardRulesDraft): string | null {
  if (!draft.enabled) return null;
  if (!Number.isFinite(draft.dailyTargetHours) || draft.dailyTargetHours <= 0) {
    return "Daily target hours must be greater than 0.";
  }
  if (draft.levels.length === 0) return "Add at least one reward level.";
  const sorted = [...draft.levels].sort(
    (left, right) => left.minPercent - right.minPercent,
  );
  if (Math.abs(sorted[0]?.minPercent ?? 0) > 1e-9) {
    return "The first level must start at 0%.";
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const level = sorted[index];
    if (!Number.isFinite(level.minPercent) || level.minPercent < 0) {
      return "Level thresholds must be valid numbers.";
    }
    if (!Number.isFinite(level.amount)) {
      return "Level amounts must be valid numbers.";
    }
    if (index > 0) {
      const previous = sorted[index - 1];
      if (previous.maxPercent === null) {
        return "Only the last level can be open-ended.";
      }
      if (Math.abs(previous.maxPercent - level.minPercent) > 1e-9) {
        return "Level ranges must be continuous.";
      }
    }
  }
  return null;
}

function mergeMappings(
  canonical: Record<string, string>,
  legacy: Record<string, string>,
): Record<string, string> {
  return {
    ...legacy,
    ...canonical,
  };
}

function dateInRange(
  day: string,
  startDate: string | null,
  endDate: string | null,
): boolean {
  if (startDate && day < startDate) return false;
  if (endDate && day >= endDate) return false;
  return true;
}

function dayKeyFromDateTimeInput(value: string): string | null {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/u);
  return match?.[1] ?? null;
}

function sourceRepoTitle(repoIds: readonly string[]): string | undefined {
  if (repoIds.length === 0) return undefined;
  return "Source repos:\n" + repoIds.join("\n");
}

function titleCaseStatus(status: string): string {
  switch (status) {
    case "mapped":
      return "Mapped";
    case "unmapped":
      return "Unmapped";
    case "legacy":
      return "Legacy";
    case "alerts":
      return "Alerts";
    default:
      return "All";
  }
}

export default function WorkbenchGroupingPanel({
  organization,
  refreshToken = 0,
}: {
  organization: string;
  refreshToken?: number;
}) {
  const [dimension, setDimension] =
    useState<WorkbenchRollupDimension>("robot_id");
  const [datasets, setDatasets] = useState<WorkbenchDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefreshToken, setLocalRefreshToken] = useState(0);
  const [defaultDateTimeRange] = useState(() =>
    getWorkbenchDefaultDateTimeRange(),
  );
  const [startDateTime, setStartDateTime] = useState(
    defaultDateTimeRange.startDateTime,
  );
  const [endDateTime, setEndDateTime] = useState(
    defaultDateTimeRange.endDateTime,
  );
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [workstationMappings, setWorkstationMappings] = useState<
    Record<string, string>
  >({});
  const [workstationLegacyMappings, setWorkstationLegacyMappings] = useState<
    Record<string, string>
  >({});
  const [workstationDefaults, setWorkstationDefaults] = useState<
    Record<string, string>
  >({});
  const [workstationLegacyDefaults, setWorkstationLegacyDefaults] = useState<
    Record<string, string>
  >({});
  const [workstationDraft, setWorkstationDraft] = useState<
    Record<string, string>
  >({});
  const [workstationLegacyDraft, setWorkstationLegacyDraft] = useState<
    Record<string, string>
  >({});
  const [rewardDraft, setRewardDraft] = useState<RewardRulesDraft>(() =>
    emptyRewardDraft(organization),
  );
  const [rewardDefaults, setRewardDefaults] = useState<RewardRulesDraft>(() =>
    emptyRewardDraft(organization),
  );
  const [mappingEditorOpen, setMappingEditorOpen] = useState(false);
  const [rewardEditorOpen, setRewardEditorOpen] = useState(false);
  const [mappingsSaving, setMappingsSaving] = useState(false);
  const [rewardSaving, setRewardSaving] = useState(false);
  const [mappingsError, setMappingsError] = useState<string | null>(null);
  const [mappingsMessage, setMappingsMessage] = useState<string | null>(null);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [rewardMessage, setRewardMessage] = useState<string | null>(null);

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
        const legacyMappings = cleanStringRecord(
          payload.workstationMappings?.legacyMappings,
        );
        const defaults = cleanStringRecord(
          payload.workstationMappings?.defaults,
        );
        const legacyDefaults = cleanStringRecord(
          payload.workstationMappings?.legacyDefaults,
        );
        setDatasets(payload.datasets ?? []);
        setWorkstationMappings(mappings);
        setWorkstationLegacyMappings(legacyMappings);
        setWorkstationDefaults(defaults);
        setWorkstationLegacyDefaults(legacyDefaults);
        setWorkstationDraft(mappings);
        setWorkstationLegacyDraft(legacyMappings);
        const rewardConfig = payload.rewardRules;
        const rewardDefaultConfig =
          payload.rewardRuleDefaults ?? emptyRewardDraft(organization);
        const rewardBase = cloneRewardDraft(
          {
            enabled: rewardConfig?.enabled ?? rewardDefaultConfig.enabled,
            dailyTargetHours:
              rewardConfig?.dailyTargetHours ??
              rewardDefaultConfig.dailyTargetHours,
            levels: rewardConfig?.levels ?? rewardDefaultConfig.levels,
          },
          organization,
        );
        setRewardDraft(rewardBase);
        setRewardDefaults(cloneRewardDraft(rewardDefaultConfig, organization));
        setMappingsError(null);
        setMappingsMessage(null);
        setRewardError(null);
        setRewardMessage(null);
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
    () => Array.from(new Set(workbenchAdditionAvailableDays(rollupDatasets))),
    [rollupDatasets],
  );
  const range = useMemo(
    () =>
      normalizeWorkbenchDateRange(
        dayKeyFromDateTimeInput(startDateTime),
        dayKeyFromDateTimeInput(endDateTime),
        availableDays,
      ),
    [availableDays, endDateTime, startDateTime],
  );
  const rangeDays = countHalfOpenDays(range);
  const targetHours = countWorkbenchRewardTargetHours(
    rangeDays,
    rewardDraft.dailyTargetHours,
  );
  const targetLabel = targetHours === null ? "—" : formatHours(targetHours);
  const totalTimeline = useMemo(
    () =>
      computeWorkbenchAdditionTimeline(rollupDatasets, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, rollupDatasets],
  );
  const robotRows = useMemo(
    () =>
      computeWorkbenchAdditionRollup(rollupDatasets, "robot_id", {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, rollupDatasets],
  );
  const selectedRows = useMemo(
    () =>
      computeWorkbenchAdditionRollup(rollupDatasets, dimension, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [dimension, range.endDate, range.startDate, rollupDatasets],
  );
  const rowNames = useMemo(
    () =>
      workbenchGroupAdditionDatasetNames(rollupDatasets, dimension, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [dimension, range.endDate, range.startDate, rollupDatasets],
  );
  const robotSourceRepoMap = useMemo(
    () =>
      workbenchGroupSourceRepoIds(rollupDatasets, "robot_id", {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, rollupDatasets],
  );
  const visibleDays = useMemo(
    () =>
      availableDays.filter((day) =>
        dateInRange(day, range.startDate, range.endDate),
      ),
    [availableDays, range.endDate, range.startDate],
  );
  const heatmapRows = useMemo<HeatmapRow[]>(() => {
    const rows = new Map<string, HeatmapRow>();
    for (const dataset of rollupDatasets) {
      const robotId = dataset.robotId?.trim() || "—";
      const row = rows.get(robotId) ?? {
        robotId,
        leftGripperSn: dataset.leftGripperSn ?? null,
        workstation:
          robotId === "—"
            ? "—"
            : (workstationDraft[robotId] ??
              workstationMappings[robotId] ??
              workstationDefaults[robotId] ??
              "—"),
        hoursByDay: {},
        totalHours: 0,
      };
      if (!row.leftGripperSn && dataset.leftGripperSn) {
        row.leftGripperSn = dataset.leftGripperSn;
      }
      for (const addition of dataset.dailyAdditions ?? []) {
        if (!dateInRange(addition.day, range.startDate, range.endDate))
          continue;
        const hours = Number(addition.hours);
        if (!Number.isFinite(hours) || hours <= 0) continue;
        row.hoursByDay[addition.day] =
          (row.hoursByDay[addition.day] ?? 0) + hours;
        row.totalHours += hours;
      }
      row.workstation =
        robotId === "—"
          ? "—"
          : (workstationDraft[robotId] ??
            workstationMappings[robotId] ??
            workstationDefaults[robotId] ??
            "—");
      rows.set(robotId, row);
    }
    return Array.from(rows.values()).sort(
      (left, right) =>
        right.totalHours - left.totalHours ||
        left.robotId.localeCompare(right.robotId),
    );
  }, [
    range.endDate,
    range.startDate,
    rollupDatasets,
    workstationDefaults,
    workstationDraft,
    workstationMappings,
  ]);
  const lineChartRows = totalTimeline.rows.map((row) => ({
    day: row.day.slice(5),
    hours: row.hours,
    cumulativeHours: row.cumulativeHours,
    datasets: row.datasets,
  }));
  const selectedChartRows = selectedRows.slice(0, 12).map((row) => ({
    group: row.group,
    hours: row.hours,
    count: row.count,
  }));

  const robotDashboardRows = useMemo<WorkbenchDashboardRow[]>(() => {
    const sourceRepoIds = robotSourceRepoMap;
    const grouped = new Map<string, WorkbenchDashboardRow>();
    for (const row of robotRows) {
      const repos = sourceRepoIds.get(row.group) ?? [];
      const sourceDataset = rollupDatasets.find(
        (dataset) => (dataset.robotId?.trim() || "—") === row.group,
      );
      const workstation =
        row.group === "—"
          ? sourceDataset?.leftGripperSn
            ? (workstationLegacyDraft[sourceDataset.leftGripperSn] ??
              workstationLegacyMappings[sourceDataset.leftGripperSn] ??
              workstationLegacyDefaults[sourceDataset.leftGripperSn] ??
              "—")
            : "—"
          : (workstationDraft[row.group] ??
            workstationMappings[row.group] ??
            workstationDefaults[row.group] ??
            "—");
      const dailyHours: Record<string, number> = {};
      for (const dataset of rollupDatasets) {
        const key = dataset.robotId?.trim() || "—";
        if (key !== row.group) continue;
        for (const addition of dataset.dailyAdditions ?? []) {
          if (!dateInRange(addition.day, range.startDate, range.endDate))
            continue;
          const hours = Number(addition.hours);
          if (!Number.isFinite(hours) || hours <= 0) continue;
          dailyHours[addition.day] = (dailyHours[addition.day] ?? 0) + hours;
        }
      }
      const reward = evaluateWorkbenchRewardRules(
        row.hours,
        targetHours ?? 0,
        rewardDraft,
      );
      grouped.set(row.group, {
        ...row,
        robotId: row.group === "—" ? null : row.group,
        leftGripperSn: sourceDataset?.leftGripperSn ?? null,
        workstation,
        reward,
        sourceRepoIds: repos,
        dailyHours,
      });
    }
    return Array.from(grouped.values());
  }, [
    range.endDate,
    range.startDate,
    rewardDraft,
    robotRows,
    robotSourceRepoMap,
    rollupDatasets,
    targetHours,
    workstationDefaults,
    workstationDraft,
    workstationLegacyDefaults,
    workstationLegacyDraft,
    workstationLegacyMappings,
    workstationMappings,
  ]);

  const mappedRows = robotDashboardRows.filter(
    (row) => row.robotId && row.workstation !== "—",
  );
  const unmappedRows = robotDashboardRows.filter(
    (row) => row.robotId && row.workstation === "—",
  );
  const legacyRows = robotDashboardRows.filter(
    (row) => !row.robotId && row.leftGripperSn,
  );
  const totalHours = totalTimeline.total.hours;
  const totalEpisodes = totalTimeline.total.episodes;
  const projectedRewardAmount = robotDashboardRows.reduce(
    (sum, row) => sum + row.reward.amount,
    0,
  );
  const rewardValidationError = validateRewardDraft(rewardDraft);
  const workstationDraftDirty = !recordsEqual(
    mergeMappings(workstationDraft, workstationLegacyDraft),
    mergeMappings(workstationMappings, workstationLegacyMappings),
  );
  const rewardDraftDirty =
    rewardDraft.enabled !== rewardDefaults.enabled ||
    rewardDraft.dailyTargetHours !== rewardDefaults.dailyTargetHours ||
    JSON.stringify(rewardDraft.levels) !==
      JSON.stringify(rewardDefaults.levels);

  const alerts = useMemo<AlertItem[]>(() => {
    const items: AlertItem[] = [];
    if (legacyRows.length > 0) {
      items.push({
        kind: "warn",
        title: "Legacy rows present",
        detail: `${legacyRows.length} row(s) still only have a left SN and need a robot_id backfill.`,
      });
    }
    if (unmappedRows.length > 0) {
      items.push({
        kind: "warn",
        title: "Unmapped robot IDs",
        detail: `${unmappedRows.length} robot_id row(s) do not resolve to a workstation yet.`,
      });
    }
    if (
      (workstationLegacyMappings &&
        Object.keys(workstationLegacyMappings).length > 0) ||
      (workstationLegacyDefaults &&
        Object.keys(workstationLegacyDefaults).length > 0)
    ) {
      items.push({
        kind: "info",
        title: "Legacy workstation config",
        detail:
          "Old left SN mappings were detected. They still display, but robot_id is now the primary key.",
      });
    }
    if (rewardValidationError) {
      items.push({
        kind: "error",
        title: "Reward rules need attention",
        detail: rewardValidationError,
      });
    }
    if ((totalTimeline.rows.length ?? 0) === 0 && rollupDatasets.length > 0) {
      items.push({
        kind: "info",
        title: "No daily additions in range",
        detail: "The selected window has no strict addition rows yet.",
      });
    }
    return items.slice(0, 5);
  }, [
    legacyRows.length,
    rewardValidationError,
    rollupDatasets.length,
    totalTimeline.rows.length,
    unmappedRows.length,
    workstationLegacyDefaults,
    workstationLegacyMappings,
  ]);

  const saveWorkstationMappings = useCallback(async () => {
    setMappingsSaving(true);
    setMappingsError(null);
    setMappingsMessage(null);
    try {
      const response = await fetch(
        `/api/workbench/workstation-mappings?org=${encodeURIComponent(organization)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mappings: mergeMappings(workstationDraft, workstationLegacyDraft),
          }),
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
      const legacyMappings = cleanStringRecord(payload.legacyMappings);
      const defaults = cleanStringRecord(payload.defaults);
      const legacyDefaults = cleanStringRecord(payload.legacyDefaults);
      setWorkstationMappings(mappings);
      setWorkstationLegacyMappings(legacyMappings);
      setWorkstationDraft(mappings);
      setWorkstationLegacyDraft(legacyMappings);
      if (Object.keys(defaults).length > 0) setWorkstationDefaults(defaults);
      if (Object.keys(legacyDefaults).length > 0)
        setWorkstationLegacyDefaults(legacyDefaults);
      setMappingsMessage("Workstation mappings saved.");
    } catch (reason: unknown) {
      setMappingsError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setMappingsSaving(false);
    }
  }, [organization, workstationDraft, workstationLegacyDraft]);

  const saveRewardRules = useCallback(async () => {
    setRewardSaving(true);
    setRewardError(null);
    setRewardMessage(null);
    try {
      const response = await fetch(
        `/api/workbench/reward-rules?org=${encodeURIComponent(organization)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules: rewardDraft }),
          cache: "no-store",
        },
      );
      const payload = (await response
        .json()
        .catch(() => ({}))) as WorkbenchRewardRulesPayload & { error?: string };
      if (!response.ok) {
        throw new Error(
          payload.error ||
            `Workbench reward rules save failed (${response.status})`,
        );
      }
      const next = cloneRewardDraft(
        {
          enabled: payload.enabled,
          dailyTargetHours: payload.dailyTargetHours,
          levels: payload.levels,
        },
        organization,
      );
      setRewardDraft(next);
      setRewardDefaults(
        cloneRewardDraft(
          {
            enabled: payload.defaults?.enabled ?? next.enabled,
            dailyTargetHours:
              payload.defaults?.dailyTargetHours ?? next.dailyTargetHours,
            levels: payload.defaults?.levels ?? next.levels,
          },
          organization,
        ),
      );
      setRewardMessage("Reward rules saved.");
    } catch (reason: unknown) {
      setRewardError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRewardSaving(false);
    }
  }, [organization, rewardDraft]);

  const resetDateRange = useCallback(() => {
    const next = getWorkbenchDefaultDateTimeRange();
    setStartDateTime(next.startDateTime);
    setEndDateTime(next.endDateTime);
  }, []);

  const restoreMappings = useCallback(() => {
    setWorkstationDraft(workstationMappings);
    setWorkstationLegacyDraft(workstationLegacyMappings);
  }, [workstationLegacyMappings, workstationMappings]);

  const restoreDefaultMappings = useCallback(() => {
    setWorkstationDraft(workstationDefaults);
    setWorkstationLegacyDraft(workstationLegacyDefaults);
  }, [workstationDefaults, workstationLegacyDefaults]);

  const restoreRewardDefaults = useCallback(() => {
    setRewardDraft(rewardDefaults);
  }, [rewardDefaults]);

  const updateRewardLevel = useCallback(
    (index: number, patch: Partial<WorkbenchRewardRuleLevel>) => {
      setRewardDraft((current) => ({
        ...current,
        levels: current.levels.map((level, levelIndex) =>
          levelIndex === index ? { ...level, ...patch } : level,
        ),
      }));
    },
    [],
  );

  const addRewardLevel = useCallback(() => {
    setRewardDraft((current) => {
      const last = current.levels.at(-1);
      const nextMin = last?.maxPercent ?? (last ? last.minPercent + 20 : 0);
      const nextLevel: WorkbenchRewardRuleLevel = {
        id: `level-${current.levels.length + 1}`,
        label: `Level ${current.levels.length + 1}`,
        minPercent: nextMin,
        maxPercent: null,
        amount: 0,
      };
      const nextLevels = current.levels.map((level, index) =>
        index === current.levels.length - 1 && level.maxPercent === null
          ? { ...level, maxPercent: nextMin }
          : level,
      );
      return {
        ...current,
        levels: [...nextLevels, nextLevel],
      };
    });
  }, []);

  const removeRewardLevel = useCallback((index: number) => {
    setRewardDraft((current) => {
      if (current.levels.length <= 1) return current;
      return {
        ...current,
        levels: current.levels.filter((_, levelIndex) => levelIndex !== index),
      };
    });
  }, []);

  const heatmapMaxHours = Math.max(
    1,
    ...heatmapRows.flatMap((row) =>
      visibleDays.map((day) => row.hoursByDay[day] ?? 0),
    ),
  );

  return (
    <section className="mx-auto w-full max-w-7xl space-y-4 py-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">
              Workbench dashboard
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Organization-level daily additions, workstation mapping, and
              reward rules.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <label className="flex items-center gap-2">
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
            <label className="flex items-center gap-2">
              <span>Start</span>
              <input
                type="datetime-local"
                value={startDateTime}
                max={endDateTime || undefined}
                step={60}
                disabled={availableDays.length === 0}
                onChange={(event) => setStartDateTime(event.target.value)}
                className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-2">
              <span>End</span>
              <input
                type="datetime-local"
                value={endDateTime}
                min={startDateTime || undefined}
                step={60}
                disabled={availableDays.length === 0}
                onChange={(event) => setEndDateTime(event.target.value)}
                className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-2">
              <span>Status</span>
              <select
                value={selectedStatus}
                onChange={(event) => setSelectedStatus(event.target.value)}
                className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none"
              >
                {[
                  ["all", "All"],
                  ["mapped", "Mapped"],
                  ["unmapped", "Unmapped"],
                  ["legacy", "Legacy"],
                  ["alerts", "Alerts"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={resetDateRange}
              className="rounded-md border border-white/10 px-3 py-2 text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200"
            >
              Reset range
            </button>
            <button
              type="button"
              onClick={() => setLocalRefreshToken((value) => value + 1)}
              disabled={loading}
              className="rounded-md border border-white/10 px-3 py-2 text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
            >
              Reload local data
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMappingEditorOpen((value) => !value)}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200"
          >
            Workstation mappings
          </button>
          <button
            type="button"
            onClick={() => setRewardEditorOpen((value) => !value)}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200"
          >
            Reward rules
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-4 text-xs text-slate-500">
          Loading Workbench dashboard…
        </div>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Total hours", formatHours(totalHours)],
              ["Episodes", formatCount(totalEpisodes)],
              ["Target", targetLabel],
              ["Projected reward", formatChange(projectedRewardAmount)],
              ["Mapped workstations", formatCount(mappedRows.length)],
              ["Unmapped robot IDs", formatCount(unmappedRows.length)],
              ["Legacy rows", formatCount(legacyRows.length)],
              [
                "Days in range",
                rangeDays === null ? "—" : formatCount(rangeDays),
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4"
              >
                <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  {label}
                </div>
                <div className="mt-2 text-lg font-semibold text-slate-100 tabular-nums">
                  {value}
                </div>
              </div>
            ))}
          </section>

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Workstation detail
                </h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  Robot ID is the primary key; left SN remains display-only when
                  available.
                </p>
              </div>
              <span className="text-[10px] text-slate-500">
                {rowNames.size === 0
                  ? "No grouped rows"
                  : `${rowNames.size} group(s)`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                <thead className="bg-[var(--surface-2)] text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">Robot ID</th>
                    <th className="px-3 py-2.5 font-medium">Left SN</th>
                    <th className="px-3 py-2.5 font-medium">Workstation</th>
                    <th className="px-3 py-2.5 font-medium">Datasets</th>
                    <th className="px-3 py-2.5 font-medium">Hours</th>
                    <th className="px-3 py-2.5 font-medium">Target</th>
                    <th className="px-3 py-2.5 font-medium">Rate</th>
                    <th className="px-3 py-2.5 font-medium">Rule</th>
                    <th className="px-3 py-2.5 font-medium">Reward</th>
                  </tr>
                </thead>
                <tbody>
                  {robotDashboardRows.map((row) => (
                    <tr
                      key={row.robotId ?? row.leftGripperSn ?? row.group}
                      className="border-t border-white/5"
                    >
                      <td
                        className="px-3 py-2.5 text-slate-100 tabular-nums"
                        title={sourceRepoTitle(row.sourceRepoIds)}
                      >
                        {row.robotId ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300">
                        {row.leftGripperSn ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-slate-100">
                        {row.workstation}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {formatCount(row.count)}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {formatHours(row.hours)}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {targetLabel}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {formatRate(
                          getWorkbenchOkrAchievementRate(
                            row.hours,
                            targetHours ?? 0,
                          ),
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {row.reward.level?.label ?? row.reward.symbol}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {formatWorkbenchRewardAmount(row.reward.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Workstation day heatmap
              </h4>
              <span className="text-[10px] text-slate-500">
                {visibleDays.length === 0
                  ? "No days in range"
                  : visibleDays.length + " days"}
              </span>
            </div>
            {visibleDays.length === 0 ? (
              <div className="rounded-md border border-white/10 bg-white/[0.02] p-4 text-xs text-slate-500">
                No strict addition days are available for this range.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div
                  className="min-w-[760px]"
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(13rem, 1.4fr) repeat(" +
                      visibleDays.length +
                      ", minmax(3.5rem, 1fr))",
                  }}
                >
                  <div className="border-b border-white/10 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    Robot / workstation
                  </div>
                  {visibleDays.map((day) => (
                    <div
                      key={day}
                      className="border-b border-white/10 px-2 py-2 text-center text-[10px] uppercase tracking-[0.12em] text-slate-500 tabular-nums"
                    >
                      {day.slice(5)}
                    </div>
                  ))}
                  {heatmapRows.slice(0, 12).map((row, rowIndex) => (
                    <Fragment key={row.robotId + "-" + rowIndex}>
                      <div className="border-b border-white/5 px-3 py-2 text-xs text-slate-200">
                        <div className="truncate font-medium">
                          {row.robotId}
                        </div>
                        <div className="truncate text-[10px] text-slate-500">
                          {row.workstation}
                          {row.leftGripperSn ? " · " + row.leftGripperSn : ""}
                        </div>
                      </div>
                      {visibleDays.map((day) => {
                        const hours = row.hoursByDay[day] ?? 0;
                        const alpha =
                          hours <= 0
                            ? 0.03
                            : Math.min(
                                0.85,
                                0.08 + (hours / heatmapMaxHours) * 0.75,
                              );
                        return (
                          <div
                            key={row.robotId + "-" + day}
                            className="border-b border-white/5 px-2 py-2 text-center text-xs tabular-nums text-slate-100"
                            style={{
                              backgroundColor:
                                "rgba(56, 189, 248, " + alpha + ")",
                            }}
                            title={
                              row.robotId +
                              " " +
                              day +
                              ": " +
                              formatHours(hours) +
                              "h"
                            }
                          >
                            {hours > 0 ? formatHours(hours) : "—"}
                          </div>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Daily trend
              </h4>
              <span className="text-[10px] text-slate-500">
                Total hours across the selected range
              </span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lineChartRows}>
                  <CartesianGrid
                    stroke="rgba(255,255,255,0.06)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="day"
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                  />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#0d1220",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 6,
                      color: "#e7ebf3",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="hours"
                    stroke="#38bdf8"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="cumulativeHours"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Top groups
                </h4>
              </div>
              <span className="text-[10px] text-slate-500">
                {titleCaseStatus(selectedStatus)}
              </span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={selectedChartRows} layout="vertical">
                  <CartesianGrid
                    stroke="rgba(255,255,255,0.06)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    type="number"
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="group"
                    width={120}
                    tick={{ fill: "#cbd5e1", fontSize: 10 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0d1220",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 6,
                      color: "#e7ebf3",
                    }}
                  />
                  <Bar dataKey="hours" fill="#38bdf8" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {mappingEditorOpen && (
            <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    Workstation mappings
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Canonical keys are robot_id. Legacy left SN entries are kept
                    for display and migration.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={restoreDefaultMappings}
                    disabled={mappingsSaving}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    Import defaults
                  </button>
                  <button
                    type="button"
                    onClick={restoreMappings}
                    disabled={mappingsSaving || !workstationDraftDirty}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={saveWorkstationMappings}
                    disabled={mappingsSaving || !workstationDraftDirty}
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
                <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                  <thead className="bg-[var(--surface-2)] text-slate-400">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">Robot ID</th>
                      <th className="px-3 py-2.5 font-medium">Left SN</th>
                      <th className="px-3 py-2.5 font-medium">Workstation</th>
                      <th className="px-3 py-2.5 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {robotDashboardRows.map((row) => (
                      <tr
                        key={row.robotId ?? row.leftGripperSn ?? row.group}
                        className="border-t border-white/5"
                      >
                        <td className="px-3 py-2.5 text-slate-100">
                          {row.robotId ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-slate-300">
                          {row.leftGripperSn ?? "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {row.robotId ? (
                            <input
                              value={
                                workstationDraft[row.robotId] ??
                                workstationMappings[row.robotId] ??
                                ""
                              }
                              onChange={(event) =>
                                setWorkstationDraft((current) => ({
                                  ...current,
                                  [row.robotId as string]: event.target.value,
                                }))
                              }
                              placeholder="Workstation"
                              className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          ) : (
                            <span className="text-slate-500">Legacy only</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-slate-300">
                          {row.robotId
                            ? "robot_id"
                            : row.leftGripperSn
                              ? "left SN"
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(Object.keys(workstationLegacyMappings).length > 0 ||
                Object.keys(workstationLegacyDefaults).length > 0) && (
                <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-100">
                  Legacy left SN mappings are still loaded. Keep them only if
                  the hardware file has not been backfilled with robot_id yet.
                </div>
              )}
            </section>
          )}

          {rewardEditorOpen && (
            <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    Reward rules
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Thresholds are expressed as completion percentage against
                    the selected range target.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    <span>Daily target</span>
                    <input
                      type="number"
                      min="0"
                      step="0.25"
                      value={rewardDraft.dailyTargetHours}
                      onChange={(event) =>
                        setRewardDraft((current) => ({
                          ...current,
                          dailyTargetHours: parseNonNegativeNumber(
                            event.target.value,
                          ),
                        }))
                      }
                      className="w-24 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-200 focus:border-cyan-400 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    <span>Enabled</span>
                    <input
                      type="checkbox"
                      checked={rewardDraft.enabled}
                      onChange={(event) =>
                        setRewardDraft((current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-cyan-400"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={restoreRewardDefaults}
                    disabled={rewardSaving}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    Restore defaults
                  </button>
                  <button
                    type="button"
                    onClick={addRewardLevel}
                    disabled={rewardSaving}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    Add level
                  </button>
                  <button
                    type="button"
                    onClick={saveRewardRules}
                    disabled={
                      rewardSaving ||
                      Boolean(rewardValidationError) ||
                      !rewardDraftDirty
                    }
                    className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:opacity-50"
                  >
                    {rewardSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              {(rewardError || rewardMessage || rewardValidationError) && (
                <div
                  className={`mb-3 rounded-md border px-3 py-2 text-xs ${
                    rewardError || rewardValidationError
                      ? "border-amber-400/25 bg-amber-400/5 text-amber-200"
                      : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
                  }`}
                >
                  {rewardError || rewardValidationError || rewardMessage}
                </div>
              )}
              <div className="overflow-x-auto rounded-md border border-white/10">
                <table className="w-full min-w-[860px] border-collapse text-left text-xs">
                  <thead className="bg-[var(--surface-2)] text-slate-400">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">Label</th>
                      <th className="px-3 py-2.5 font-medium">Min %</th>
                      <th className="px-3 py-2.5 font-medium">Max %</th>
                      <th className="px-3 py-2.5 font-medium">Amount</th>
                      <th className="px-3 py-2.5 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rewardDraft.levels.map((level, index) => {
                      return (
                        <tr key={level.id} className="border-t border-white/5">
                          <td className="px-3 py-2.5">
                            <input
                              value={level.label}
                              onChange={(event) =>
                                updateRewardLevel(index, {
                                  label: event.target.value,
                                })
                              }
                              className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={level.minPercent}
                              onChange={(event) =>
                                updateRewardLevel(index, {
                                  minPercent: parseNonNegativeNumber(
                                    event.target.value,
                                  ),
                                })
                              }
                              className="w-24 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={level.maxPercent ?? ""}
                              onChange={(event) =>
                                updateRewardLevel(index, {
                                  maxPercent:
                                    event.target.value === ""
                                      ? null
                                      : parseNonNegativeNumber(
                                          event.target.value,
                                        ),
                                })
                              }
                              placeholder="Open"
                              className="w-24 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="number"
                              step="1"
                              value={level.amount}
                              onChange={(event) =>
                                updateRewardLevel(index, {
                                  amount: Number(event.target.value) || 0,
                                })
                              }
                              className="w-24 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <button
                              type="button"
                              onClick={() => removeRewardLevel(index)}
                              disabled={rewardDraft.levels.length <= 1}
                              className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-amber-300/50 hover:text-amber-200 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <WorkbenchMailComposer organization={organization} />
          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Alerts
              </h4>
              <span className="text-[10px] text-slate-500">
                {alerts.length}
              </span>
            </div>
            <div className="space-y-2">
              {alerts.length === 0 ? (
                <div className="rounded-md border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs text-emerald-200">
                  No blockers detected in the current range.
                </div>
              ) : (
                alerts.map((item) => (
                  <div
                    key={`${item.kind}-${item.title}`}
                    className={`rounded-md border p-3 text-xs ${
                      item.kind === "error"
                        ? "border-red-400/25 bg-red-400/5 text-red-100"
                        : item.kind === "warn"
                          ? "border-amber-400/25 bg-amber-400/5 text-amber-100"
                          : "border-cyan-400/20 bg-cyan-400/5 text-cyan-100"
                    }`}
                  >
                    <div className="font-medium">{item.title}</div>
                    <div className="mt-1 text-[11px] leading-5 text-inherit/85">
                      {item.detail}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  FiAward,
  FiMonitor,
  FiRefreshCw,
  FiRotateCcw,
  FiSettings,
  FiUsers,
} from "react-icons/fi";
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
import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { buildHomepageDatasetStatistics } from "@/utils/homepageDatasetStatistics";
import {
  getLinkedHubDatasetRepoId,
  makeLocalRepoId,
  routePathFromRepoId,
} from "@/utils/datasetRoute";
import { copyTextToClipboard } from "@/utils/clipboard";
import WorkbenchStatisticsFilterNotice from "@/components/workbench-statistics-filter-notice";
import WorkbenchRuleBadge from "@/components/workbench-rule-badge";
import { formatBytes } from "@/utils/byteSize";
import {
  computeWorkbenchAdditionTimeline,
  computeWorkbenchAdditionRollup,
  WORKBENCH_DATASET_SOURCE_KEYS,
  WORKBENCH_DATASET_SOURCE_LABELS,
  countHalfOpenDays,
  getWorkbenchDefaultDateTimeRange,
  getWorkbenchDateTimeRangeShortcut,
  getWorkbenchLatestAvailableDateTimeRange,
  getWorkbenchOkrAchievementRate,
  isWorkbenchIgnoredRobotId,
  normalizeWorkbenchDateRange,
  workbenchAdditionAvailableDays,
  workbenchAdditionDatasetPaths,
  workbenchDatasetRangeContributions,
  workbenchDatasetSourceKey,
  workbenchDatasetSourceLabel,
  workbenchSourceRepoId,
  workbenchGroupSourceRepoIds,
  type WorkbenchDailyAddition,
  type WorkbenchDatasetSourceKey,
  type WorkbenchRollupDataset,
  type WorkbenchRollupRow,
} from "@/utils/workbenchRollup";
import {
  createWorkbenchReviewTask,
  workbenchCsv,
} from "@/utils/workbenchActions";
import {
  countWorkbenchRewardTargetHours,
  evaluateWorkbenchRewardRules,
  formatWorkbenchRewardAmount,
  type WorkbenchRewardRuleLevel,
  type WorkbenchRewardRulesConfig,
} from "@/utils/workbenchRewards";
import WorkbenchMailComposer, {
  type WorkbenchMailRecipientGroup,
} from "@/components/workbench-mail-composer";
import WorkbenchPersonnelMappingEditor from "@/components/workbench-personnel-mapping-editor";
import WorkbenchPersonnelWorkload from "@/components/workbench-personnel-workload";
import type { WorkbenchDashboardMailInput } from "@/lib/workbench-mail-draft";
import type { WorkbenchPersonnelConfig } from "@/types/workbench-personnel.types";
import { computeWorkbenchPersonnelRollup } from "@/utils/workbenchPersonnel";
import type { WorkbenchDatasetScore } from "@/types/workbench-score.types";
import {
  createWorkbenchStatisticsFilterSummary,
  type WorkbenchStatisticsFilterSummary,
} from "@/utils/workbenchStatisticsFilter";
import WorkbenchDisplay from "@/components/workbench-display";
import {
  isWorkbenchOrganizationDisplayPath,
  requestWorkbenchDisplayFullscreen,
} from "@/components/workbench-display-browser";
import {
  createWorkbenchDisplayReplaySnapshot,
  createWorkbenchDisplaySnapshot,
  isTacCapWorkbenchReplaySource,
  TACCAP_WORKBENCH_REPLAY_DATASET,
  type WorkbenchDisplaySnapshot,
} from "@/components/workbench-display-utils";

const SOURCE_OPTIONS = WORKBENCH_DATASET_SOURCE_KEYS.map((value) => ({
  value,
  label: WORKBENCH_DATASET_SOURCE_LABELS[value],
}));
const ALL_WORKBENCH_SOURCES = [...WORKBENCH_DATASET_SOURCE_KEYS];

function parseWorkbenchSources(
  value: string | null,
): WorkbenchDatasetSourceKey[] {
  const requested = new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item): item is WorkbenchDatasetSourceKey =>
        (WORKBENCH_DATASET_SOURCE_KEYS as readonly string[]).includes(item),
      ),
  );
  return requested.size > 0
    ? ALL_WORKBENCH_SOURCES.filter((source) => requested.has(source))
    : [...ALL_WORKBENCH_SOURCES];
}

const WORKBENCH_TEAM_MANAGER_NAMES = new Set(["dylan", "frank", "jay"]);

const DATE_SHORTCUTS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7Days", label: "Last 7 days" },
  { value: "thisWeek", label: "This week" },
  { value: "lastWeek", label: "Last week" },
] as const;

const WORKBENCH_WORKSTATION_CONCEPT_START_DATE = "2026-08-22";
const WORKBENCH_DAILY_TREND_START_DATE = "2026-07-01";
const WORKBENCH_HEATMAP_DAY_LIMIT = 10;

type WorkbenchDataset = LocalDatasetSummary & {
  source?: WorkbenchDatasetSourceKey;
  sourceLabel?: string;
  captureSpan?: { from: string; to: string } | null;
  tacflowScore?: WorkbenchDatasetScore;
  dateEvidence?: "manifest" | "sessions" | "name" | "none";
  capturedFrom?: string | null;
  capturedTo?: string | null;
  hf?: {
    lastModified?: string | null;
    uploader?: string | null;
    uploaderDisplayName?: string | null;
  };
  lastModified?: string | null;
  uploader?: string | null;
  uploaderDisplayName?: string | null;
  durationHours?: number | null;
  dailyAdditions?: WorkbenchDailyAddition[];
};

function isTacCapReplayDataset(dataset: WorkbenchDataset): boolean {
  return (
    dataset.relativePath.trim() === TACCAP_WORKBENCH_REPLAY_DATASET ||
    getLinkedHubDatasetRepoId(makeLocalRepoId(dataset.relativePath)) ===
      TACCAP_WORKBENCH_REPLAY_DATASET
  );
}

function datasetEpisodeHref(
  dataset: WorkbenchDataset,
  episodeId = 0,
  frame?: number,
): string {
  const href = routePathFromRepoId(
    makeLocalRepoId(dataset.relativePath),
    episodeId,
  );
  return frame === undefined ? href : `${href}?frame=${Math.max(0, frame)}`;
}

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
  displayReplayDataset?: WorkbenchDataset | null;
  dataUpdatedAt?: string | null;
  errors?: Array<{ path: string; message: string }>;
  workstationMappings?: WorkbenchWorkstationMappingsPayload;
  rewardRules?: WorkbenchRewardRulesPayload;
  rewardRuleDefaults?: WorkbenchRewardRulesConfig;
  personnelConfig?: WorkbenchPersonnelConfig;
  statisticsFilter?: WorkbenchStatisticsFilterSummary;
  error?: string;
};

type WorkbenchDashboardRow = WorkbenchRollupRow & {
  robotId: string | null;
  leftGripperSn: string | null;
  sourceKey: WorkbenchDatasetSourceKey;
  sourceLabel: string;
  workstation: string;
  reward: ReturnType<typeof evaluateWorkbenchRewardRules>;
  sourceRepoIds: string[];
  dailyHours: Record<string, number>;
};

type RewardRulesDraft = WorkbenchRewardRulesConfig & { org: string };

type HeatmapRow = {
  workstation: string;
  hoursByDay: Record<string, number>;
  totalHours: number;
};

type WorkbenchDrilldown = {
  title: string;
  detail: string;
  source: "workbench";
  datasets: WorkbenchDataset[];
  day?: string;
  episodeId?: number;
  frame?: number;
};

function dedupeWorkbenchEmails(
  people: readonly { email?: string | null }[],
): string[] {
  const emails = new Map<string, string>();
  for (const person of people) {
    const email = person.email?.trim();
    if (email && !emails.has(email.toLowerCase())) {
      emails.set(email.toLowerCase(), email);
    }
  }
  return Array.from(emails.values());
}

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

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDataUpdatedAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function emptyPersonnelConfig(org: string): WorkbenchPersonnelConfig {
  return { org, people: [], schedules: {}, updatedAt: null };
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

function SourceReposCell({ repoIds }: { repoIds: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<{
    repoId: string;
    ok: boolean;
  } | null>(null);
  const repos = useMemo(
    () => repoIds.map((repoId) => repoId.trim()).filter(Boolean),
    [repoIds],
  );

  const copyRepo = useCallback(async (repoId: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(repoId);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = repoId;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const copied = document.execCommand("copy");
        textArea.remove();
        if (!copied) throw new Error("Copy command was rejected");
      }
      setCopyState({ repoId, ok: true });
    } catch {
      setCopyState({ repoId, ok: false });
    }
  }, []);

  const repoButton = (repoId: string, compact = false) => (
    <button
      type="button"
      onClick={() => void copyRepo(repoId)}
      className={
        compact
          ? "block max-w-full break-all text-left font-mono text-[11px] leading-5 text-cyan-200/80 transition-colors hover:text-cyan-100 hover:underline"
          : "block max-w-[22rem] break-all text-left font-mono text-[11px] leading-5 text-cyan-200/90 transition-colors hover:text-cyan-100 hover:underline"
      }
      title={"Click to copy " + repoId}
      aria-label={"Copy source repo " + repoId}
    >
      {repoId}
    </button>
  );

  if (repos.length === 0) {
    return <span className="text-slate-500">—</span>;
  }

  if (repos.length === 1) {
    return (
      <div className="max-w-[22rem]">
        {repoButton(repos[0])}
        {copyState?.repoId === repos[0] && (
          <span
            role="status"
            className={
              "text-[10px] " +
              (copyState.ok ? "text-emerald-300" : "text-amber-300")
            }
          >
            {copyState.ok ? "Copied" : "Copy failed"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative max-w-[22rem]"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node)) {
          setOpen(false);
          return;
        }
        if (!event.currentTarget.contains(nextTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="shrink-0 pt-0.5 text-slate-100 tabular-nums">
          {repos.length} repos
        </span>
        <div className="min-w-0 flex-1">
          {repoButton(repos[0], true)}
          {copyState?.repoId === repos[0] && (
            <span
              role="status"
              className={
                "text-[10px] " +
                (copyState.ok ? "text-emerald-300" : "text-amber-300")
              }
            >
              {copyState.ok ? "Copied" : "Copy failed"}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={"View " + repos.length + " source repos"}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[10px] text-cyan-200 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/10"
        >
          View
        </button>
      </div>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 max-h-64 w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-white/10 bg-[var(--surface-2)] p-2 shadow-xl shadow-black/50"
          role="dialog"
          aria-label="Source repos"
        >
          <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            Click a dataset name to copy its full repository id
          </div>
          <ul className="space-y-1">
            {repos.map((repoId) => (
              <li key={repoId} className="rounded bg-white/[0.03] px-2 py-1">
                {repoButton(repoId)}
                {copyState?.repoId === repoId && (
                  <span
                    role="status"
                    className={
                      "ml-2 text-[10px] " +
                      (copyState.ok ? "text-emerald-300" : "text-amber-300")
                    }
                  >
                    {copyState.ok ? "Copied" : "Copy failed"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function WorkbenchGroupingPanel({
  organization,
  refreshToken = 0,
  episodeData,
}: {
  organization: string;
  refreshToken?: number;
  episodeData?: EpisodeData;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedSources, setSelectedSources] = useState<
    WorkbenchDatasetSourceKey[]
  >(() =>
    parseWorkbenchSources(
      searchParams.get("workbenchSources") ??
        searchParams.get("workbenchSource"),
    ),
  );
  const [datasets, setDatasets] = useState<WorkbenchDataset[]>([]);
  const [displayReplayDataset, setDisplayReplayDataset] =
    useState<WorkbenchDataset | null>(null);
  const [statisticsFilter, setStatisticsFilter] = useState(() =>
    createWorkbenchStatisticsFilterSummary([]),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefreshToken, setLocalRefreshToken] = useState(0);
  const [dataUpdatedAt, setDataUpdatedAt] = useState<string | null>(null);
  const latestRangeAppliedRef = useRef(
    Boolean(
      searchParams.get("workbenchStart") || searchParams.get("workbenchEnd"),
    ),
  );
  const [defaultDateTimeRange] = useState(() =>
    getWorkbenchDefaultDateTimeRange(),
  );
  const [startDateTime, setStartDateTime] = useState(
    searchParams.get("workbenchStart") ?? defaultDateTimeRange.startDateTime,
  );
  const [endDateTime, setEndDateTime] = useState(
    searchParams.get("workbenchEnd") ?? defaultDateTimeRange.endDateTime,
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("workbenchSources", selectedSources.join(","));
    url.searchParams.delete("workbenchSource");
    url.searchParams.delete("workbenchDimension");
    window.history.replaceState(window.history.state, "", url);
  }, [selectedSources]);
  const toggleWorkbenchSource = useCallback(
    (source: WorkbenchDatasetSourceKey) => {
      setSelectedSources((current) => {
        if (current.includes(source)) {
          return current.length === 1
            ? current
            : current.filter((value) => value !== source);
        }
        return ALL_WORKBENCH_SOURCES.filter(
          (value) => value === source || current.includes(value),
        );
      });
    },
    [],
  );
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
  const [personnelConfig, setPersonnelConfig] =
    useState<WorkbenchPersonnelConfig>(() =>
      emptyPersonnelConfig(organization),
    );
  const [mappingEditorOpen, setMappingEditorOpen] = useState(false);
  const [rewardEditorOpen, setRewardEditorOpen] = useState(false);
  const [personnelEditorOpen, setPersonnelEditorOpen] = useState(false);
  const [mappingsSaving, setMappingsSaving] = useState(false);
  const [rewardSaving, setRewardSaving] = useState(false);
  const [mappingsError, setMappingsError] = useState<string | null>(null);
  const [mappingsMessage, setMappingsMessage] = useState<string | null>(null);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [rewardMessage, setRewardMessage] = useState<string | null>(null);
  const [workstationQuery, setWorkstationQuery] = useState("");
  const [workstationSort, setWorkstationSort] = useState<
    "reward" | "hours" | "robot" | "datasets"
  >("reward");
  const [drilldown, setDrilldown] = useState<WorkbenchDrilldown | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [replayEnabled, setReplayEnabled] = useState(true);
  const [displaySnapshot, setDisplaySnapshot] =
    useState<WorkbenchDisplaySnapshot | null>(null);
  const [displayOpening, setDisplayOpening] = useState(false);
  const [displayReplayError, setDisplayReplayError] = useState<string | null>(
    null,
  );
  const displayButtonRef = useRef<HTMLButtonElement>(null);
  const displayRestoreRef = useRef<{
    scrollY: number;
    focus: HTMLElement | null;
  }>({ scrollY: 0, focus: null });
  const displayActiveRef = useRef(false);

  useEffect(() => {
    return () => {
      if (displayActiveRef.current && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setStatisticsFilter(createWorkbenchStatisticsFilterSummary([]));
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
        setDisplayReplayDataset(payload.displayReplayDataset ?? null);
        setDataUpdatedAt(payload.dataUpdatedAt ?? null);
        setStatisticsFilter(
          payload.statisticsFilter ??
            createWorkbenchStatisticsFilterSummary([]),
        );
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
        setPersonnelConfig(
          payload.personnelConfig ?? emptyPersonnelConfig(organization),
        );
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
  const selectedSourceSet = useMemo(
    () => new Set<WorkbenchDatasetSourceKey>(selectedSources),
    [selectedSources],
  );
  const sourceFilteredDatasets = useMemo(
    () =>
      rollupDatasets.filter((dataset) =>
        selectedSourceSet.has(
          dataset.source ?? workbenchDatasetSourceKey(dataset.relativePath),
        ),
      ),
    [rollupDatasets, selectedSourceSet],
  );
  const sourceFilteredLocalDatasets = useMemo(
    () =>
      datasets.filter((dataset) =>
        selectedSourceSet.has(
          dataset.source ?? workbenchDatasetSourceKey(dataset.relativePath),
        ),
      ),
    [datasets, selectedSourceSet],
  );

  const workstationRollupDatasets = useMemo<WorkbenchRollupDataset[]>(
    () =>
      sourceFilteredDatasets.filter(
        (dataset) => !isWorkbenchIgnoredRobotId(dataset.robotId),
      ),
    [sourceFilteredDatasets],
  );
  const availableDays = useMemo(
    () =>
      Array.from(
        new Set(workbenchAdditionAvailableDays(workstationRollupDatasets)),
      ),
    [workstationRollupDatasets],
  );
  useEffect(() => {
    if (latestRangeAppliedRef.current || availableDays.length === 0) return;
    const next = getWorkbenchLatestAvailableDateTimeRange(availableDays);
    setStartDateTime(next.startDateTime);
    setEndDateTime(next.endDateTime);
    latestRangeAppliedRef.current = true;
  }, [availableDays]);
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
      computeWorkbenchAdditionTimeline(workstationRollupDatasets, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, workstationRollupDatasets],
  );
  const undatedDatasetPaths = sourceFilteredDatasets
    .filter(
      (dataset) =>
        (dataset.dateEvidence ?? dataset.facets?.dateEvidence ?? "none") ===
        "none",
    )
    .map((dataset) => dataset.relativePath)
    .sort((left, right) => left.localeCompare(right));
  const undatedDatasetCount = undatedDatasetPaths.length;
  const organizationTotalHours = buildHomepageDatasetStatistics(
    sourceFilteredLocalDatasets,
    {
      preserveOrder: true,
    },
  ).hours;
  const selectedDatasetPaths = useMemo(
    () =>
      workbenchAdditionDatasetPaths(workstationRollupDatasets, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, workstationRollupDatasets],
  );
  const selectedStorageBytes = selectedDatasetPaths.reduce(
    (sum, datasetPath) => {
      const dataset = workstationRollupDatasets.find(
        (item) => item.relativePath === datasetPath,
      );
      const bytes = dataset?.sizeBytes;
      return (
        sum +
        (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
          ? bytes
          : 0)
      );
    },
    0,
  );
  const robotRows = useMemo(
    () =>
      computeWorkbenchAdditionRollup(workstationRollupDatasets, "robot_id", {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, workstationRollupDatasets],
  );
  const robotSourceRepoMap = useMemo(
    () =>
      workbenchGroupSourceRepoIds(workstationRollupDatasets, "robot_id", {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, workstationRollupDatasets],
  );
  const workstationHeatmapRange = useMemo(
    () => ({
      startDate: WORKBENCH_WORKSTATION_CONCEPT_START_DATE,
      endDate: range.endDate,
    }),
    [range.endDate],
  );
  const heatmapDays = useMemo(() => {
    const days = new Set<string>();
    for (const dataset of workstationRollupDatasets) {
      for (const addition of workbenchDatasetRangeContributions(
        dataset,
        workstationHeatmapRange,
      )) {
        const hours = Number(addition.hours);
        if (Number.isFinite(hours) && hours > 0) days.add(addition.day);
      }
    }
    return [...days].sort().slice(-WORKBENCH_HEATMAP_DAY_LIMIT);
  }, [workstationHeatmapRange, workstationRollupDatasets]);
  const heatmapRows = useMemo<HeatmapRow[]>(() => {
    const rows = new Map<string, HeatmapRow>();
    const visibleDaySet = new Set(heatmapDays);
    for (const dataset of workstationRollupDatasets) {
      const mappingKey =
        dataset.robotId?.trim() || dataset.leftGripperSn?.trim() || "";
      const workstation = mappingKey
        ? workstationDraft[mappingKey]?.trim() ||
          workstationMappings[mappingKey]?.trim() ||
          workstationDefaults[mappingKey]?.trim() ||
          "未分配"
        : "未分配";
      const row: HeatmapRow = rows.get(workstation) ?? {
        workstation,
        hoursByDay: {},
        totalHours: 0,
      };
      for (const addition of workbenchDatasetRangeContributions(
        dataset,
        workstationHeatmapRange,
      )) {
        if (!visibleDaySet.has(addition.day)) continue;
        const hours = Number(addition.hours);
        if (!Number.isFinite(hours) || hours <= 0) continue;
        row.hoursByDay[addition.day] =
          (row.hoursByDay[addition.day] ?? 0) + hours;
        row.totalHours += hours;
      }
      rows.set(workstation, row);
    }
    return Array.from(rows.values())
      .filter((row) => row.totalHours > 0)
      .sort(
        (left, right) =>
          right.totalHours - left.totalHours ||
          left.workstation.localeCompare(right.workstation),
      );
  }, [
    heatmapDays,
    workstationHeatmapRange,
    workstationRollupDatasets,
    workstationDefaults,
    workstationDraft,
    workstationMappings,
  ]);
  const dailyTrendTimeline = useMemo(
    () =>
      computeWorkbenchAdditionTimeline(workstationRollupDatasets, {
        startDate:
          range.endDate && range.endDate <= WORKBENCH_DAILY_TREND_START_DATE
            ? range.startDate
            : WORKBENCH_DAILY_TREND_START_DATE,
        endDate: range.endDate,
      }),
    [range.endDate, range.startDate, workstationRollupDatasets],
  );
  const lineChartRows = dailyTrendTimeline.rows.map((row) => ({
    day: row.day.slice(5),
    date: row.day,
    hours: row.hours,
    cumulativeHours: row.cumulativeHours,
    datasets: row.datasets,
  }));

  const robotDashboardRows = useMemo<WorkbenchDashboardRow[]>(() => {
    const sourceRepoIds = robotSourceRepoMap;
    const grouped = new Map<string, WorkbenchDashboardRow>();
    for (const row of robotRows) {
      const repos = sourceRepoIds.get(row.group) ?? [];
      const sourceDataset = workstationRollupDatasets.find(
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
      for (const dataset of workstationRollupDatasets) {
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
        sourceKey:
          sourceDataset?.source ??
          (sourceDataset
            ? workbenchDatasetSourceKey(sourceDataset.relativePath)
            : "unclassified"),
        sourceLabel:
          sourceDataset?.sourceLabel ??
          (sourceDataset
            ? workbenchDatasetSourceLabel(
                sourceDataset.source ??
                  workbenchDatasetSourceKey(sourceDataset.relativePath),
              )
            : "TacVerse/待确认"),
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
    workstationRollupDatasets,
    targetHours,
    workstationDefaults,
    workstationDraft,
    workstationLegacyDefaults,
    workstationLegacyDraft,
    workstationLegacyMappings,
    workstationMappings,
  ]);
  const sourceWorkstationDashboardRows = useMemo<
    WorkbenchDashboardRow[]
  >(() => {
    type GroupedRow = WorkbenchDashboardRow & { datasetPaths: Set<string> };
    const grouped = new Map<string, GroupedRow>();
    for (const dataset of workstationRollupDatasets) {
      const additions = workbenchDatasetRangeContributions(dataset, range);
      if (additions.length === 0) continue;
      const sourceKey =
        dataset.source ?? workbenchDatasetSourceKey(dataset.relativePath);
      const sourceLabel =
        dataset.sourceLabel ?? workbenchDatasetSourceLabel(sourceKey);
      const mappingKey =
        dataset.robotId?.trim() || dataset.leftGripperSn?.trim() || "";
      const workstation = mappingKey
        ? workstationDraft[mappingKey]?.trim() ||
          workstationMappings[mappingKey]?.trim() ||
          workstationDefaults[mappingKey]?.trim() ||
          "未分配"
        : "未分配";
      const key = [sourceKey, workstation].join("\u0000");
      const current = grouped.get(key) ?? {
        group: `${sourceLabel} · ${workstation}`,
        count: 0,
        episodes: 0,
        frames: 0,
        hours: 0,
        pctHours: 0,
        robotId: null,
        leftGripperSn: null,
        sourceKey,
        sourceLabel,
        workstation,
        reward: evaluateWorkbenchRewardRules(0, targetHours ?? 0, rewardDraft),
        sourceRepoIds: [],
        dailyHours: {},
        datasetPaths: new Set<string>(),
      };
      if (!current.datasetPaths.has(dataset.relativePath)) {
        current.datasetPaths.add(dataset.relativePath);
        current.count += 1;
        current.episodes +=
          Number.isFinite(Number(dataset.total_episodes)) &&
          Number(dataset.total_episodes) > 0
            ? Math.trunc(Number(dataset.total_episodes))
            : 0;
        current.frames +=
          Number.isFinite(Number(dataset.total_frames)) &&
          Number(dataset.total_frames) > 0
            ? Math.trunc(Number(dataset.total_frames))
            : 0;
        const repoId = workbenchSourceRepoId(dataset.relativePath);
        if (!current.sourceRepoIds.includes(repoId)) {
          current.sourceRepoIds.push(repoId);
        }
      }
      for (const addition of additions) {
        const hours = Number(addition.hours);
        if (!Number.isFinite(hours) || hours <= 0) continue;
        current.hours += hours;
        current.dailyHours[addition.day] =
          (current.dailyHours[addition.day] ?? 0) + hours;
      }
      grouped.set(key, current);
    }
    return Array.from(grouped.values()).map(({ datasetPaths, ...row }) => {
      void datasetPaths;
      return {
        ...row,
        hours: Math.round(row.hours * 1000) / 1000,
        sourceRepoIds: [...row.sourceRepoIds].sort((left, right) =>
          left.localeCompare(right),
        ),
        reward: evaluateWorkbenchRewardRules(
          row.hours,
          targetHours ?? 0,
          rewardDraft,
        ),
      };
    });
  }, [
    range,
    rewardDraft,
    targetHours,
    workstationDefaults,
    workstationDraft,
    workstationMappings,
    workstationRollupDatasets,
  ]);

  const topWorkstationRows = useMemo(() => {
    const groups = new Map<
      string,
      { group: string; hours: number; count: number }
    >();
    for (const row of sourceWorkstationDashboardRows) {
      const current = groups.get(row.workstation) ?? {
        group: row.workstation,
        hours: 0,
        count: 0,
      };
      current.hours += row.hours;
      current.count += row.count;
      groups.set(row.workstation, current);
    }
    return [...groups.values()].sort(
      (left, right) =>
        right.hours - left.hours || left.group.localeCompare(right.group),
    );
  }, [sourceWorkstationDashboardRows]);
  const selectedChartRows = topWorkstationRows.slice(0, 12);

  const selectedWorkbenchDatasets = useMemo(
    () =>
      datasets.filter((dataset) =>
        selectedDatasetPaths.includes(dataset.relativePath),
      ),
    [datasets, selectedDatasetPaths],
  );
  const datasetsForSourceWorkstation = useCallback(
    (sourceKey: WorkbenchDatasetSourceKey, workstation: string) =>
      selectedWorkbenchDatasets.filter((dataset) => {
        const datasetSource =
          dataset.source ?? workbenchDatasetSourceKey(dataset.relativePath);
        if (datasetSource !== sourceKey) return false;
        const mappingKey =
          dataset.robotId?.trim() || dataset.leftGripperSn?.trim() || "";
        const mappedWorkstation = mappingKey
          ? workstationDraft[mappingKey]?.trim() ||
            workstationMappings[mappingKey]?.trim() ||
            workstationDefaults[mappingKey]?.trim() ||
            "未分配"
          : "未分配";
        return mappedWorkstation === workstation;
      }),
    [
      selectedWorkbenchDatasets,
      workstationDefaults,
      workstationDraft,
      workstationMappings,
    ],
  );

  const visibleRobotDashboardRows = useMemo(() => {
    const query = workstationQuery.trim().toLocaleLowerCase();
    const rows = sourceWorkstationDashboardRows.filter((row) => {
      if (!query) return true;
      return [
        row.robotId,
        row.leftGripperSn,
        row.workstation,
        row.sourceLabel,
        ...row.sourceRepoIds,
      ]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
    return [...rows].sort((left, right) => {
      if (workstationSort === "robot") {
        return left.sourceLabel.localeCompare(right.sourceLabel);
      }
      if (workstationSort === "datasets") return right.count - left.count;
      if (workstationSort === "reward") {
        return (
          right.reward.amount - left.reward.amount ||
          right.hours - left.hours ||
          left.workstation.localeCompare(right.workstation) ||
          left.sourceLabel.localeCompare(right.sourceLabel)
        );
      }
      return right.hours - left.hours;
    });
  }, [sourceWorkstationDashboardRows, workstationQuery, workstationSort]);

  const openWorkbenchDrilldown = useCallback(
    (selection: Omit<WorkbenchDrilldown, "source">) => {
      setActionMessage(null);
      setDrilldown({ ...selection, source: "workbench" });
    },
    [],
  );
  const createReviewTaskFromDrilldown = useCallback(() => {
    if (!drilldown) return;
    const first = drilldown.datasets[0];
    const task = createWorkbenchReviewTask({
      organization,
      source: "workbench",
      title: drilldown.title,
      detail: drilldown.detail,
      datasetPath: first?.relativePath ?? null,
      episodeId: drilldown.episodeId ?? null,
      frame: drilldown.frame ?? null,
    });
    setActionMessage(
      task
        ? "Review task created in this browser."
        : "Unable to create review task.",
    );
  }, [drilldown, organization]);
  const copyWorkbenchShareLink = useCallback(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("workbenchStart", startDateTime);
    url.searchParams.set("workbenchEnd", endDateTime);
    url.searchParams.set("workbenchSources", selectedSources.join(","));
    url.searchParams.delete("workbenchSource");
    url.searchParams.delete("workbenchDimension");
    const copied = await copyTextToClipboard(url.toString());
    setActionMessage(
      copied ? "Share link copied." : "Unable to copy share link.",
    );
  }, [endDateTime, selectedSources, startDateTime]);
  const personnelWorkstationMappings = useMemo(() => {
    const mappings: Record<string, string> = {};
    for (const dataset of workstationRollupDatasets) {
      const robotId = dataset.robotId?.trim();
      const leftGripperSn = dataset.leftGripperSn?.trim();
      const key = robotId || leftGripperSn;
      if (!key) continue;
      const workstation = robotId
        ? workstationDraft[robotId]?.trim() ||
          workstationMappings[robotId]?.trim() ||
          workstationDefaults[robotId]?.trim()
        : workstationLegacyDraft[key]?.trim() ||
          workstationLegacyMappings[key]?.trim() ||
          workstationLegacyDefaults[key]?.trim();
      if (workstation) mappings[key] = workstation;
    }
    return mappings;
  }, [
    workstationDefaults,
    workstationDraft,
    workstationLegacyDefaults,
    workstationLegacyDraft,
    workstationLegacyMappings,
    workstationMappings,
    workstationRollupDatasets,
  ]);
  const datasetScores = useMemo(() => {
    const scores = new Map<string, WorkbenchDatasetScore>();
    for (const dataset of workstationRollupDatasets) {
      if (dataset.tacflowScore) {
        scores.set(dataset.relativePath, dataset.tacflowScore);
      }
    }
    return scores;
  }, [workstationRollupDatasets]);
  const personnelRollup = useMemo(
    () =>
      computeWorkbenchPersonnelRollup(
        workstationRollupDatasets,
        personnelWorkstationMappings,
        personnelConfig,
        range,
        rewardDraft,
        datasetScores,
      ),
    [
      personnelConfig,
      personnelWorkstationMappings,
      range,
      rewardDraft,
      workstationRollupDatasets,
      datasetScores,
    ],
  );
  const personnelByWorkstation = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const row of personnelRollup.rows) {
      const personnel = row.personnel.trim();
      if (!personnel) continue;
      for (const workstation of row.workstations) {
        const key = workstation.trim();
        if (!key) continue;
        const people = names.get(key) ?? new Set<string>();
        people.add(personnel);
        names.set(key, people);
      }
    }
    return new Map(
      Array.from(names.entries()).map(([workstation, people]) => [
        workstation,
        Array.from(people).sort((left, right) =>
          left.localeCompare(right, "zh-CN"),
        ),
      ]),
    );
  }, [personnelRollup.rows]);
  const exportWorkbenchCsv = useCallback(() => {
    const rows: unknown[][] = [];
    for (const row of visibleRobotDashboardRows) {
      rows.push([
        "workstation",
        row.sourceLabel,
        row.workstation,
        row.hours,
        row.count,
        row.reward.amount,
        row.sourceRepoIds.join(" | "),
      ]);
    }
    for (const row of personnelRollup.rows) {
      rows.push([
        "personnel",
        row.personnel,
        row.workstations.join(" | "),
        row.hours,
        row.targetHours,
        row.reward.amount,
        row.email,
      ]);
    }
    for (const row of dailyTrendTimeline.rows) {
      rows.push(["daily-trend", row.day, "", row.hours, row.datasets, "", ""]);
    }
    const csv = workbenchCsv(
      [
        "section",
        "key",
        "workstation",
        "hours",
        "count_or_target",
        "reward",
        "datasets_or_email",
      ],
      rows,
    );
    const link = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.href = url;
    link.download = `workbench-${organization.replace(/[^a-z0-9_-]+/gi, "-")}-${range.startDate ?? "start"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setActionMessage("CSV exported.");
  }, [
    organization,
    personnelRollup.rows,
    range.startDate,
    dailyTrendTimeline,
    visibleRobotDashboardRows,
  ]);

  const totalHours = totalTimeline.total.hours;
  const robotIds = selectedSources.length;
  const totalEpisodes = totalTimeline.total.episodes;
  const projectedRewardAmount = sourceWorkstationDashboardRows.reduce(
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

  const mailRollupDatasets = useMemo<WorkbenchRollupDataset[]>(
    () =>
      workstationRollupDatasets.filter(
        (dataset) =>
          (dataset.source ??
            workbenchDatasetSourceKey(dataset.relativePath)) !== "unclassified",
      ),
    [workstationRollupDatasets],
  );
  const mailLocalDatasets = useMemo(
    () =>
      sourceFilteredLocalDatasets.filter(
        (dataset) =>
          (dataset.source ??
            workbenchDatasetSourceKey(dataset.relativePath)) !== "unclassified",
      ),
    [sourceFilteredLocalDatasets],
  );
  const mailTotalTimeline = useMemo(
    () =>
      computeWorkbenchAdditionTimeline(mailRollupDatasets, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [mailRollupDatasets, range.endDate, range.startDate],
  );
  const mailSelectedDatasetPaths = useMemo(
    () =>
      workbenchAdditionDatasetPaths(mailRollupDatasets, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [mailRollupDatasets, range.endDate, range.startDate],
  );
  const mailSelectedStorageBytes = useMemo(
    () =>
      mailSelectedDatasetPaths.reduce((sum, datasetPath) => {
        const dataset = mailRollupDatasets.find(
          (item) => item.relativePath === datasetPath,
        );
        const bytes = dataset?.sizeBytes;
        return (
          sum +
          (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
            ? bytes
            : 0)
        );
      }, 0),
    [mailRollupDatasets, mailSelectedDatasetPaths],
  );
  const mailOrganizationTotalHours = useMemo(
    () =>
      buildHomepageDatasetStatistics(mailLocalDatasets, {
        preserveOrder: true,
      }).hours,
    [mailLocalDatasets],
  );
  const mailSourceCount = useMemo(
    () =>
      new Set(
        mailLocalDatasets.map(
          (dataset) =>
            dataset.source ?? workbenchDatasetSourceKey(dataset.relativePath),
        ),
      ).size,
    [mailLocalDatasets],
  );
  const mailWorkstationRows = useMemo(
    () =>
      visibleRobotDashboardRows.filter(
        (row) => row.sourceKey !== "unclassified",
      ),
    [visibleRobotDashboardRows],
  );
  const mailProjectedRewardAmount = useMemo(
    () =>
      sourceWorkstationDashboardRows
        .filter((row) => row.sourceKey !== "unclassified")
        .reduce((sum, row) => sum + row.reward.amount, 0),
    [sourceWorkstationDashboardRows],
  );
  const mailPersonnelRollup = useMemo(
    () =>
      computeWorkbenchPersonnelRollup(
        mailRollupDatasets,
        personnelWorkstationMappings,
        personnelConfig,
        range,
        rewardDraft,
        datasetScores,
      ),
    [
      datasetScores,
      mailRollupDatasets,
      personnelConfig,
      personnelWorkstationMappings,
      range,
      rewardDraft,
    ],
  );
  const mailPersonnelByWorkstation = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const row of mailPersonnelRollup.rows) {
      const personnel = row.personnel.trim();
      if (!personnel) continue;
      for (const workstation of row.workstations) {
        const key = workstation.trim();
        if (!key) continue;
        const people = names.get(key) ?? new Set<string>();
        people.add(personnel);
        names.set(key, people);
      }
    }
    return new Map(
      Array.from(names.entries()).map(([workstation, people]) => [
        workstation,
        Array.from(people).sort((left, right) =>
          left.localeCompare(right, "zh-CN"),
        ),
      ]),
    );
  }, [mailPersonnelRollup.rows]);

  const recipientSuggestions = useMemo(
    () =>
      personnelRollup.rows
        .filter((row) => row.email.trim())
        .map((row) => ({
          label: row.personnel,
          email: row.email.trim(),
        })),
    [personnelRollup.rows],
  );
  const recipientGroups = useMemo<WorkbenchMailRecipientGroup[]>(() => {
    const peopleById = new Map(
      personnelConfig.people.map((person) => [person.id, person]),
    );
    const xrPersonIds = new Set<string>();
    for (const assignments of Object.values(personnelConfig.schedules)) {
      for (const assignment of assignments) {
        if (assignment.workstation.trim().toLocaleUpperCase() !== "XR") {
          continue;
        }
        for (const member of assignment.members) {
          xrPersonIds.add(member.personId);
        }
      }
    }
    const xrPeople = Array.from(xrPersonIds)
      .map((personId) => peopleById.get(personId))
      .filter((person): person is WorkbenchPersonnelConfig["people"][number] =>
        Boolean(person),
      );
    const teamManagers = personnelConfig.people.filter((person) =>
      WORKBENCH_TEAM_MANAGER_NAMES.has(
        person.displayName.trim().toLocaleLowerCase(),
      ),
    );
    const rewardNonNegative = personnelRollup.rows.filter(
      (row) => row.reward.amount >= 0,
    );
    const groups: WorkbenchMailRecipientGroup[] = [
      {
        id: "xr-workstation",
        label: "XR 工位",
        emails: dedupeWorkbenchEmails(xrPeople),
      },
      {
        id: "team-managers",
        label: "Dylan 等团队管理人员",
        emails: dedupeWorkbenchEmails(teamManagers),
      },
      {
        id: "reward-non-negative",
        label: "Reward >=0（筛选范围内）",
        emails: dedupeWorkbenchEmails(rewardNonNegative),
      },
      {
        id: "all-personnel",
        label: "人员列表全员",
        emails: dedupeWorkbenchEmails(personnelConfig.people),
      },
    ];
    return groups.filter((group) => group.emails.length > 0);
  }, [personnelConfig, personnelRollup.rows]);

  const mailDashboardInput = useMemo<WorkbenchDashboardMailInput>(
    () => ({
      organization,
      dateRange: range,
      summary: {
        organizationTotalHours: mailOrganizationTotalHours,
        rangeHours: mailTotalTimeline.total.hours,
        episodes: mailTotalTimeline.total.episodes,
        tasks: mailSelectedDatasetPaths.length,
        storageBytes: mailSelectedStorageBytes,
        dailyTargetHours: rewardDraft.dailyTargetHours,
        totalBonus: mailProjectedRewardAmount,
        sources: mailSourceCount,
        daysInRange: rangeDays,
      },
      rows: mailWorkstationRows.map((row) => ({
        sourceLabel: row.sourceLabel,
        personnel:
          mailPersonnelByWorkstation.get(row.workstation)?.join(", ") || "—",
        sourceRepoIds: row.sourceRepoIds,
        workstation: row.workstation,
        datasets: row.count,
        hours: row.hours,
        targetHours,
        ratePercent: getWorkbenchOkrAchievementRate(
          row.hours,
          targetHours ?? 0,
        ),
        rule: row.reward.level?.label ?? row.reward.symbol,
        reward: row.reward.amount,
      })),
      personnelRows: mailPersonnelRollup.rows.map((row) => ({
        personnel: row.personnel,
        workstation: row.workstations.join(", ") || "—",
        hours: row.hours,
        targetHours: row.targetHours,
        ratePercent: row.ratePercent,
        rule: row.rule,
        reward: row.reward.amount,
        email: row.email,
      })),
      personnelBonusTotal: mailPersonnelRollup.totalBonus,
    }),
    [
      mailOrganizationTotalHours,
      mailPersonnelByWorkstation,
      mailPersonnelRollup,
      mailProjectedRewardAmount,
      mailSelectedDatasetPaths,
      mailSelectedStorageBytes,
      mailSourceCount,
      mailTotalTimeline,
      mailWorkstationRows,
      organization,
      range,
      rangeDays,
      rewardDraft.dailyTargetHours,
      targetHours,
    ],
  );
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
    const next = getWorkbenchLatestAvailableDateTimeRange(availableDays);
    setStartDateTime(next.startDateTime);
    setEndDateTime(next.endDateTime);
  }, [availableDays]);

  const applyDateShortcut = useCallback(
    (shortcut: (typeof DATE_SHORTCUTS)[number]["value"]) => {
      const next = getWorkbenchDateTimeRangeShortcut(shortcut);
      setStartDateTime(next.startDateTime);
      setEndDateTime(next.endDateTime);
    },
    [],
  );

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
      heatmapDays.map((day) => row.hoursByDay[day] ?? 0),
    ),
  );

  const replayDataset = useMemo(
    () =>
      replayEnabled && selectedSourceSet.has("taccap-g1")
        ? (datasets.find(
            (dataset) =>
              dataset.relativePath.trim() === TACCAP_WORKBENCH_REPLAY_DATASET,
          ) ??
          datasets.find(isTacCapReplayDataset) ??
          displayReplayDataset)
        : undefined,
    [datasets, displayReplayDataset, replayEnabled, selectedSourceSet],
  );
  const currentEpisodeIsReplaySource = Boolean(
    replayEnabled &&
    selectedSourceSet.has("taccap-g1") &&
    episodeData &&
    isTacCapWorkbenchReplaySource(
      episodeData.datasetInfo.repoId,
      episodeData.episodeId,
    ),
  );

  const closeDisplay = useCallback(() => {
    displayActiveRef.current = false;
    setDisplaySnapshot(null);
    const restore = displayRestoreRef.current;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: restore.scrollY, behavior: "instant" });
      const focusTarget = restore.focus?.isConnected
        ? restore.focus
        : displayButtonRef.current;
      focusTarget?.focus({ preventScroll: true });
    });
  }, []);

  const openDisplay = useCallback(async () => {
    if (displayOpening) return;

    setDisplayOpening(true);
    setDisplayReplayError(null);
    let replayEpisodeData: EpisodeData | undefined =
      currentEpisodeIsReplaySource ? episodeData : undefined;

    if (!replayEpisodeData && replayDataset) {
      try {
        const { getEpisodeDataSafe } =
          await import("@/app/[org]/[dataset]/[episode]/fetch-data");
        const result = await getEpisodeDataSafe(
          "_local",
          replayDataset.encodedPath,
          0,
        );
        replayEpisodeData = result.data;
        if (!replayEpisodeData && result.error) {
          setDisplayReplayError(result.error);
        }
      } catch (reason: unknown) {
        setDisplayReplayError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    }

    try {
      displayActiveRef.current = true;
      displayRestoreRef.current = {
        scrollY: window.scrollY,
        focus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      };
      setDisplaySnapshot(
        createWorkbenchDisplaySnapshot({
          organization,
          dateRange: range,
          dailyTargetHours: rewardDraft.dailyTargetHours,
          summary: {
            organizationTotalHours,
            selectedRangeHours: totalTimeline.total.hours,
            episodes: totalTimeline.total.episodes,
            tasks: selectedDatasetPaths.length,
            storageBytes: selectedStorageBytes,
            dailyTargetHours: rewardDraft.dailyTargetHours,
            totalBonus: projectedRewardAmount,
            robotIds,
            daysInRange: rangeDays,
          },
          workstations: sourceWorkstationDashboardRows.map((row) => ({
            sourceLabel: row.sourceLabel,
            robotId: row.workstation,
            workstation: row.workstation,
            personnel:
              personnelByWorkstation.get(row.workstation)?.join(", ") || "—",
            sourceRepoIds: row.sourceRepoIds,
            datasets: row.count,
            hours: row.hours,
            targetHours,
            ratePercent: getWorkbenchOkrAchievementRate(
              row.hours,
              targetHours ?? 0,
            ),
            rule: row.reward.level?.label ?? row.reward.symbol,
            ruleSymbol: row.reward.symbol,
            reward: row.reward.amount,
          })),
          personnelRows: personnelRollup.rows.map((row) => ({
            personnel: row.personnel,
            workstation: row.workstations.join(", ") || "—",
            hours: row.hours,
            targetHours: row.targetHours,
            ratePercent: row.ratePercent,
            rule: row.rule,
            ruleSymbol: row.reward.symbol,
            reward: row.reward.amount,
            email: row.email,
          })),
          personnelBonusTotal: personnelRollup.totalBonus,
          unattributedHours: personnelRollup.unattributedHours,
          heatmapDays,
          heatmapRows: heatmapRows.map((row) => ({
            robotId: row.workstation,
            workstation: row.workstation,
            totalHours: row.totalHours,
            hoursByDay: row.hoursByDay,
          })),
          trend: dailyTrendTimeline.rows.map((row) => ({
            day: row.day,
            hours: row.hours,
            datasets: row.datasets,
          })),
          topGroups: topWorkstationRows.map((row) => ({
            group: row.group,
            hours: row.hours,
            datasets: row.count,
          })),
          replay: replayEpisodeData
            ? (createWorkbenchDisplayReplaySnapshot({
                datasetName: replayEpisodeData.datasetInfo.repoId,
                episodeId: replayEpisodeData.episodeId,
                chartRows: replayEpisodeData.flatChartData,
                videosInfo: replayEpisodeData.videosInfo,
                episodeDurationSeconds: replayEpisodeData.duration,
                fps: replayEpisodeData.datasetInfo.fps,
              }) ?? undefined)
            : undefined,
        }),
      );

      if (!document.fullscreenElement) {
        void requestWorkbenchDisplayFullscreen(document.documentElement);
      }
    } finally {
      setDisplayOpening(false);
    }
  }, [
    currentEpisodeIsReplaySource,
    displayOpening,
    heatmapRows,
    organization,
    organizationTotalHours,
    personnelByWorkstation,
    personnelRollup,
    projectedRewardAmount,
    range,
    rewardDraft.dailyTargetHours,
    replayDataset,
    sourceWorkstationDashboardRows,
    selectedDatasetPaths.length,
    topWorkstationRows,
    dailyTrendTimeline,
    selectedStorageBytes,
    targetHours,
    totalTimeline.total.episodes,
    totalTimeline.total.hours,
    robotIds,
    rangeDays,
    heatmapDays,
    episodeData,
  ]);

  return (
    <section className="mx-auto w-full max-w-7xl space-y-4 py-5">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/[0.08] via-[var(--surface-1)]/50 to-emerald-400/[0.05] p-5 shadow-[0_18px_45px_rgba(8,15,30,0.22)] sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300/80">
              Operations workspace
            </div>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-100">
              Workbench dashboard
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">
              Organization-level daily additions, workstation mapping, and
              reward rules.
            </p>
          </div>
          {isWorkbenchOrganizationDisplayPath(pathname) && (
            <button
              ref={displayButtonRef}
              type="button"
              onClick={openDisplay}
              disabled={loading || displayOpening}
              aria-label="Open Workbench display"
              className="group inline-flex min-h-[4.25rem] items-center justify-center gap-3 rounded-xl border border-cyan-200/70 bg-gradient-to-br from-cyan-200 via-cyan-300 to-emerald-300 px-5 py-3 text-left text-slate-950 shadow-[0_12px_30px_rgba(34,211,238,0.28)] ring-1 ring-cyan-100/30 transition-all hover:-translate-y-0.5 hover:from-cyan-100 hover:to-emerald-200 hover:shadow-[0_16px_36px_rgba(34,211,238,0.38)] focus:outline-none focus:ring-2 focus:ring-cyan-100/80 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-[12rem]"
            >
              <FiMonitor
                aria-hidden="true"
                className="h-6 w-6 transition-transform group-hover:scale-110"
              />
              <span>
                <span className="block text-sm font-bold tracking-wide">
                  Display
                </span>
                <span className="mt-0.5 block text-[10px] font-medium text-slate-800/70">
                  {displayOpening
                    ? "Loading 3D Replay..."
                    : currentEpisodeIsReplaySource || replayDataset
                      ? "Fullscreen view · 3D Replay enabled"
                      : "Fullscreen operations view"}
                </span>
              </span>
            </button>
          )}
          {displayReplayError && (
            <p
              className="max-w-[18rem] text-right text-[10px] leading-4 text-amber-300"
              role="status"
            >
              3D Replay could not be loaded; Display opened without it.
            </p>
          )}
        </div>

        <section
          aria-labelledby="workbench-controls-title"
          className="rounded-xl border border-white/10 bg-[var(--surface-1)]/45 p-4 shadow-[0_12px_30px_rgba(8,15,30,0.14)] sm:p-5"
        >
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Control center
              </div>
              <h4
                id="workbench-controls-title"
                className="mt-1 text-sm font-semibold text-slate-200"
              >
                Dashboard controls
              </h4>
              <p className="mt-1 text-[11px] text-slate-500">
                Adjust the reporting window, refresh local data, or manage
                Workbench rules.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] tabular-nums text-slate-500">
              {availableDays.length.toLocaleString()} reporting days
            </span>
            <span className="rounded-full border border-cyan-400/15 bg-cyan-400/[0.04] px-2.5 py-1 text-[10px] tabular-nums text-cyan-200/75">
              Data updated through {formatDataUpdatedAt(dataUpdatedAt)}
            </span>
          </div>

          <div className="grid gap-3 lg:grid-cols-[0.8fr_1.25fr_1.25fr]">
            <div className="flex min-w-0 flex-col gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
              <span>Sources</span>
              <div
                className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/10 bg-[var(--surface-0)]/70 px-3 py-2 normal-case tracking-normal"
                role="group"
                aria-label="Workbench data sources"
              >
                {SOURCE_OPTIONS.map((item) => (
                  <label
                    key={item.value}
                    className="flex items-center gap-1.5 text-xs font-normal text-slate-200"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSources.includes(item.value)}
                      onChange={() => toggleWorkbenchSource(item.value)}
                      className="accent-cyan-400"
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="flex min-w-0 flex-col gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
              <span>Start date</span>
              <input
                type="datetime-local"
                value={startDateTime}
                max={endDateTime || undefined}
                step={60}
                disabled={availableDays.length === 0}
                onChange={(event) => setStartDateTime(event.target.value)}
                className="h-10 rounded-lg border border-white/10 bg-[var(--surface-0)]/70 px-3 text-xs font-normal normal-case tracking-normal text-slate-200 transition-colors focus:border-cyan-400/70 focus:outline-none disabled:opacity-50"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
              <span>End date</span>
              <input
                type="datetime-local"
                value={endDateTime}
                min={startDateTime || undefined}
                step={60}
                disabled={availableDays.length === 0}
                onChange={(event) => setEndDateTime(event.target.value)}
                className="h-10 rounded-lg border border-white/10 bg-[var(--surface-0)]/70 px-3 text-xs font-normal normal-case tracking-normal text-slate-200 transition-colors focus:border-cyan-400/70 focus:outline-none disabled:opacity-50"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Quick range
            </span>
            {DATE_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.value}
                type="button"
                onClick={() => applyDateShortcut(shortcut.value)}
                className="rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
              >
                {shortcut.label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Actions
            </span>
            <button
              type="button"
              onClick={resetDateRange}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiRotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              Reset range
            </button>
            <button
              type="button"
              onClick={() => setLocalRefreshToken((value) => value + 1)}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FiRefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              Reload local data
            </button>
            <span
              className="mx-1 hidden h-5 w-px bg-white/10 sm:block"
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={() => setMappingEditorOpen((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiSettings aria-hidden="true" className="h-3.5 w-3.5" />
              Workstation mappings
            </button>
            <button
              type="button"
              onClick={() => setPersonnelEditorOpen((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiUsers aria-hidden="true" className="h-3.5 w-3.5" />
              Personnel mapping
            </button>
            <button
              type="button"
              onClick={() => setRewardEditorOpen((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiAward aria-hidden="true" className="h-3.5 w-3.5" />
              Reward rules
            </button>
            {isWorkbenchOrganizationDisplayPath(pathname) && (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-violet-300/25 bg-violet-300/[0.06] px-3 py-2 text-xs font-medium text-violet-200">
                <input
                  type="checkbox"
                  checked={replayEnabled}
                  onChange={(event) => setReplayEnabled(event.target.checked)}
                  className="accent-violet-300"
                />
                Include 3D Replay
              </label>
            )}
          </div>
          {actionMessage && !drilldown && (
            <p className="mt-3 text-[11px] text-emerald-300" role="status">
              {actionMessage}
            </p>
          )}
        </section>
      </header>

      {undatedDatasetCount > 0 && (
        <section
          aria-label="Workbench datasets awaiting date confirmation"
          className="rounded-md border border-sky-400/20 bg-sky-400/[0.05] px-3 py-2.5 text-xs text-sky-100"
        >
          <span className="font-medium text-sky-200">日期待确认</span>
          <span className="ml-2 text-sky-100/75">
            {undatedDatasetCount.toLocaleString()}{" "}
            个数据集没有采集日期证据，仍计入来源总量，但不计入具体日期范围。
          </span>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-sky-200/90">
              查看待确认数据集路径
            </summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded border border-sky-300/10 bg-black/10 p-2 font-mono text-[11px] text-sky-100/75">
              {undatedDatasetPaths.map((datasetPath) => (
                <li key={datasetPath}>{datasetPath}</li>
              ))}
            </ul>
          </details>
        </section>
      )}
      <WorkbenchStatisticsFilterNotice filter={statisticsFilter} />

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
          <section
            aria-labelledby="workbench-overview-title"
            className="rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/[0.06] via-[var(--surface-1)]/45 to-[var(--surface-0)]/40 p-4 shadow-[0_16px_38px_rgba(8,15,30,0.16)] sm:p-5"
          >
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/70">
                  Live snapshot
                </div>
                <h4
                  id="workbench-overview-title"
                  className="mt-1 text-sm font-semibold text-slate-200"
                >
                  Operations overview
                </h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  Organization totals and selected-range performance at a
                  glance.
                </p>
              </div>
              <span className="rounded-full border border-cyan-400/15 bg-cyan-400/[0.05] px-2.5 py-1 text-[10px] text-cyan-200/75">
                {range.startDate && range.endDate
                  ? range.startDate + " → " + range.endDate
                  : "Auto range"}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[
                [
                  organization + " total hours",
                  organizationTotalHours.toLocaleString("en-US", {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  }) + " h",
                ],
                ["Selected range hours", formatHours(totalHours) + " h"],
                ["Episodes", formatCount(totalEpisodes)],
                ["Tasks", formatCount(selectedDatasetPaths.length)],
                ["Storage", formatBytes(selectedStorageBytes)],
                [
                  "Daily target hours",
                  formatHours(rewardDraft.dailyTargetHours) + " h/day",
                ],
                [
                  "Total bonus",
                  formatWorkbenchRewardAmount(projectedRewardAmount),
                ],
                ["Sources", formatCount(robotIds)],
                [
                  "Days in range",
                  rangeDays === null ? "—" : formatCount(rangeDays),
                ],
              ].map(([label, value], index) => (
                <div
                  key={label}
                  className={
                    index < 2
                      ? "rounded-lg border border-cyan-400/30 bg-cyan-400/[0.09] p-4 shadow-[inset_0_1px_rgba(165,243,252,0.12)]"
                      : "rounded-lg border border-white/10 bg-[var(--surface-0)]/45 p-4"
                  }
                >
                  <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
                    {label}
                  </div>
                  <div
                    className={
                      index < 2
                        ? "mt-2 text-2xl font-semibold tracking-tight text-cyan-100 tabular-nums"
                        : "mt-2 text-xl font-semibold tracking-tight text-slate-100 tabular-nums"
                    }
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Workstation detail
                </h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  Rows follow the selected statistics scope and workstation
                  mappings.
                </p>
              </div>
              <span className="text-[10px] text-slate-500">
                {sourceWorkstationDashboardRows.length === 0
                  ? "No grouped rows"
                  : `${sourceWorkstationDashboardRows.length} group(s)`}
              </span>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-md border border-white/10 bg-black/10 px-2.5 py-1.5 text-[11px] text-slate-500">
                <span className="shrink-0">Filter</span>
                <input
                  value={workstationQuery}
                  onChange={(event) => setWorkstationQuery(event.target.value)}
                  placeholder="robot, workstation, dataset…"
                  className="min-w-0 flex-1 bg-transparent text-slate-200 outline-none placeholder:text-slate-600"
                  aria-label="Filter workstation rows"
                />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-slate-500">
                Sort
                <select
                  value={workstationSort}
                  onChange={(event) =>
                    setWorkstationSort(
                      event.target.value as
                        | "reward"
                        | "hours"
                        | "robot"
                        | "datasets",
                    )
                  }
                  className="rounded-md border border-white/10 bg-[var(--surface-0)] px-2 py-1.5 text-slate-200 outline-none"
                  aria-label="Sort workstation rows"
                >
                  <option value="reward">Reward</option>
                  <option value="hours">Hours</option>
                  <option value="datasets">Datasets</option>
                  <option value="robot">Workstation</option>
                </select>
              </label>
              <button
                type="button"
                onClick={exportWorkbenchCsv}
                className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.06] px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/[0.12]"
              >
                Export CSV
              </button>
              <button
                type="button"
                onClick={() => void copyWorkbenchShareLink()}
                className="rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
              >
                Copy share link
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                <thead className="bg-[var(--surface-2)] text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">Workstation</th>
                    <th className="px-3 py-2.5 font-medium">Personnel</th>
                    <th className="px-3 py-2.5 font-medium">Source repos</th>
                    <th className="px-3 py-2.5 font-medium">Datasets</th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title="Workstation Hours"
                    >
                      WS hours
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title="Per-person target hours"
                    >
                      Avg target
                    </th>
                    <th className="px-3 py-2.5 font-medium">Rate</th>
                    <th className="px-3 py-2.5 font-medium">Rule</th>
                    <th className="px-3 py-2.5 font-medium">Reward</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRobotDashboardRows.map((row) => (
                    <tr
                      key={`${row.sourceKey}-${row.workstation}-${row.group}`}
                      className="cursor-pointer border-t border-white/5 transition-colors hover:bg-cyan-400/[0.04] focus:bg-cyan-400/[0.06] focus:outline-none"
                      tabIndex={0}
                      role="button"
                      onClick={(event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest("button,a,input,select")
                        ) {
                          return;
                        }
                        openWorkbenchDrilldown({
                          title: `${row.workstation} detail`,
                          detail: `${row.workstation} · ${formatHours(row.hours)} hours · ${formatCount(row.count)} datasets`,
                          datasets: datasetsForSourceWorkstation(
                            row.sourceKey,
                            row.workstation,
                          ),
                          episodeId: 0,
                        });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openWorkbenchDrilldown({
                            title: `${row.workstation} detail`,
                            detail: `${row.workstation} · ${formatHours(row.hours)} hours · ${formatCount(row.count)} datasets`,
                            datasets: datasetsForSourceWorkstation(
                              row.sourceKey,
                              row.workstation,
                            ),
                            episodeId: 0,
                          });
                        }
                      }}
                    >
                      <td
                        className="cursor-help px-3 py-2.5 text-slate-100"
                        title={`Workstation: ${row.workstation}`}
                      >
                        {row.workstation}
                      </td>
                      <td
                        className="px-3 py-2.5 text-slate-300"
                        title={
                          personnelByWorkstation
                            .get(row.workstation)
                            ?.join(", ") || "No personnel mapping"
                        }
                      >
                        {personnelByWorkstation
                          .get(row.workstation)
                          ?.join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300">
                        <SourceReposCell repoIds={row.sourceRepoIds} />
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
                        <WorkbenchRuleBadge
                          label={row.reward.level?.label}
                          symbol={row.reward.symbol}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                        {formatWorkbenchRewardAmount(row.reward.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibleRobotDashboardRows.length === 0 && (
              <p className="mt-3 text-xs text-slate-500">
                No workstation rows match the filter.
              </p>
            )}
          </section>

          <WorkbenchPersonnelWorkload rollup={personnelRollup} />

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Workstation day heatmap
              </h4>
              <span className="text-[10px] text-slate-500">
                {heatmapDays.length === 0
                  ? "No data days since 2026-08-22"
                  : "2026-08-22 → " +
                    (workstationHeatmapRange.endDate ?? "Latest") +
                    " · " +
                    heatmapDays.length +
                    " latest data days"}
              </span>
            </div>
            {heatmapDays.length === 0 ? (
              <div className="rounded-md border border-white/10 bg-white/[0.02] p-4 text-xs text-slate-500">
                No workstation day data is available from 2026-08-22 through the
                selected end date.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div
                  className="min-w-[760px]"
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(13rem, 1.4fr) repeat(" +
                      heatmapDays.length +
                      ", minmax(3.5rem, 1fr))",
                  }}
                >
                  <div className="border-b border-white/10 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    Workstation
                  </div>
                  {heatmapDays.map((day) => (
                    <div
                      key={day}
                      className="border-b border-white/10 px-2 py-2 text-center text-[10px] uppercase tracking-[0.12em] text-slate-500 tabular-nums"
                    >
                      {day.slice(5)}
                    </div>
                  ))}
                  {heatmapRows.map((row) => (
                    <Fragment key={row.workstation}>
                      <div className="border-b border-white/5 px-3 py-2 text-xs text-slate-200">
                        <div className="truncate font-medium">
                          {row.workstation}
                        </div>
                      </div>
                      {heatmapDays.map((day) => {
                        const hours = row.hoursByDay[day] ?? 0;
                        const alpha =
                          hours <= 0
                            ? 0.03
                            : Math.min(
                                0.85,
                                0.08 + (hours / heatmapMaxHours) * 0.75,
                              );
                        return (
                          <button
                            type="button"
                            key={row.workstation + "-" + day}
                            className="border-b border-white/5 px-2 py-2 text-center text-xs tabular-nums text-slate-100 transition-colors hover:bg-cyan-200/20 focus:bg-cyan-200/25 focus:outline-none"
                            style={{
                              backgroundColor:
                                "rgba(56, 189, 248, " + alpha + ")",
                            }}
                            onClick={() =>
                              openWorkbenchDrilldown({
                                title: row.workstation + " · " + day,
                                detail:
                                  row.workstation +
                                  " · " +
                                  formatHours(hours) +
                                  " hours",
                                day,
                                datasets: sourceFilteredLocalDatasets.filter(
                                  (dataset) => {
                                    const mappingKey =
                                      dataset.robotId?.trim() ||
                                      dataset.leftGripperSn?.trim() ||
                                      "";
                                    const mappedWorkstation = mappingKey
                                      ? workstationDraft[mappingKey]?.trim() ||
                                        workstationMappings[
                                          mappingKey
                                        ]?.trim() ||
                                        workstationDefaults[
                                          mappingKey
                                        ]?.trim() ||
                                        "未分配"
                                      : "未分配";
                                    return (
                                      mappedWorkstation === row.workstation &&
                                      workbenchDatasetRangeContributions(
                                        dataset,
                                        workstationHeatmapRange,
                                      ).some((addition) => addition.day === day)
                                    );
                                  },
                                ),
                                episodeId: 0,
                              })
                            }
                            title={
                              row.workstation +
                              " " +
                              day +
                              ": " +
                              formatHours(hours) +
                              "h"
                            }
                          >
                            {hours > 0 ? formatHours(hours) : "—"}
                          </button>
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
                {dailyTrendTimeline.range.startDate ?? "Beginning"} →{" "}
                {dailyTrendTimeline.range.endDate ?? "Latest"}
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
                    dot={(props: {
                      cx?: number;
                      cy?: number;
                      payload?: { date?: string; hours?: number };
                    }) => {
                      if (
                        typeof props.cx !== "number" ||
                        typeof props.cy !== "number" ||
                        !props.payload?.date
                      ) {
                        return <g />;
                      }
                      return (
                        <circle
                          cx={props.cx}
                          cy={props.cy}
                          r={4}
                          fill="#38bdf8"
                          stroke="#e0f2fe"
                          strokeWidth={1}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open daily trend for ${props.payload.date}`}
                          onClick={() => {
                            const day = props.payload?.date;
                            if (!day) return;
                            openWorkbenchDrilldown({
                              title: `Daily trend · ${day}`,
                              detail: `${formatHours(props.payload?.hours ?? 0)} hours`,
                              day,
                              datasets: sourceFilteredLocalDatasets.filter(
                                (dataset) =>
                                  workbenchDatasetRangeContributions(
                                    dataset,
                                    dailyTrendTimeline.range,
                                  ).some((addition) => addition.day === day),
                              ),
                              episodeId: 0,
                            });
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ")
                              return;
                            event.preventDefault();
                            event.currentTarget.dispatchEvent(
                              new MouseEvent("click", { bubbles: true }),
                            );
                          }}
                        />
                      );
                    }}
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
                <p className="mt-1 text-[11px] text-slate-500">
                  Workstation · {range.startDate ?? "Beginning"} →{" "}
                  {range.endDate ?? "Latest"}
                </p>
              </div>
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

          {drilldown && (
            <section
              aria-labelledby="workbench-drilldown-title"
              className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.04] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300/70">
                    Drilldown
                  </div>
                  <h4
                    id="workbench-drilldown-title"
                    className="mt-1 text-sm font-semibold text-slate-100"
                  >
                    {drilldown.title}
                  </h4>
                  <p className="mt-1 text-xs text-slate-400">
                    {drilldown.detail}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={createReviewTaskFromDrilldown}
                    className="rounded-md border border-amber-300/30 bg-amber-300/[0.08] px-2.5 py-1.5 text-[11px] font-medium text-amber-200 transition-colors hover:border-amber-200/60 hover:bg-amber-300/[0.14]"
                  >
                    Create review task
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrilldown(null)}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-white/25 hover:text-white"
                  >
                    Close
                  </button>
                </div>
              </div>
              {actionMessage && (
                <p className="mt-3 text-[11px] text-emerald-300" role="status">
                  {actionMessage}
                </p>
              )}
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {drilldown.datasets.map((dataset) => (
                  <a
                    key={dataset.relativePath}
                    href={datasetEpisodeHref(
                      dataset,
                      drilldown.episodeId ?? 0,
                      drilldown.frame,
                    )}
                    className="rounded-md border border-white/10 bg-black/10 px-3 py-2 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06]"
                  >
                    <span className="block truncate font-mono text-[11px] text-cyan-200">
                      {dataset.relativePath}
                    </span>
                    <span className="mt-1 block text-[10px] text-slate-500">
                      Open episode {drilldown.episodeId ?? 0}
                      {drilldown.frame === undefined
                        ? ""
                        : ` · frame ${drilldown.frame}`}
                    </span>
                  </a>
                ))}
              </div>
              {drilldown.datasets.length === 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  No dataset additions match this selection.
                </p>
              )}
            </section>
          )}

          {mappingEditorOpen && (
            <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    Workstation mappings
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Workstation edits now use robot_id. Existing legacy mappings
                    are preserved for compatibility.
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
                      <th className="px-3 py-2.5 font-medium">Workstation</th>
                      <th className="px-3 py-2.5 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {robotDashboardRows.map((row) => (
                      <tr
                        key={`${row.sourceKey}-${row.workstation}-${row.group}`}
                        className="border-t border-white/5"
                      >
                        <td className="px-3 py-2.5 text-slate-100">
                          {row.robotId ?? "—"}
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
                  Existing legacy left SN mappings are still loaded for
                  compatibility; new workstation edits should use robot_id.
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

          {personnelEditorOpen && (
            <WorkbenchPersonnelMappingEditor
              organization={organization}
              config={personnelConfig}
              workstationSuggestions={Array.from(
                new Set(
                  [
                    ...Object.values(workstationDefaults),
                    ...Object.values(workstationMappings),
                    ...Object.values(workstationDraft),
                    ...Object.values(workstationLegacyDefaults),
                    ...Object.values(workstationLegacyMappings),
                    ...Object.values(workstationLegacyDraft),
                  ].filter(Boolean),
                ),
              ).sort()}
              onSaved={setPersonnelConfig}
            />
          )}

          <WorkbenchMailComposer
            organization={organization}
            dashboardInput={mailDashboardInput}
            recipientSuggestions={recipientSuggestions}
            recipientGroups={recipientGroups}
          />
        </>
      )}
      {displaySnapshot && (
        <WorkbenchDisplay snapshot={displaySnapshot} onExit={closeDisplay} />
      )}
    </section>
  );
}

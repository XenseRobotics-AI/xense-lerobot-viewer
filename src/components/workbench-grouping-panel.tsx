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
import WorkbenchSharedSync from "@/components/workbench-shared-sync";
import { formatBytes } from "@/utils/byteSize";
import {
  computeWorkbenchAdditionTimeline,
  computeWorkbenchAdditionRollup,
  WORKBENCH_DATASET_SOURCE_KEYS,
  WORKBENCH_DATASET_SOURCE_LABELS,
  countHalfOpenDays,
  getWorkbenchDatasetWorkstation,
  getWorkbenchDatasetIdentity,
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
  DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
  evaluateWorkbenchRewardRules,
  formatWorkbenchAverageEpisode,
  formatWorkbenchRewardAmount,
  type WorkbenchEpisodeDurationLevel,
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
  EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
  EMPTY_TACVERSE_HUB_CATEGORY_SELECTION,
  serializeTacverseHubCategorySelection,
  type TacverseHubCategoryCounts,
  type TacverseHubCategorySelection,
} from "@/utils/workbenchHubCategory";
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
  WORKBENCH_REPLAY_DATASETS,
  type WorkbenchDisplaySnapshot,
} from "@/components/workbench-display-utils";
import { workbenchReplayDatasetRank } from "@/utils/workbenchReplayDatasets";
import { useT } from "@/context/locale-context";
import type { InterpolationVars } from "@/i18n/format";
import type { MessageKey } from "@/i18n/messages";

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
  { value: "today", key: "workbench.today" },
  { value: "yesterday", key: "workbench.yesterday" },
  { value: "last7Days", key: "workbench.last7Days" },
  { value: "thisWeek", key: "workbench.thisWeek" },
  { value: "lastWeek", key: "workbench.lastWeek" },
] as const;

const WORKBENCH_WORKSTATION_CONCEPT_START_DATE = "2026-08-22";
const WORKBENCH_DAILY_TREND_START_DATE = "2026-07-01";
const WORKBENCH_HEATMAP_DAY_LIMIT = 10;
type Translator = (key: MessageKey, vars?: InterpolationVars) => string;

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
  const relativePath = dataset.relativePath.trim();
  const linkedRepoId = getLinkedHubDatasetRepoId(
    makeLocalRepoId(dataset.relativePath),
  );
  return (
    WORKBENCH_REPLAY_DATASETS.includes(relativePath) ||
    (linkedRepoId !== null && WORKBENCH_REPLAY_DATASETS.includes(linkedRepoId))
  );
}

function hasWorkbenchReplaySource(
  selectedSourceSet: ReadonlySet<WorkbenchDatasetSourceKey>,
): boolean {
  return (
    selectedSourceSet.has("taccap-g1") || selectedSourceSet.has("xtac-umi-g1")
  );
}

function isWorkbenchReplayDatasetReady(dataset: WorkbenchDataset): boolean {
  return (
    dataset.integrity.status === "ok" &&
    dataset.integrity.hasData &&
    dataset.integrity.hasVideos
  );
}

function compareWorkbenchReplayDatasets(
  left: WorkbenchDataset,
  right: WorkbenchDataset,
): number {
  return (
    Number(isWorkbenchReplayDatasetReady(right)) -
      Number(isWorkbenchReplayDatasetReady(left)) ||
    workbenchReplayDatasetRank(left.relativePath) -
      workbenchReplayDatasetRank(right.relativePath) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function selectWorkbenchReplayDataset(
  datasets: readonly WorkbenchDataset[],
): WorkbenchDataset | null {
  return (
    datasets
      .filter(isTacCapReplayDataset)
      .sort(compareWorkbenchReplayDatasets)[0] ?? null
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
  categoryFilter?: TacverseHubCategorySelection;
  refreshedAt?: string | null;
  hubTotal?: number;
  categoryTotal?: number;
  categoryCounts?: TacverseHubCategoryCounts;
  localMatchedTotal?: number;
  error?: string;
};

type WorkbenchDashboardRow = WorkbenchRollupRow & {
  robotId: string | null;
  collectorSerialNumber: string | null;
  leftGripperSn: string | null;
  sourceKey: WorkbenchDatasetSourceKey;
  sourceLabel: string;
  sourceKeys: WorkbenchDatasetSourceKey[];
  sourceLabels: string[];
  workstation: string;
  reward: ReturnType<typeof evaluateWorkbenchRewardRules>;
  sourceRepoIds: string[];
  dailyHours: Record<string, number>;
};

type WorkbenchDashboardAggregateRow = Omit<WorkbenchDashboardRow, "reward">;

type RewardRulesDraft = Omit<
  WorkbenchRewardRulesConfig,
  "episodeDurationLevels"
> & {
  org: string;
  episodeDurationLevels: WorkbenchEpisodeDurationLevel[];
};

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

function cloneRewardLevels<T extends object>(levels: readonly T[]): T[] {
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
    episodeDurationLevels: cloneRewardLevels(
      config.episodeDurationLevels ?? DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
    ),
    qualityBonusByGrade: config.qualityBonusByGrade
      ? { ...config.qualityBonusByGrade }
      : undefined,
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
    episodeDurationLevels: cloneRewardLevels(
      DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
    ),
  };
}

function validateRewardDraft(
  draft: RewardRulesDraft,
  t?: Translator,
): string | null {
  if (!draft.enabled) return null;
  if (!Number.isFinite(draft.dailyTargetHours) || draft.dailyTargetHours <= 0) {
    return (
      t?.("workbench.dailyTargetPositive") ??
      "Daily target hours must be greater than 0."
    );
  }
  if (draft.levels.length === 0)
    return t?.("workbench.addRewardLevel") ?? "Add at least one reward level.";
  const sorted = [...draft.levels].sort(
    (left, right) => left.minPercent - right.minPercent,
  );
  if (Math.abs(sorted[0]?.minPercent ?? 0) > 1e-9) {
    return (
      t?.("workbench.firstLevelZero") ?? "The first level must start at 0%."
    );
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const level = sorted[index];
    if (!Number.isFinite(level.minPercent) || level.minPercent < 0) {
      return (
        t?.("workbench.thresholdsInvalid") ??
        "Level thresholds must be valid numbers."
      );
    }
    if (!Number.isFinite(level.amount)) {
      return (
        t?.("workbench.amountsInvalid") ??
        "Level amounts must be valid numbers."
      );
    }
    if (index > 0) {
      const previous = sorted[index - 1];
      if (previous.maxPercent === null) {
        return (
          t?.("workbench.onlyLastOpen") ??
          "Only the last level can be open-ended."
        );
      }
      if (Math.abs(previous.maxPercent - level.minPercent) > 1e-9) {
        return (
          t?.("workbench.levelRangesContinuous") ??
          "Level ranges must be continuous."
        );
      }
    }
  }
  const durationLevels = [...draft.episodeDurationLevels].sort(
    (left, right) => left.minSeconds - right.minSeconds,
  );
  if (durationLevels.length === 0 || durationLevels[0].minSeconds !== 0) {
    return (
      t?.("workbench.durationStartZero") ??
      "Episode duration levels must start at 0 seconds."
    );
  }
  for (let index = 0; index < durationLevels.length; index += 1) {
    const level = durationLevels[index];
    if (!Number.isFinite(level.multiplier) || level.multiplier <= 0) {
      return (
        t?.("workbench.durationMultipliersPositive") ??
        "Episode duration multipliers must be positive numbers."
      );
    }
    if (index > 0) {
      const previous = durationLevels[index - 1];
      if (
        previous.maxSeconds === null ||
        Math.abs(previous.maxSeconds - level.minSeconds) > 1e-9
      ) {
        return (
          t?.("workbench.durationRangesContinuous") ??
          "Episode duration ranges must be continuous."
        );
      }
    }
  }
  if (durationLevels.at(-1)?.maxSeconds !== null) {
    return (
      t?.("workbench.durationLastOpen") ??
      "The last episode duration level must be open-ended."
    );
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
  const t = useT();
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
      title={t("workbench.copyRepoTitle", { repo: repoId })}
      aria-label={t("workbench.copyRepoAria", { repo: repoId })}
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
            {copyState.ok ? t("workbench.copied") : t("workbench.copyFailed")}
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
          {t("workbench.repos", { count: repos.length })}
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
              {copyState.ok ? t("workbench.copied") : t("workbench.copyFailed")}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t("workbench.viewRepos", { count: repos.length })}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[10px] text-cyan-200 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/10"
        >
          {t("workbench.view")}
        </button>
      </div>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 max-h-64 w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-white/10 bg-[var(--surface-2)] p-2 shadow-xl shadow-black/50"
          role="dialog"
          aria-label={t("workbench.sourceRepos")}
        >
          <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            {t("workbench.copyRepoHint")}
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
                    {copyState.ok
                      ? t("workbench.copied")
                      : t("workbench.copyFailed")}
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
  categoryFilter = EMPTY_TACVERSE_HUB_CATEGORY_SELECTION,
  refreshToken = 0,
  episodeData,
}: {
  organization: string;
  categoryFilter?: TacverseHubCategorySelection;
  refreshToken?: number;
  episodeData?: EpisodeData;
}) {
  const t = useT();
  const sourceOptions = useMemo(
    () =>
      WORKBENCH_DATASET_SOURCE_KEYS.map((value) => ({
        value,
        label:
          value === "taccap-g1"
            ? t("workbench.sourceTaccap")
            : value === "xtac-umi-g1"
              ? t("workbench.sourceXtac")
              : value === "tacflow"
                ? t("workbench.sourceTacflow")
                : t("workbench.sourceUnclassified"),
      })),
    [t],
  );
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
  const [hubScope, setHubScope] = useState<{
    refreshedAt: string | null;
    hubTotal: number;
    categoryTotal: number;
    categoryCounts: TacverseHubCategoryCounts;
    localMatchedTotal: number;
  }>({
    refreshedAt: null,
    hubTotal: 0,
    categoryTotal: 0,
    categoryCounts: EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
    localMatchedTotal: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefreshToken, setLocalRefreshToken] = useState(0);
  const [dataUpdatedAt, setDataUpdatedAt] = useState<string | null>(null);
  const categoryParam = serializeTacverseHubCategorySelection(categoryFilter);
  const loadedCategoryRef = useRef(categoryParam);
  const categoryRangeCheckPendingRef = useRef(categoryParam !== "all");
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
    if (loadedCategoryRef.current !== categoryParam) {
      categoryRangeCheckPendingRef.current = true;
      setDatasets([]);
    }
    fetch(
      "/api/workbench/statistics?org=" +
        encodeURIComponent(organization) +
        "&category=" +
        encodeURIComponent(categoryParam),
      {
        cache: "no-store",
        signal: controller.signal,
      },
    )
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
          throw new Error(t("workbench.statisticsResponseIncomplete"));
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
        loadedCategoryRef.current = serializeTacverseHubCategorySelection(
          payload.categoryFilter ?? categoryFilter,
        );
        setDatasets(payload.datasets ?? []);
        setHubScope({
          refreshedAt: payload.refreshedAt ?? null,
          hubTotal: payload.hubTotal ?? 0,
          categoryTotal: payload.categoryTotal ?? 0,
          categoryCounts:
            payload.categoryCounts ?? EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
          localMatchedTotal: payload.localMatchedTotal ?? 0,
        });
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
            episodeDurationLevels:
              rewardConfig?.episodeDurationLevels ??
              rewardDefaultConfig.episodeDurationLevels,
            qualityBonusByGrade:
              rewardConfig?.qualityBonusByGrade ??
              rewardDefaultConfig.qualityBonusByGrade,
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
            t("workbench.scanErrors", {
              count: payload.errors?.length ?? 0,
            }),
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
  }, [
    categoryFilter,
    categoryParam,
    organization,
    refreshToken,
    localRefreshToken,
    t,
  ]);

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
    if (availableDays.length === 0) return;
    if (!latestRangeAppliedRef.current) {
      const next = getWorkbenchLatestAvailableDateTimeRange(availableDays);
      setStartDateTime(next.startDateTime);
      setEndDateTime(next.endDateTime);
      latestRangeAppliedRef.current = true;
      return;
    }
    if (!categoryRangeCheckPendingRef.current) return;
    categoryRangeCheckPendingRef.current = false;
    const startDay = dayKeyFromDateTimeInput(startDateTime);
    const endDay = dayKeyFromDateTimeInput(endDateTime);
    const rangeStillAvailable = Boolean(
      startDay &&
      endDay &&
      startDay < endDay &&
      availableDays.some((day) => day >= startDay && day < endDay),
    );
    if (rangeStillAvailable) return;
    const next = getWorkbenchLatestAvailableDateTimeRange(availableDays);
    setStartDateTime(next.startDateTime);
    setEndDateTime(next.endDateTime);
  }, [availableDays, endDateTime, startDateTime]);
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
      const workstation =
        getWorkbenchDatasetWorkstation(
          dataset,
          [workstationDraft, workstationMappings, workstationDefaults],
          [
            workstationLegacyDraft,
            workstationLegacyMappings,
            workstationLegacyDefaults,
          ],
        ) ?? "未分配";
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
    workstationLegacyDefaults,
    workstationLegacyDraft,
    workstationLegacyMappings,
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

  const robotDashboardRows = useMemo<WorkbenchDashboardAggregateRow[]>(() => {
    const sourceRepoIds = robotSourceRepoMap;
    const grouped = new Map<string, WorkbenchDashboardAggregateRow>();
    for (const row of robotRows) {
      const repos = sourceRepoIds.get(row.group) ?? [];
      const sourceDataset = workstationRollupDatasets.find(
        (dataset) =>
          (getWorkbenchDatasetIdentity(dataset) || "—") === row.group,
      );
      const workstation = sourceDataset
        ? (getWorkbenchDatasetWorkstation(
            sourceDataset,
            [workstationDraft, workstationMappings, workstationDefaults],
            [
              workstationLegacyDraft,
              workstationLegacyMappings,
              workstationLegacyDefaults,
            ],
          ) ?? "—")
        : "—";
      const dailyHours: Record<string, number> = {};
      for (const dataset of workstationRollupDatasets) {
        const key = getWorkbenchDatasetIdentity(dataset) || "—";
        if (key !== row.group) continue;
        for (const addition of dataset.dailyAdditions ?? []) {
          if (!dateInRange(addition.day, range.startDate, range.endDate))
            continue;
          const hours = Number(addition.hours);
          if (!Number.isFinite(hours) || hours <= 0) continue;
          dailyHours[addition.day] = (dailyHours[addition.day] ?? 0) + hours;
        }
      }
      grouped.set(row.group, {
        ...row,
        robotId: row.group === "—" ? null : row.group,
        collectorSerialNumber: sourceDataset?.collectorSerialNumber ?? null,
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
        sourceKeys: [
          sourceDataset?.source ??
            (sourceDataset
              ? workbenchDatasetSourceKey(sourceDataset.relativePath)
              : "unclassified"),
        ],
        sourceLabels: [
          sourceDataset?.sourceLabel ??
            (sourceDataset
              ? workbenchDatasetSourceLabel(
                  sourceDataset.source ??
                    workbenchDatasetSourceKey(sourceDataset.relativePath),
                )
              : "TacVerse/待确认"),
        ],
        workstation,
        sourceRepoIds: repos,
        dailyHours,
      });
    }
    return Array.from(grouped.values());
  }, [
    range.endDate,
    range.startDate,
    robotRows,
    robotSourceRepoMap,
    workstationRollupDatasets,
    workstationDefaults,
    workstationDraft,
    workstationLegacyDefaults,
    workstationLegacyDraft,
    workstationLegacyMappings,
    workstationMappings,
  ]);
  const sourceWorkstationDashboardRows = useMemo<
    WorkbenchDashboardAggregateRow[]
  >(() => {
    type GroupedRow = WorkbenchDashboardAggregateRow & {
      datasetPaths: Set<string>;
    };
    const grouped = new Map<string, GroupedRow>();
    for (const dataset of workstationRollupDatasets) {
      const additions = workbenchDatasetRangeContributions(dataset, range);
      if (additions.length === 0) continue;
      const sourceKey =
        dataset.source ?? workbenchDatasetSourceKey(dataset.relativePath);
      const sourceLabel =
        dataset.sourceLabel ?? workbenchDatasetSourceLabel(sourceKey);
      const workstation =
        getWorkbenchDatasetWorkstation(
          dataset,
          [workstationDraft, workstationMappings, workstationDefaults],
          [
            workstationLegacyDraft,
            workstationLegacyMappings,
            workstationLegacyDefaults,
          ],
        ) ?? "未分配";
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
        sourceKeys: [sourceKey],
        sourceLabels: [sourceLabel],
        workstation,
        sourceRepoIds: [],
        dailyHours: {},
        collectorSerialNumber: null,
        datasetPaths: new Set<string>(),
      };
      if (!current.datasetPaths.has(dataset.relativePath)) {
        current.datasetPaths.add(dataset.relativePath);
        current.count += 1;
        const repoId = workbenchSourceRepoId(dataset.relativePath);
        if (!current.sourceRepoIds.includes(repoId)) {
          current.sourceRepoIds.push(repoId);
        }
      }
      for (const addition of additions) {
        current.episodes += Number.isFinite(Number(addition.episodes))
          ? Math.max(0, Math.trunc(Number(addition.episodes)))
          : 0;
        current.frames += Number.isFinite(Number(addition.frames))
          ? Math.max(0, Math.trunc(Number(addition.frames)))
          : 0;
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
      };
    });
  }, [
    range,
    workstationDefaults,
    workstationDraft,
    workstationLegacyDefaults,
    workstationLegacyDraft,
    workstationLegacyMappings,
    workstationMappings,
    workstationRollupDatasets,
  ]);

  const workstationDashboardRows = useMemo<WorkbenchDashboardRow[]>(() => {
    type GroupedRow = WorkbenchDashboardAggregateRow & {
      sourceKeysSet: Set<WorkbenchDatasetSourceKey>;
      sourceLabelsSet: Set<string>;
    };
    const grouped = new Map<string, GroupedRow>();

    for (const row of sourceWorkstationDashboardRows) {
      const key = row.workstation;
      const current = grouped.get(key) ?? {
        ...row,
        group: row.workstation,
        sourceKey: row.sourceKey,
        sourceLabel: row.sourceLabel,
        sourceKeys: [],
        sourceLabels: [],
        sourceKeysSet: new Set<WorkbenchDatasetSourceKey>(),
        sourceLabelsSet: new Set<string>(),
        count: 0,
        episodes: 0,
        frames: 0,
        hours: 0,
        pctHours: 0,
        sourceRepoIds: [],
        dailyHours: {},
      };
      current.count += row.count;
      current.episodes += row.episodes;
      current.frames += row.frames;
      current.hours += row.hours;
      current.sourceKeysSet.add(row.sourceKey);
      current.sourceLabelsSet.add(row.sourceLabel);
      for (const repoId of row.sourceRepoIds) {
        if (!current.sourceRepoIds.includes(repoId)) {
          current.sourceRepoIds.push(repoId);
        }
      }
      for (const [day, hours] of Object.entries(row.dailyHours)) {
        current.dailyHours[day] = (current.dailyHours[day] ?? 0) + hours;
      }
      grouped.set(key, current);
    }

    return Array.from(grouped.values()).map(
      ({ sourceKeysSet, sourceLabelsSet, ...row }) => {
        const sourceKeys = Array.from(sourceKeysSet).sort();
        const sourceLabels = Array.from(sourceLabelsSet).sort((left, right) =>
          left.localeCompare(right),
        );
        return {
          ...row,
          sourceKey: sourceKeys.length === 1 ? sourceKeys[0] : "unclassified",
          sourceLabel: sourceLabels.join(" · "),
          sourceKeys,
          sourceLabels,
          hours: Math.round(row.hours * 1000) / 1000,
          sourceRepoIds: [...row.sourceRepoIds].sort((left, right) =>
            left.localeCompare(right),
          ),
          reward: evaluateWorkbenchRewardRules(
            row.hours,
            targetHours ?? 0,
            rewardDraft,
            row.episodes,
          ),
        };
      },
    );
  }, [rewardDraft, sourceWorkstationDashboardRows, targetHours]);

  const topWorkstationRows = useMemo(() => {
    return workstationDashboardRows
      .map((row) => ({
        group: row.workstation,
        hours: row.hours,
        count: row.count,
      }))
      .sort(
        (left, right) =>
          right.hours - left.hours || left.group.localeCompare(right.group),
      );
  }, [workstationDashboardRows]);
  const selectedChartRows = topWorkstationRows.slice(0, 12);

  const selectedWorkbenchDatasets = useMemo(
    () =>
      datasets.filter((dataset) =>
        selectedDatasetPaths.includes(dataset.relativePath),
      ),
    [datasets, selectedDatasetPaths],
  );
  const datasetsForWorkstation = useCallback(
    (workstation: string) =>
      selectedWorkbenchDatasets.filter((dataset) => {
        const mappedWorkstation =
          getWorkbenchDatasetWorkstation(
            dataset,
            [workstationDraft, workstationMappings, workstationDefaults],
            [
              workstationLegacyDraft,
              workstationLegacyMappings,
              workstationLegacyDefaults,
            ],
          ) ?? "未分配";
        return mappedWorkstation === workstation;
      }),
    [
      selectedWorkbenchDatasets,
      workstationDefaults,
      workstationDraft,
      workstationLegacyDefaults,
      workstationLegacyDraft,
      workstationLegacyMappings,
      workstationMappings,
    ],
  );

  const visibleRobotDashboardRows = useMemo(() => {
    const query = workstationQuery.trim().toLocaleLowerCase();
    const rows = workstationDashboardRows.filter((row) => {
      if (!query) return true;
      return [
        row.robotId,
        row.leftGripperSn,
        row.workstation,
        row.sourceLabel,
        ...row.sourceLabels,
        ...row.sourceRepoIds,
      ]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
    return [...rows].sort((left, right) => {
      if (workstationSort === "robot") {
        return left.workstation.localeCompare(right.workstation);
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
  }, [workstationDashboardRows, workstationQuery, workstationSort]);

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
      task ? t("workbench.reviewTaskCreated") : t("workbench.reviewTaskFailed"),
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
      copied ? t("workbench.shareLinkCopied") : t("workbench.shareLinkFailed"),
    );
  }, [endDateTime, selectedSources, startDateTime]);
  const personnelWorkstationMappings = useMemo(() => {
    const mappings: Record<string, string> = {};
    for (const dataset of workstationRollupDatasets) {
      const key = getWorkbenchDatasetIdentity(dataset);
      if (!key) continue;
      const workstation = getWorkbenchDatasetWorkstation(
        dataset,
        [workstationDraft, workstationMappings, workstationDefaults],
        [
          workstationLegacyDraft,
          workstationLegacyMappings,
          workstationLegacyDefaults,
        ],
      );
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
        row.reward.level?.label ?? row.reward.symbol,
        formatWorkbenchAverageEpisode(row.reward),
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
        row.rule,
        "",
        row.reward.amount,
        row.email,
      ]);
    }
    for (const row of dailyTrendTimeline.rows) {
      rows.push([
        "daily-trend",
        row.day,
        "",
        row.hours,
        row.datasets,
        "",
        "",
        "",
        "",
      ]);
    }
    const csv = workbenchCsv(
      [
        "section",
        "key",
        "workstation",
        "hours",
        "count_or_target",
        "rule",
        "avg_per_ep",
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
    setActionMessage(t("workbench.csvExported"));
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
  const projectedRewardAmount = workstationDashboardRows.reduce(
    (sum, row) => sum + row.reward.amount,
    0,
  );
  const rewardValidationError = validateRewardDraft(rewardDraft, t);
  const workstationDraftDirty = !recordsEqual(
    mergeMappings(workstationDraft, workstationLegacyDraft),
    mergeMappings(workstationMappings, workstationLegacyMappings),
  );
  const rewardDraftDirty =
    rewardDraft.enabled !== rewardDefaults.enabled ||
    rewardDraft.dailyTargetHours !== rewardDefaults.dailyTargetHours ||
    JSON.stringify(rewardDraft.levels) !==
      JSON.stringify(rewardDefaults.levels) ||
    JSON.stringify(rewardDraft.episodeDurationLevels) !==
      JSON.stringify(rewardDefaults.episodeDurationLevels);

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
      visibleRobotDashboardRows.filter((row) =>
        row.sourceKeys.some((sourceKey) => sourceKey !== "unclassified"),
      ),
    [visibleRobotDashboardRows],
  );
  const mailProjectedRewardAmount = useMemo(
    () =>
      workstationDashboardRows
        .filter((row) =>
          row.sourceKeys.some((sourceKey) => sourceKey !== "unclassified"),
        )
        .reduce((sum, row) => sum + row.reward.amount, 0),
    [workstationDashboardRows],
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
        averageEpisodeSeconds: row.reward.averageEpisodeSeconds,
        durationMultiplier: row.reward.multiplier,
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
      setMappingsMessage(t("workbench.mappingsSaved"));
    } catch (reason: unknown) {
      setMappingsError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setMappingsSaving(false);
    }
  }, [organization, t, workstationDraft, workstationLegacyDraft]);

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
      setRewardMessage(t("workbench.rewardRulesSaved"));
    } catch (reason: unknown) {
      setRewardError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRewardSaving(false);
    }
  }, [organization, rewardDraft, t]);

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

  const updateEpisodeDurationLevel = useCallback(
    (index: number, patch: Partial<WorkbenchEpisodeDurationLevel>) => {
      setRewardDraft((current) => ({
        ...current,
        episodeDurationLevels: current.episodeDurationLevels.map(
          (level, levelIndex) =>
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
  const heatmapEndDateLabel =
    workstationHeatmapRange.endDate ?? t("workbench.latest");

  const replayDataset = useMemo(
    () =>
      replayEnabled && hasWorkbenchReplaySource(selectedSourceSet)
        ? (selectWorkbenchReplayDataset(
            displayReplayDataset
              ? [...datasets, displayReplayDataset]
              : datasets,
          ) ?? undefined)
        : undefined,
    [datasets, displayReplayDataset, replayEnabled, selectedSourceSet],
  );
  const currentEpisodeIsReplaySource = Boolean(
    replayEnabled &&
    hasWorkbenchReplaySource(selectedSourceSet) &&
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
          workstations: workstationDashboardRows.map((row) => ({
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
            averageEpisodeSeconds: row.reward.averageEpisodeSeconds,
            durationMultiplier: row.reward.multiplier,
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
    workstationDashboardRows,
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
    t,
  ]);

  return (
    <section className="mx-auto w-full max-w-7xl space-y-4 py-5">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-400/[0.08] via-[var(--surface-1)]/50 to-emerald-400/[0.05] p-5 shadow-[0_18px_45px_rgba(8,15,30,0.22)] sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300/80">
              {t("workbench.operationsWorkspace")}
            </div>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-100">
              {t("workbench.dashboard")}
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">
              {t("workbench.description")}
            </p>
          </div>
          {isWorkbenchOrganizationDisplayPath(pathname) && (
            <button
              ref={displayButtonRef}
              type="button"
              onClick={openDisplay}
              disabled={loading || displayOpening}
              aria-label={t("workbench.openDisplay")}
              className="group inline-flex min-h-[4.25rem] items-center justify-center gap-3 rounded-xl border border-cyan-200/70 bg-gradient-to-br from-cyan-200 via-cyan-300 to-emerald-300 px-5 py-3 text-left text-slate-950 shadow-[0_12px_30px_rgba(34,211,238,0.28)] ring-1 ring-cyan-100/30 transition-all hover:-translate-y-0.5 hover:from-cyan-100 hover:to-emerald-200 hover:shadow-[0_16px_36px_rgba(34,211,238,0.38)] focus:outline-none focus:ring-2 focus:ring-cyan-100/80 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-[12rem]"
            >
              <FiMonitor
                aria-hidden="true"
                className="h-6 w-6 transition-transform group-hover:scale-110"
              />
              <span>
                <span className="block text-sm font-bold tracking-wide">
                  {t("workbench.display")}
                </span>
                <span className="mt-0.5 block text-[10px] font-medium text-slate-800/70">
                  {displayOpening
                    ? t("workbench.loadingReplay")
                    : currentEpisodeIsReplaySource || replayDataset
                      ? t("workbench.fullscreenReplay")
                      : t("workbench.fullscreenOperations")}
                </span>
              </span>
            </button>
          )}
          {displayReplayError && (
            <p
              className="max-w-[18rem] text-right text-[10px] leading-4 text-amber-300"
              role="status"
            >
              {t("workbench.replayLoadError")}
            </p>
          )}
        </div>

        <WorkbenchSharedSync
          organization={organization}
          onSynced={() => setLocalRefreshToken((value) => value + 1)}
        />

        <section
          aria-labelledby="workbench-controls-title"
          className="rounded-xl border border-white/10 bg-[var(--surface-1)]/45 p-4 shadow-[0_12px_30px_rgba(8,15,30,0.14)] sm:p-5"
        >
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                {t("workbench.controlCenter")}
              </div>
              <h4
                id="workbench-controls-title"
                className="mt-1 text-sm font-semibold text-slate-200"
              >
                {t("workbench.dashboardControls")}
              </h4>
              <p className="mt-1 text-[11px] text-slate-500">
                {t("workbench.controlHint")}
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] tabular-nums text-slate-500">
              {t("workbench.reportingDays", {
                count: availableDays.length.toLocaleString(),
              })}
            </span>
            <span className="rounded-full border border-cyan-400/15 bg-cyan-400/[0.04] px-2.5 py-1 text-[10px] tabular-nums text-cyan-200/75">
              {t("workbench.dataUpdatedThrough", {
                date: formatDataUpdatedAt(dataUpdatedAt),
              })}
            </span>
          </div>

          <div className="grid gap-3 lg:grid-cols-[0.8fr_1.25fr_1.25fr]">
            <div className="flex min-w-0 flex-col gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
              <span>{t("workbench.sources")}</span>
              <div
                className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/10 bg-[var(--surface-0)]/70 px-3 py-2 normal-case tracking-normal"
                role="group"
                aria-label={t("workbench.dataSourcesAria")}
              >
                {sourceOptions.map((item) => (
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
              <span>{t("workbench.startDate")}</span>
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
              <span>{t("workbench.endDate")}</span>
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
              {t("workbench.quickRange")}
            </span>
            {DATE_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.value}
                type="button"
                onClick={() => applyDateShortcut(shortcut.value)}
                className="rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
              >
                {t(shortcut.key)}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              {t("workbench.actions")}
            </span>
            <button
              type="button"
              onClick={resetDateRange}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiRotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              {t("workbench.resetRange")}
            </button>
            <button
              type="button"
              onClick={() => setLocalRefreshToken((value) => value + 1)}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FiRefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              {t("workbench.reloadLocalData")}
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
              {t("workbench.workstationMappings")}
            </button>
            <button
              type="button"
              onClick={() => setPersonnelEditorOpen((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiUsers aria-hidden="true" className="h-3.5 w-3.5" />
              {t("workbench.personnelMapping")}
            </button>
            <button
              type="button"
              onClick={() => setRewardEditorOpen((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/[0.06] hover:text-cyan-100"
            >
              <FiAward aria-hidden="true" className="h-3.5 w-3.5" />
              {t("workbench.rewardRules")}
            </button>
            {isWorkbenchOrganizationDisplayPath(pathname) && (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-violet-300/25 bg-violet-300/[0.06] px-3 py-2 text-xs font-medium text-violet-200">
                <input
                  type="checkbox"
                  checked={replayEnabled}
                  onChange={(event) => setReplayEnabled(event.target.checked)}
                  className="accent-violet-300"
                />
                {t("workbench.includeReplay")}
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
          aria-label={t("workbench.datasetsAwaitingDate")}
          className="rounded-md border border-sky-400/20 bg-sky-400/[0.05] px-3 py-2.5 text-xs text-sky-100"
        >
          <span className="font-medium text-sky-200">
            {t("workbench.datePending")}
          </span>
          <span className="ml-2 text-sky-100/75">
            {t("workbench.datePendingDetail", {
              count: undatedDatasetCount.toLocaleString(),
            })}
          </span>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-sky-200/90">
              {t("workbench.viewPendingPaths")}
            </summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded border border-sky-300/10 bg-black/10 p-2 font-mono text-[11px] text-sky-100/75">
              {undatedDatasetPaths.map((datasetPath) => (
                <li key={datasetPath}>{datasetPath}</li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {!loading && hubScope.refreshedAt === null && hubScope.hubTotal === 0 && (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-200">
          {t("workbench.hubCatalogEmpty")}{" "}
          {t("workbench.refreshStatisticsFirst")}
        </div>
      )}
      {!loading && hubScope.hubTotal > 0 && (
        <div className="rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] p-3 text-xs text-cyan-100/80">
          {t("workbench.hubScope", {
            category: hubScope.categoryTotal.toLocaleString(),
            total: hubScope.hubTotal.toLocaleString(),
            dated: hubScope.categoryCounts["taccap-g1"].toLocaleString(),
            xtac: hubScope.categoryCounts["xtac-umi-g1"].toLocaleString(),
            merged:
              hubScope.categoryCounts["taccap-g1-merged"].toLocaleString(),
            folder: hubScope.categoryCounts.folder.toLocaleString(),
            other: hubScope.categoryCounts.other.toLocaleString(),
            matched: hubScope.localMatchedTotal.toLocaleString(),
            without: Math.max(
              0,
              hubScope.categoryTotal - hubScope.localMatchedTotal,
            ).toLocaleString(),
          })}
        </div>
      )}
      <WorkbenchStatisticsFilterNotice filter={statisticsFilter} />

      {error && (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-4 text-xs text-slate-500">
          {t("workbench.loadingDashboard")}
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
                  {t("workbench.liveSnapshot")}
                </div>
                <h4
                  id="workbench-overview-title"
                  className="mt-1 text-sm font-semibold text-slate-200"
                >
                  {t("workbench.operationsOverview")}
                </h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  {t("workbench.overviewHint")}
                </p>
              </div>
              <span className="rounded-full border border-cyan-400/15 bg-cyan-400/[0.05] px-2.5 py-1 text-[10px] text-cyan-200/75">
                {range.startDate && range.endDate
                  ? range.startDate + " → " + range.endDate
                  : t("workbench.autoRange")}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[
                [
                  t("workbench.organizationTotalHours"),
                  organizationTotalHours.toLocaleString("en-US", {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  }) + " h",
                ],
                [
                  t("workbench.selectedRangeHours"),
                  formatHours(totalHours) + " h",
                ],
                [t("common.episodes"), formatCount(totalEpisodes)],
                [t("common.tasks"), formatCount(selectedDatasetPaths.length)],
                [t("common.storage"), formatBytes(selectedStorageBytes)],
                [
                  t("workbench.dailyTargetHours"),
                  formatHours(rewardDraft.dailyTargetHours) + " h/day",
                ],
                [
                  t("workbench.totalBonus"),
                  formatWorkbenchRewardAmount(projectedRewardAmount),
                ],
                [t("workbench.sourcesCount"), formatCount(robotIds)],
                [
                  t("workbench.daysInRange"),
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
                  {t("workbench.workstationDetail")}
                </h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  {t("workbench.workstationDetailHint")}
                </p>
              </div>
              <span className="text-[10px] text-slate-500">
                {workstationDashboardRows.length === 0
                  ? t("workbench.noGroupedRows")
                  : `${workstationDashboardRows.length} ${t("workbench.workstation")}`}
              </span>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-md border border-white/10 bg-black/10 px-2.5 py-1.5 text-[11px] text-slate-500">
                <span className="shrink-0">{t("workbench.filter")}</span>
                <input
                  value={workstationQuery}
                  onChange={(event) => setWorkstationQuery(event.target.value)}
                  placeholder={t("workbench.rowFilterPlaceholder")}
                  className="min-w-0 flex-1 bg-transparent text-slate-200 outline-none placeholder:text-slate-600"
                  aria-label={t("workbench.filterWorkstationRows")}
                />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-slate-500">
                {t("workbench.sort")}
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
                  aria-label={t("workbench.sortWorkstationRows")}
                >
                  <option value="reward">{t("workbench.reward")}</option>
                  <option value="hours">{t("common.hours")}</option>
                  <option value="datasets">{t("workbench.datasets")}</option>
                  <option value="robot">{t("workbench.workstation")}</option>
                </select>
              </label>
              <button
                type="button"
                onClick={exportWorkbenchCsv}
                className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.06] px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/[0.12]"
              >
                {t("workbench.exportCsv")}
              </button>
              <button
                type="button"
                onClick={() => void copyWorkbenchShareLink()}
                className="rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
              >
                {t("workbench.copyShareLink")}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                <thead className="bg-[var(--surface-2)] text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.workstation")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.personnel")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.sourceRepos")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.datasets")}
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title={t("workbench.workstationHours")}
                    >
                      {t("workbench.workstationHours")}
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title={t("workbench.perPersonTargetHours")}
                    >
                      {t("workbench.perPersonTargetHours")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.rate")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.rule")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.avgPerEpisode")}
                    </th>
                    <th className="px-3 py-2.5 font-medium">
                      {t("workbench.reward")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRobotDashboardRows.map((row) => (
                    <tr
                      key={`${row.workstation}-${row.group}`}
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
                          title: `${row.workstation} ${t("workbench.workstationDetail")}`,
                          detail: `${row.workstation} · ${formatHours(row.hours)} ${t("common.hours")} · ${formatCount(row.count)} ${t("workbench.datasets")}`,
                          datasets: datasetsForWorkstation(row.workstation),
                          episodeId: 0,
                        });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openWorkbenchDrilldown({
                            title: `${row.workstation} ${t("workbench.workstationDetail")}`,
                            detail: `${row.workstation} · ${formatHours(row.hours)} ${t("common.hours")} · ${formatCount(row.count)} ${t("workbench.datasets")}`,
                            datasets: datasetsForWorkstation(row.workstation),
                            episodeId: 0,
                          });
                        }
                      }}
                    >
                      <td
                        className="cursor-help px-3 py-2.5 text-slate-100"
                        title={`${t("workbench.workstation")}: ${row.workstation}`}
                      >
                        {row.workstation}
                      </td>
                      <td
                        className="px-3 py-2.5 text-slate-300"
                        title={
                          personnelByWorkstation
                            .get(row.workstation)
                            ?.join(", ") ||
                          t("workbench.noPersonnelMappingShort")
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
                        {formatWorkbenchAverageEpisode(row.reward)}
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
                {t("workbench.noWorkstationFilterMatch")}
              </p>
            )}
          </section>

          <WorkbenchPersonnelWorkload rollup={personnelRollup} />

          <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                {t("workbench.workstationDayHeatmap")}
              </h4>
              <span className="text-[10px] text-slate-500">
                {heatmapDays.length === 0
                  ? t("workbench.noDataSince", { date: "2026-08-22" })
                  : "2026-08-22 → " +
                    (workstationHeatmapRange.endDate ?? t("workbench.latest")) +
                    " · " +
                    heatmapDays.length +
                    ` ${t("workbench.latestDataDays")}`}
              </span>
            </div>
            {heatmapDays.length === 0 ? (
              <div className="rounded-md border border-white/10 bg-white/[0.02] p-4 text-xs text-slate-500">
                {t("workbench.noWorkstationDayDataFrom", {
                  date: "2026-08-22",
                  end: heatmapEndDateLabel,
                })}
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
                    {t("workbench.workstation")}
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
                                    const mappedWorkstation =
                                      getWorkbenchDatasetWorkstation(
                                        dataset,
                                        [
                                          workstationDraft,
                                          workstationMappings,
                                          workstationDefaults,
                                        ],
                                        [
                                          workstationLegacyDraft,
                                          workstationLegacyMappings,
                                          workstationLegacyDefaults,
                                        ],
                                      ) ?? "未分配";
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
                {t("workbench.dailyTrend")}
              </h4>
              <span className="text-[10px] text-slate-500">
                {dailyTrendTimeline.range.startDate ?? t("workbench.beginning")}{" "}
                → {dailyTrendTimeline.range.endDate ?? t("workbench.latest")}
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
                          key={`daily-trend-${props.payload.date}`}
                          cx={props.cx}
                          cy={props.cy}
                          r={4}
                          fill="#38bdf8"
                          stroke="#e0f2fe"
                          strokeWidth={1}
                          role="button"
                          tabIndex={0}
                          aria-label={t("workbench.openDailyTrend", {
                            date: props.payload.date,
                          })}
                          onClick={() => {
                            const day = props.payload?.date;
                            if (!day) return;
                            openWorkbenchDrilldown({
                              title: `${t("workbench.dailyTrend")} · ${day}`,
                              detail: `${formatHours(props.payload?.hours ?? 0)} ${t("common.hours")}`,
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
                  {t("workbench.topGroups")}
                </h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  {t("workbench.workstation")} ·{" "}
                  {range.startDate ?? t("workbench.beginning")} →{" "}
                  {range.endDate ?? t("workbench.latest")}
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
                    {t("workbench.drilldown")}
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
                    {t("workbench.createReviewTask")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrilldown(null)}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-white/25 hover:text-white"
                  >
                    {t("workbench.close")}
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
                      {t("workbench.openEpisode", {
                        episode: drilldown.episodeId ?? 0,
                      })}
                      {drilldown.frame === undefined
                        ? ""
                        : ` · ${t("workbench.frame", {
                            frame: drilldown.frame,
                          })}`}
                    </span>
                  </a>
                ))}
              </div>
              {drilldown.datasets.length === 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  {t("workbench.noDatasetAdditions")}
                </p>
              )}
            </section>
          )}

          {mappingEditorOpen && (
            <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    {t("workbench.workstationMappings")}
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {t("workbench.mappingEditorHint")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={restoreDefaultMappings}
                    disabled={mappingsSaving}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    {t("workbench.importDefaults")}
                  </button>
                  <button
                    type="button"
                    onClick={restoreMappings}
                    disabled={mappingsSaving || !workstationDraftDirty}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    {t("workbench.reset")}
                  </button>
                  <button
                    type="button"
                    onClick={saveWorkstationMappings}
                    disabled={mappingsSaving || !workstationDraftDirty}
                    className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:opacity-50"
                  >
                    {mappingsSaving
                      ? t("workbench.saving")
                      : t("workbench.save")}
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
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.deviceId")}
                      </th>
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.workstation")}
                      </th>
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.source")}
                      </th>
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
                                workstationDefaults[row.robotId] ??
                                ""
                              }
                              onChange={(event) =>
                                setWorkstationDraft((current) => ({
                                  ...current,
                                  [row.robotId as string]: event.target.value,
                                }))
                              }
                              placeholder={t(
                                "workbench.workstationPlaceholder",
                              )}
                              className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          ) : (
                            <span className="text-slate-500">
                              {t("workbench.legacyOnly")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-slate-300">
                          {row.robotId
                            ? row.collectorSerialNumber
                              ? t("workbench.collectorSn")
                              : t("workbench.robotIdSource")
                            : row.leftGripperSn
                              ? t("workbench.leftSn")
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
                  {t("workbench.legacyMappingWarning")}
                </div>
              )}
            </section>
          )}

          {rewardEditorOpen && (
            <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    {t("workbench.rewardRules")}
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {t("workbench.rewardRulesHint")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{t("workbench.dailyTargetLabel")}</span>
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
                    <span>{t("workbench.enabled")}</span>
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
                    {t("workbench.restoreDefaults")}
                  </button>
                  <button
                    type="button"
                    onClick={addRewardLevel}
                    disabled={rewardSaving}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
                  >
                    {t("workbench.addLevel")}
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
                    {rewardSaving ? t("workbench.saving") : t("workbench.save")}
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
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.label")}
                      </th>
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.minPercent")}
                      </th>
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.maxPercent")}
                      </th>
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.amount")}
                      </th>
                      <th className="px-3 py-2.5 font-medium">
                        {t("workbench.actions")}
                      </th>
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
                              placeholder={t("workbench.openEnded")}
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
                              {t("workbench.remove")}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-4">
                <h5 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {t("workbench.episodeDurationMultiplier")}
                </h5>
                <div className="overflow-x-auto rounded-md border border-white/10">
                  <table className="w-full min-w-[650px] border-collapse text-left text-xs">
                    <thead className="bg-[var(--surface-2)] text-slate-400">
                      <tr>
                        <th className="px-3 py-2.5 font-medium">
                          {t("workbench.label")}
                        </th>
                        <th className="px-3 py-2.5 font-medium">
                          {t("workbench.minSeconds")}
                        </th>
                        <th className="px-3 py-2.5 font-medium">
                          {t("workbench.maxSeconds")}
                        </th>
                        <th className="px-3 py-2.5 font-medium">
                          {t("workbench.multiplier")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rewardDraft.episodeDurationLevels.map((level, index) => (
                        <tr key={level.id} className="border-t border-white/5">
                          <td className="px-3 py-2.5">
                            <input
                              value={level.label}
                              onChange={(event) =>
                                updateEpisodeDurationLevel(index, {
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
                              value={level.minSeconds}
                              onChange={(event) =>
                                updateEpisodeDurationLevel(index, {
                                  minSeconds: parseNonNegativeNumber(
                                    event.target.value,
                                  ),
                                })
                              }
                              className="w-28 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={level.maxSeconds ?? ""}
                              placeholder={t("workbench.openEnded")}
                              onChange={(event) =>
                                updateEpisodeDurationLevel(index, {
                                  maxSeconds:
                                    event.target.value === ""
                                      ? null
                                      : parseNonNegativeNumber(
                                          event.target.value,
                                        ),
                                })
                              }
                              className="w-28 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="number"
                              min="0.01"
                              step="0.05"
                              value={level.multiplier}
                              onChange={(event) =>
                                updateEpisodeDurationLevel(index, {
                                  multiplier: Number(event.target.value),
                                })
                              }
                              className="w-28 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-right tabular-nums text-slate-100 focus:border-cyan-400 focus:outline-none"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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

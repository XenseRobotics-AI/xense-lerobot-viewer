import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { getDatasetPrefix } from "@/utils/datasetGrouping";
import { WORKBENCH_UPLOADER_NAMES } from "@/utils/workbenchUploaderNames";
import { isWorkbenchStatisticsExcludedDataset } from "@/utils/workbenchStatisticsFilter";

export type WorkbenchRollupDimension =
  | "uploader"
  | "task"
  | "robot_type"
  | "robot_id"
  | "left_gripper_sn"
  | "source";

export type WorkbenchRollupDataset = Pick<
  LocalDatasetSummary,
  | "relativePath"
  | "total_episodes"
  | "total_frames"
  | "fps"
  | "robot_type"
  | "sizeBytes"
> & {
  robotId?: string | null;
  leftGripperSn?: string | null;
  uploader?: string | null;
  uploaderName?: string | null;
  uploaderDisplayName?: string | null;
  lastModified?: string | null;
  durationHours?: number | null;
  dailyAdditions?: WorkbenchDailyAddition[];
};

export type WorkbenchRollupRow = {
  group: string;
  count: number;
  episodes: number;
  frames: number;
  hours: number;
  pctHours: number;
};

export type WorkbenchRollupDateRange = {
  startDate: string | null;
  endDate: string | null;
};

export type WorkbenchDateTimeRange = {
  startDateTime: string;
  endDateTime: string;
};

export type WorkbenchRollupDailyRow = {
  day: string;
  datasets: number;
  episodes: number;
  frames: number;
  hours: number;
  cumulativeDatasets: number;
  cumulativeEpisodes: number;
  cumulativeFrames: number;
  cumulativeHours: number;
};

export type WorkbenchRollupTimeline = {
  range: WorkbenchRollupDateRange;
  rows: WorkbenchRollupDailyRow[];
  total: {
    datasets: number;
    episodes: number;
    frames: number;
    hours: number;
  };
};

export type WorkbenchDailyAddition = {
  day: string;
  episodes: number;
  frames: number;
  hours: number;
};

export const WORKBENCH_LEFT_SN_DAILY_TARGET_HOURS = 6;
export const WORKBENCH_LEFT_SN_REWARD_AMOUNT = 20;
export const WORKBENCH_LEFT_SN_REWARD_LABEL = "🪙";
export const WORKBENCH_IGNORED_ROBOT_IDS = new Set(["bi_taccap_0"]);

export type WorkbenchOkrSymbol = "✅" | "❌" | "…" | "—";

function parseDayKey(value: string): number | null {
  const [year, month, day] = value.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day);
}

function dayKeyFromUtc(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function suffixYear(lastModified: string | null | undefined): number {
  const parsed = Date.parse(lastModified ?? "");
  if (Number.isFinite(parsed)) return new Date(parsed).getUTCFullYear();
  return new Date().getUTCFullYear();
}

function nextDayKey(value: string): string {
  const parsed = parseDayKey(value);
  return parsed === null ? value : dayKeyFromUtc(parsed + 86_400_000);
}

export function countHalfOpenDays(
  range: WorkbenchRollupDateRange,
): number | null {
  if (!range.startDate || !range.endDate) return null;
  const start = parseDayKey(range.startDate);
  const end = parseDayKey(range.endDate);
  if (start === null || end === null) return null;
  const [left, right] = start <= end ? [start, end] : [end, start];
  return Math.floor((right - left) / 86_400_000);
}

export function getWorkbenchLeftSnTargetHours(
  range: WorkbenchRollupDateRange,
  dailyTargetHours = WORKBENCH_LEFT_SN_DAILY_TARGET_HOURS,
): number | null {
  const days = countHalfOpenDays(range);
  if (
    days === null ||
    !Number.isFinite(dailyTargetHours) ||
    dailyTargetHours <= 0
  ) {
    return null;
  }
  return days * dailyTargetHours;
}

export function getWorkbenchOkrSymbol(
  hours: number,
  targetHours: number,
): WorkbenchOkrSymbol {
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    targetHours <= 0
  ) {
    return "—";
  }
  if (hours >= targetHours) return "✅";
  if (hours + 1e-9 >= targetHours * 0.9) return "…";
  return "❌";
}

export function getWorkbenchOkrRewardAmount(
  hours: number,
  targetHours: number,
  rewardAmount: number,
): number {
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    !Number.isFinite(rewardAmount) ||
    rewardAmount <= 0
  ) {
    return 0;
  }
  return hours >= targetHours ? rewardAmount : 0;
}

export function getWorkbenchOkrAchievementRate(
  hours: number,
  targetHours: number,
): number | null {
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    targetHours <= 0
  ) {
    return null;
  }
  return (hours / targetHours) * 100;
}

export function formatWorkbenchRewardCoins(value: number): string {
  const coins = Math.trunc(value / 10);
  if (!Number.isFinite(coins) || coins <= 0) {
    return "—";
  }
  return WORKBENCH_LEFT_SN_REWARD_LABEL.repeat(coins);
}

export function getWorkbenchRobotIdWorkstation(
  robotId: string,
  mappings: Record<string, string> = {},
): string {
  return mappings[robotId] ?? "—";
}

export function getWorkbenchLeftSnWorkstation(
  leftSn: string,
  mappings: Record<string, string> = {},
): string {
  return getWorkbenchRobotIdWorkstation(leftSn, mappings);
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function roundHours(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function datasetHours(dataset: WorkbenchRollupDataset): number {
  const override = dataset.durationHours;
  if (
    typeof override === "number" &&
    Number.isFinite(override) &&
    override >= 0
  ) {
    return override;
  }
  const frames = Number(dataset.total_frames);
  const fps = Number(dataset.fps);
  if (
    Number.isFinite(frames) &&
    frames > 0 &&
    Number.isFinite(fps) &&
    fps > 0
  ) {
    return frames / fps / 3600;
  }
  return 0;
}

function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

export function workbenchDayKey(lastModified?: string | null): string | null {
  const value = lastModified?.trim();
  if (!value) return null;
  if (isDayKey(value)) return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return dayKeyFromUtc(parsed);
}

export function getWorkbenchDefaultDateRange(
  now: Date = new Date(),
): WorkbenchRollupDateRange {
  const endDate = dayKeyFromUtc(now.getTime());
  const start = new Date(now);
  start.setTime(start.getTime() - 86_400_000);
  return { startDate: dayKeyFromUtc(start.getTime()), endDate };
}

/** Workbench task grouping: leaf repo name with a trailing MMDD removed. */
export function workbenchTaskPrefix(relativePath: string): string {
  const leaf = relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
  return leaf.replace(/-\d{4}$/u, "") || leaf || "—";
}

export function workbenchDatasetName(relativePath: string): string {
  return relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
}

export function isWorkbenchIgnoredRobotId(
  robotId: string | null | undefined,
): boolean {
  const value = robotId?.trim();
  return Boolean(value && WORKBENCH_IGNORED_ROBOT_IDS.has(value));
}

export function workbenchDatasetSuffixDay(
  relativePath: string,
  lastModified?: string | null,
): string | null {
  const leaf = workbenchDatasetName(relativePath);
  const match = /-(\d{2})(\d{2})$/u.exec(leaf);
  if (!match) return null;
  const year = suffixYear(lastModified);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate.toISOString().slice(0, 10);
}

export function hasWorkbenchDatasetDateSuffix(
  relativePath: string,
  lastModified?: string | null,
): boolean {
  return workbenchDatasetSuffixDay(relativePath, lastModified) !== null;
}

function padWorkbenchDateTime(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatWorkbenchDateTimeLocal(value: Date): string {
  return (
    [
      value.getFullYear(),
      padWorkbenchDateTime(value.getMonth() + 1),
      padWorkbenchDateTime(value.getDate()),
    ].join("-") +
    "T" +
    padWorkbenchDateTime(value.getHours()) +
    ":" +
    padWorkbenchDateTime(value.getMinutes())
  );
}

export function getWorkbenchDefaultDateTimeRange(
  now: Date = new Date(),
): WorkbenchDateTimeRange {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  return {
    startDateTime: formatWorkbenchDateTimeLocal(start),
    endDateTime: formatWorkbenchDateTimeLocal(end),
  };
}

export function workbenchRollupLabel(
  dataset: WorkbenchRollupDataset,
  dimension: WorkbenchRollupDimension,
): string {
  if (dimension === "uploader") {
    return (
      dataset.uploaderDisplayName ||
      dataset.uploaderName ||
      (dataset.uploader ? WORKBENCH_UPLOADER_NAMES[dataset.uploader] : null) ||
      dataset.uploader ||
      "未知"
    );
  }
  if (dimension === "task") return workbenchTaskPrefix(dataset.relativePath);
  if (dimension === "robot_type") return dataset.robot_type || "—";
  if (dimension === "robot_id") return dataset.robotId || "—";
  if (dimension === "left_gripper_sn") return dataset.leftGripperSn || "—";
  return getDatasetPrefix(dataset.relativePath);
}

export function workbenchGroupDatasetNames(
  datasets: readonly WorkbenchRollupDataset[],
  dimension: WorkbenchRollupDimension,
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): Map<string, string[]> {
  const availableDays = datasets
    .filter(
      (dataset) => !isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
    )
    .map((dataset) => workbenchDayKey(dataset.lastModified))
    .filter((value): value is string => Boolean(value));
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const groups = new Map<string, Set<string>>();

  for (const dataset of filterWorkbenchDatasetsByDate(datasets, range)) {
    const group = workbenchRollupLabel(dataset, dimension);
    const names = groups.get(group) ?? new Set<string>();
    names.add(workbenchDatasetName(dataset.relativePath));
    groups.set(group, names);
  }

  return new Map(
    Array.from(groups.entries()).map(([group, names]) => [
      group,
      Array.from(names).sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

/** Convert a local bucketed path to its canonical organization/name repo id. */
function workbenchSourceRepoId(relativePath: string): string {
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  if (segments.length < 2) return relativePath;
  return `${segments[0]}/${segments[segments.length - 1]}`;
}

export function workbenchGroupSourceRepoIds(
  datasets: readonly WorkbenchRollupDataset[],
  dimension: WorkbenchRollupDimension,
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): Map<string, string[]> {
  const availableDays = workbenchAdditionAvailableDays(datasets);
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const groups = new Map<string, Set<string>>();

  for (const dataset of datasets) {
    if (isWorkbenchStatisticsExcludedDataset(dataset.relativePath)) continue;
    if (additionsInRange(dataset, range).length === 0) continue;
    if (
      !hasWorkbenchDatasetDateSuffix(dataset.relativePath, dataset.lastModified)
    ) {
      continue;
    }
    const group = workbenchRollupLabel(dataset, dimension);
    const repos = groups.get(group) ?? new Set<string>();
    repos.add(workbenchSourceRepoId(dataset.relativePath));
    groups.set(group, repos);
  }

  return new Map(
    Array.from(groups.entries()).map(([group, repos]) => [
      group,
      Array.from(repos).sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

function additionDays(
  dataset: WorkbenchRollupDataset,
): WorkbenchDailyAddition[] {
  return (dataset.dailyAdditions ?? []).filter((addition) => {
    if (!isDayKey(addition.day)) return false;
    return (
      nonNegativeCount(Number(addition.episodes)) > 0 ||
      nonNegativeCount(Number(addition.frames)) > 0 ||
      datasetAdditionHours(addition) > 0
    );
  });
}

function datasetAdditionHours(addition: WorkbenchDailyAddition): number {
  const hours = Number(addition.hours);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

export function workbenchAdditionAvailableDays(
  datasets: readonly WorkbenchRollupDataset[],
): string[] {
  return datasets
    .filter(
      (dataset) => !isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
    )
    .flatMap((dataset) => additionDays(dataset).map((addition) => addition.day))
    .sort();
}

function additionsInRange(
  dataset: WorkbenchRollupDataset,
  range: WorkbenchRollupDateRange,
): WorkbenchDailyAddition[] {
  return additionDays(dataset).filter((addition) => {
    if (range.startDate && addition.day < range.startDate) return false;
    if (range.endDate && addition.day >= range.endDate) return false;
    return true;
  });
}

/** Unique dataset directories with strict additions in a half-open range. */
export function workbenchAdditionDatasetPaths(
  datasets: readonly WorkbenchRollupDataset[],
  options: { startDate?: string | null; endDate?: string | null } = {},
): string[] {
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    workbenchAdditionAvailableDays(datasets),
  );
  const paths = new Set<string>();
  for (const dataset of datasets) {
    if (isWorkbenchStatisticsExcludedDataset(dataset.relativePath)) continue;
    if (additionsInRange(dataset, range).length > 0)
      paths.add(dataset.relativePath);
  }
  return Array.from(paths).sort((left, right) => left.localeCompare(right));
}

export function workbenchGroupAdditionDatasetNames(
  datasets: readonly WorkbenchRollupDataset[],
  dimension: WorkbenchRollupDimension,
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): Map<string, string[]> {
  const availableDays = workbenchAdditionAvailableDays(datasets);
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const groups = new Map<string, Set<string>>();

  for (const dataset of datasets) {
    if (isWorkbenchStatisticsExcludedDataset(dataset.relativePath)) continue;
    if (additionsInRange(dataset, range).length === 0) continue;
    const group = workbenchRollupLabel(dataset, dimension);
    const names = groups.get(group) ?? new Set<string>();
    names.add(workbenchDatasetName(dataset.relativePath));
    groups.set(group, names);
  }

  return new Map(
    Array.from(groups.entries()).map(([group, names]) => [
      group,
      Array.from(names).sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

export function normalizeWorkbenchDateRange(
  startDate?: string | null,
  endDate?: string | null,
  availableDays: readonly string[] = [],
): WorkbenchRollupDateRange {
  const sortedDays = [...new Set(availableDays.filter(isDayKey))].sort();
  const firstDay = sortedDays[0] ?? null;
  const lastDay = sortedDays.at(-1) ?? null;
  const endAfterLastDay = lastDay ? nextDayKey(lastDay) : null;
  const normalize = (value?: string | null): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return isDayKey(trimmed) ? trimmed : null;
  };
  let start = normalize(startDate) ?? firstDay;
  let end = normalize(endDate) ?? endAfterLastDay;
  if (start && end && start > end) {
    [start, end] = [end, start];
  }
  return { startDate: start, endDate: end };
}

export function filterWorkbenchDatasetsByDate(
  datasets: readonly WorkbenchRollupDataset[],
  range: WorkbenchRollupDateRange,
): WorkbenchRollupDataset[] {
  const included = datasets.filter(
    (dataset) => !isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
  );
  const hasKnownDay = included.some((dataset) =>
    workbenchDayKey(dataset.lastModified),
  );
  if (!range.startDate && !range.endDate) return included;
  if (!hasKnownDay) return included;
  return included.filter((dataset) => {
    const day = workbenchDayKey(dataset.lastModified);
    if (!day) return false;
    if (range.startDate && day < range.startDate) return false;
    if (range.endDate && day >= range.endDate) return false;
    return true;
  });
}

/**
 * Port of tacverse-workbench's rollup(): count and sum datasets, then sort by
 * recorded hours. The input is intentionally the local discovery summary so
 * grouping never changes the Viewer browse or episode-loading path.
 */
export function computeWorkbenchRollup(
  datasets: readonly WorkbenchRollupDataset[],
  dimension: WorkbenchRollupDimension,
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): WorkbenchRollupRow[] {
  const availableDays = datasets
    .filter(
      (dataset) => !isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
    )
    .map((dataset) => workbenchDayKey(dataset.lastModified))
    .filter((value): value is string => Boolean(value));
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const filtered = filterWorkbenchDatasetsByDate(datasets, range);
  const groups = new Map<string, Omit<WorkbenchRollupRow, "pctHours">>();

  for (const dataset of filtered) {
    const group = workbenchRollupLabel(dataset, dimension);
    const current = groups.get(group) ?? {
      group,
      count: 0,
      episodes: 0,
      frames: 0,
      hours: 0,
    };
    current.count += 1;
    current.episodes += nonNegativeCount(Number(dataset.total_episodes));
    current.frames += nonNegativeCount(Number(dataset.total_frames));
    current.hours += datasetHours(dataset);
    groups.set(group, current);
  }

  const rows = Array.from(groups.values());
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);
  return rows
    .map((row) => ({
      ...row,
      hours: roundHours(row.hours),
      pctHours:
        totalHours > 0 ? Math.round((row.hours / totalHours) * 1000) / 10 : 0,
    }))
    .sort(
      (a, b) =>
        b.hours - a.hours ||
        b.episodes - a.episodes ||
        a.group.localeCompare(b.group),
    );
}

export function computeWorkbenchAdditionRollup(
  datasets: readonly WorkbenchRollupDataset[],
  dimension: WorkbenchRollupDimension,
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): WorkbenchRollupRow[] {
  const availableDays = workbenchAdditionAvailableDays(datasets);
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const groups = new Map<
    string,
    Omit<WorkbenchRollupRow, "count" | "pctHours"> & { names: Set<string> }
  >();

  for (const dataset of datasets) {
    if (isWorkbenchStatisticsExcludedDataset(dataset.relativePath)) continue;
    const additions = additionsInRange(dataset, range);
    if (additions.length === 0) continue;
    const group = workbenchRollupLabel(dataset, dimension);
    const current = groups.get(group) ?? {
      group,
      names: new Set<string>(),
      episodes: 0,
      frames: 0,
      hours: 0,
    };
    current.names.add(workbenchDatasetName(dataset.relativePath));
    for (const addition of additions) {
      current.episodes += nonNegativeCount(Number(addition.episodes));
      current.frames += nonNegativeCount(Number(addition.frames));
      current.hours += datasetAdditionHours(addition);
    }
    groups.set(group, current);
  }

  const rows = Array.from(groups.values());
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);
  return rows
    .map((row) => ({
      group: row.group,
      count: row.names.size,
      episodes: row.episodes,
      frames: row.frames,
      hours: roundHours(row.hours),
      pctHours:
        totalHours > 0 ? Math.round((row.hours / totalHours) * 1000) / 10 : 0,
    }))
    .sort(
      (a, b) =>
        b.hours - a.hours ||
        b.episodes - a.episodes ||
        a.group.localeCompare(b.group),
    );
}

export function computeWorkbenchTimeline(
  datasets: readonly WorkbenchRollupDataset[],
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): WorkbenchRollupTimeline {
  const availableDays = datasets
    .filter(
      (dataset) => !isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
    )
    .map((dataset) => workbenchDayKey(dataset.lastModified))
    .filter((value): value is string => Boolean(value));
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const filtered = filterWorkbenchDatasetsByDate(datasets, range);
  const byDay = new Map<
    string,
    {
      datasets: number;
      episodes: number;
      frames: number;
      hours: number;
    }
  >();

  for (const dataset of filtered) {
    const day = workbenchDayKey(dataset.lastModified);
    if (!day) continue;
    const current = byDay.get(day) ?? {
      datasets: 0,
      episodes: 0,
      frames: 0,
      hours: 0,
    };
    current.datasets += 1;
    current.episodes += nonNegativeCount(Number(dataset.total_episodes));
    current.frames += nonNegativeCount(Number(dataset.total_frames));
    current.hours += datasetHours(dataset);
    byDay.set(day, current);
  }

  let cumulativeDatasets = 0;
  let cumulativeEpisodes = 0;
  let cumulativeFrames = 0;
  let cumulativeHours = 0;
  const rows = Array.from(byDay.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, current]) => {
      cumulativeDatasets += current.datasets;
      cumulativeEpisodes += current.episodes;
      cumulativeFrames += current.frames;
      cumulativeHours += current.hours;
      return {
        day,
        datasets: current.datasets,
        episodes: current.episodes,
        frames: current.frames,
        hours: roundHours(current.hours),
        cumulativeDatasets,
        cumulativeEpisodes,
        cumulativeFrames,
        cumulativeHours: roundHours(cumulativeHours),
      };
    });

  return {
    range,
    rows,
    total: {
      datasets: filtered.length,
      episodes: filtered.reduce(
        (sum, dataset) =>
          sum + nonNegativeCount(Number(dataset.total_episodes)),
        0,
      ),
      frames: filtered.reduce(
        (sum, dataset) => sum + nonNegativeCount(Number(dataset.total_frames)),
        0,
      ),
      hours: roundHours(
        filtered.reduce((sum, dataset) => {
          return sum + datasetHours(dataset);
        }, 0),
      ),
    },
  };
}

export function computeWorkbenchAdditionTimeline(
  datasets: readonly WorkbenchRollupDataset[],
  options: {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): WorkbenchRollupTimeline {
  const availableDays = workbenchAdditionAvailableDays(datasets);
  const range = normalizeWorkbenchDateRange(
    options.startDate,
    options.endDate,
    availableDays,
  );
  const byDay = new Map<
    string,
    {
      names: Set<string>;
      episodes: number;
      frames: number;
      hours: number;
    }
  >();
  const totalNames = new Set<string>();

  for (const dataset of datasets) {
    if (isWorkbenchStatisticsExcludedDataset(dataset.relativePath)) continue;
    const name = workbenchDatasetName(dataset.relativePath);
    for (const addition of additionsInRange(dataset, range)) {
      const current = byDay.get(addition.day) ?? {
        names: new Set<string>(),
        episodes: 0,
        frames: 0,
        hours: 0,
      };
      current.names.add(name);
      totalNames.add(name);
      current.episodes += nonNegativeCount(Number(addition.episodes));
      current.frames += nonNegativeCount(Number(addition.frames));
      current.hours += datasetAdditionHours(addition);
      byDay.set(addition.day, current);
    }
  }

  let cumulativeDatasets = 0;
  let cumulativeEpisodes = 0;
  let cumulativeFrames = 0;
  let cumulativeHours = 0;
  const rows = Array.from(byDay.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, current]) => {
      cumulativeDatasets += current.names.size;
      cumulativeEpisodes += current.episodes;
      cumulativeFrames += current.frames;
      cumulativeHours += current.hours;
      return {
        day,
        datasets: current.names.size,
        episodes: current.episodes,
        frames: current.frames,
        hours: roundHours(current.hours),
        cumulativeDatasets,
        cumulativeEpisodes,
        cumulativeFrames,
        cumulativeHours: roundHours(cumulativeHours),
      };
    });

  return {
    range,
    rows,
    total: {
      datasets: totalNames.size,
      episodes: rows.reduce((sum, row) => sum + row.episodes, 0),
      frames: rows.reduce((sum, row) => sum + row.frames, 0),
      hours: roundHours(rows.reduce((sum, row) => sum + row.hours, 0)),
    },
  };
}

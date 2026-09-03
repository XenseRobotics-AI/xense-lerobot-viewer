import type { VideoInfo } from "@/types";
import { getLinkedHubDatasetRepoId } from "@/utils/datasetRoute";
import { extractTacCapGripperTracks } from "@/utils/taccapGripperReplay";
import { groupUrdfReplayVideos } from "@/utils/urdfReplayVideos";
import type { WorkbenchRewardPreview } from "@/utils/workbenchRewards";

export type WorkbenchDisplaySlideId =
  | "overview"
  | "workstation-detail"
  | "personnel-workload"
  | "workstation-heatmap"
  | "daily-trend"
  | "top-groups"
  | "3d-replay";

export type WorkbenchDisplaySlideConfig = Readonly<{
  id: WorkbenchDisplaySlideId;
  title: string;
  durationMs: number;
}>;

export const WORKBENCH_DISPLAY_SLIDES: readonly WorkbenchDisplaySlideConfig[] =
  Object.freeze([
    Object.freeze({
      id: "overview" as const,
      title: "Overview",
      durationMs: 10_000,
    }),
    Object.freeze({
      id: "workstation-detail" as const,
      title: "Workstation detail",
      durationMs: 15_000,
    }),
    Object.freeze({
      id: "personnel-workload" as const,
      title: "Personnel workload",
      durationMs: 15_000,
    }),
    Object.freeze({
      id: "workstation-heatmap" as const,
      title: "Workstation day heatmap",
      durationMs: 12_000,
    }),
    Object.freeze({
      id: "daily-trend" as const,
      title: "Daily trend",
      durationMs: 11_000,
    }),
    Object.freeze({
      id: "top-groups" as const,
      title: "Top groups",
      durationMs: 11_000,
    }),
  ]);

export const WORKBENCH_DISPLAY_REPLAY_SLIDE: WorkbenchDisplaySlideConfig =
  Object.freeze({
    id: "3d-replay" as const,
    title: "3D Replay",
    durationMs: 15_000,
  });

const WORKBENCH_DISPLAY_SLIDES_WITH_REPLAY: readonly WorkbenchDisplaySlideConfig[] =
  Object.freeze([...WORKBENCH_DISPLAY_SLIDES, WORKBENCH_DISPLAY_REPLAY_SLIDE]);

export function getWorkbenchDisplaySlides(
  hasReplay: boolean,
): readonly WorkbenchDisplaySlideConfig[] {
  return hasReplay
    ? WORKBENCH_DISPLAY_SLIDES_WITH_REPLAY
    : WORKBENCH_DISPLAY_SLIDES;
}

export const WORKBENCH_DISPLAY_TOTAL_DURATION_MS =
  WORKBENCH_DISPLAY_SLIDES.reduce(
    (total, slide) => total + slide.durationMs,
    0,
  );

export const WORKBENCH_DISPLAY_REPLAY_TOTAL_DURATION_MS =
  WORKBENCH_DISPLAY_SLIDES_WITH_REPLAY.reduce(
    (total, slide) => total + slide.durationMs,
    0,
  );
export const WORKBENCH_DISPLAY_DETAIL_PAGE_SIZE = 10;
export const WORKBENCH_DISPLAY_DETAIL_PAGE_DURATION_MS = 5_000;
export const WORKBENCH_DISPLAY_PERSONNEL_PAGE_SIZE = 10;
export const WORKBENCH_DISPLAY_PERSONNEL_PAGE_DURATION_MS = 5_000;
export const WORKBENCH_DISPLAY_HEATMAP_DAY_WINDOW = 14;
export const WORKBENCH_DISPLAY_HEATMAP_WINDOW_DURATION_MS = 4_000;
export const WORKBENCH_DISPLAY_HEATMAP_ROW_LIMIT = 10;
export const WORKBENCH_DISPLAY_TOP_GROUP_LIMIT = 8;

export type WorkbenchDisplayWorkstationRow = Readonly<{
  robotId: string;
  workstation: string;
  datasets: number;
  hours: number;
  targetHours: number | null;
  ratePercent: number | null;
  reward: number;
  rule?: string | null;
  ruleSymbol?: WorkbenchRewardPreview["symbol"];
}>;

export type WorkbenchDisplayHeatmapRow = Readonly<{
  robotId: string;
  workstation: string;
  totalHours: number;
  hoursByDay: Readonly<Record<string, number>>;
}>;

export type WorkbenchDisplayTrendRow = Readonly<{
  day: string;
  hours: number;
  datasets: number;
}>;

export type WorkbenchDisplayTopGroup = Readonly<{
  group: string;
  hours: number;
  datasets: number;
}>;

export type WorkbenchDisplayPersonnelRow = Readonly<{
  personnel: string;
  workstation: string;
  hours: number;
  targetHours: number;
  ratePercent: number | null;
  rule: string;
  ruleSymbol?: WorkbenchRewardPreview["symbol"];
  reward: number;
  email: string;
}>;

export const TACCAP_WORKBENCH_REPLAY_DATASET =
  "TacVerse/taccap-g1-operate-shoe-box-0812";

export const TACCAP_WORKBENCH_REPLAY_DURATION_SECONDS = 15;

export type WorkbenchDisplayReplaySource = Readonly<{
  datasetName: string;
  episodeId: number;
  chartRows: readonly Record<string, number>[];
  videosInfo: readonly VideoInfo[];
  episodeDurationSeconds: number;
  fps: number;
}>;

export type WorkbenchDisplayReplaySnapshot = Readonly<{
  datasetName: string;
  episodeId: number;
  chartRows: readonly Record<string, number>[];
  videosInfo: readonly VideoInfo[];
  episodeDurationSeconds: number;
  fps: number;
  randomStartSeconds: number;
  windowDurationSeconds: number;
  recognizedVideoCount: number;
  missingVideoStreams: readonly string[];
  missingTrajectories: readonly string[];
}>;

export function isTacCapWorkbenchReplaySource(
  datasetName: string,
  episodeId: number,
): boolean {
  if (episodeId !== 0) return false;
  const normalizedName = datasetName.trim();
  return (
    normalizedName === TACCAP_WORKBENCH_REPLAY_DATASET ||
    getLinkedHubDatasetRepoId(normalizedName) ===
      TACCAP_WORKBENCH_REPLAY_DATASET
  );
}

export function createWorkbenchDisplayReplaySnapshot(
  source: WorkbenchDisplayReplaySource,
  randomValue = Math.random(),
): WorkbenchDisplayReplaySnapshot | null {
  if (!isTacCapWorkbenchReplaySource(source.datasetName, source.episodeId)) {
    return null;
  }

  const episodeDurationSeconds = Math.max(
    0,
    finiteOrZero(source.episodeDurationSeconds),
  );
  const maxStartSeconds = Math.max(
    0,
    episodeDurationSeconds - TACCAP_WORKBENCH_REPLAY_DURATION_SECONDS,
  );
  const normalizedRandom = Math.max(0, Math.min(1, finiteOrZero(randomValue)));
  const randomStartSeconds =
    maxStartSeconds * 0.25 + maxStartSeconds * 0.5 * normalizedRandom;
  const windowDurationSeconds = Math.max(
    0,
    Math.min(
      TACCAP_WORKBENCH_REPLAY_DURATION_SECONDS,
      episodeDurationSeconds - randomStartSeconds,
    ),
  );
  const chartRows = Array.from(source.chartRows);
  const videosInfo = Array.from(source.videosInfo);
  const videoGroups = groupUrdfReplayVideos(videosInfo);
  const recognizedVideos = [
    ...videoGroups.left,
    ...videoGroups.right,
    ...videoGroups.center,
  ];
  const missingVideoStreams = (["left", "right"] as const).filter(
    (side) => videoGroups[side].length < 3,
  );
  const tracks = extractTacCapGripperTracks(chartRows);
  const missingTrajectories = (["left", "right"] as const).filter(
    (side) => !tracks.some((track) => track.side === side),
  );

  return freezeReplaySnapshot({
    datasetName: source.datasetName,
    episodeId: source.episodeId,
    chartRows,
    videosInfo,
    episodeDurationSeconds,
    fps: Math.max(0, finiteOrZero(source.fps)),
    randomStartSeconds,
    windowDurationSeconds,
    recognizedVideoCount: recognizedVideos.length,
    missingVideoStreams,
    missingTrajectories,
  });
}

function freezeReplaySnapshot(
  replay: WorkbenchDisplayReplaySnapshot,
): WorkbenchDisplayReplaySnapshot {
  return Object.freeze({
    ...replay,
    chartRows: freezeArray(
      replay.chartRows.map((row) => Object.freeze({ ...row })),
    ),
    videosInfo: freezeArray(
      replay.videosInfo.map((video) => Object.freeze({ ...video })),
    ),
    missingVideoStreams: freezeArray([...replay.missingVideoStreams]),
    missingTrajectories: freezeArray([...replay.missingTrajectories]),
  });
}

export type WorkbenchDisplaySnapshot = Readonly<{
  organization: string;
  capturedAt: string;
  dateRange: Readonly<{
    startDate: string | null;
    endDate: string | null;
  }>;
  dailyTargetHours: number;
  summary: Readonly<{
    organizationTotalHours: number;
    selectedRangeHours: number;
    episodes: number;
    tasks: number;
    storageBytes: number;
    dailyTargetHours: number;
    totalBonus: number;
    robotIds: number;
    daysInRange: number | null;
  }>;
  workstations: readonly WorkbenchDisplayWorkstationRow[];
  personnelRows: readonly WorkbenchDisplayPersonnelRow[];
  personnelBonusTotal: number;
  unattributedHours: number;
  heatmapDays: readonly string[];
  heatmapRows: readonly WorkbenchDisplayHeatmapRow[];
  trend: readonly WorkbenchDisplayTrendRow[];
  topGroups: readonly WorkbenchDisplayTopGroup[];
  replay?: WorkbenchDisplayReplaySnapshot;
}>;

export type WorkbenchDisplaySnapshotInput = {
  organization: string;
  dateRange: { startDate: string | null; endDate: string | null };
  capturedAt?: string;
  dailyTargetHours?: number;
  summary: {
    organizationTotalHours?: number;
    selectedRangeHours?: number;
    episodes?: number;
    tasks?: number;
    storageBytes?: number;
    dailyTargetHours?: number;
    totalBonus?: number;
    robotIds?: number;
    daysInRange?: number | null;
    totalHours?: number;
    targetHours?: number | null;
    projectedReward?: number;
  };
  workstations: readonly WorkbenchDisplayWorkstationRow[];
  personnelRows?: readonly WorkbenchDisplayPersonnelRow[];
  personnelBonusTotal?: number;
  unattributedHours?: number;
  heatmapDays: readonly string[];
  heatmapRows: readonly WorkbenchDisplayHeatmapRow[];
  trend: readonly WorkbenchDisplayTrendRow[];
  topGroups: readonly WorkbenchDisplayTopGroup[];
  replay?: WorkbenchDisplayReplaySnapshot;
};

export type WorkbenchDisplayPage<T> = Readonly<{
  items: readonly T[];
  pageIndex: number;
  pageCount: number;
}>;

export type WorkbenchDisplayClock = Readonly<{
  remainingMs: number;
  startedAtMs: number | null;
}>;

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function freezeArray<T>(items: T[]): readonly T[] {
  return Object.freeze(items);
}

export function getWorkbenchDisplaySlideIndex(
  currentIndex: number,
  offset: number,
  slides: readonly WorkbenchDisplaySlideConfig[] = WORKBENCH_DISPLAY_SLIDES,
): number {
  return positiveModulo(
    Math.trunc(currentIndex) + Math.trunc(offset),
    slides.length,
  );
}

export function getWorkbenchDisplaySlideAtElapsed(
  elapsedMs: number,
  slides: readonly WorkbenchDisplaySlideConfig[] = WORKBENCH_DISPLAY_SLIDES,
): Readonly<{
  slideIndex: number;
  slideElapsedMs: number;
}> {
  const totalDuration = slides.reduce(
    (total, slide) => total + slide.durationMs,
    0,
  );
  let remaining = positiveModulo(
    Math.max(0, finiteOrZero(elapsedMs)),
    totalDuration,
  );
  for (let index = 0; index < slides.length; index += 1) {
    const duration = slides[index].durationMs;
    if (remaining < duration) {
      return Object.freeze({ slideIndex: index, slideElapsedMs: remaining });
    }
    remaining -= duration;
  }
  return Object.freeze({ slideIndex: 0, slideElapsedMs: 0 });
}

export function getWorkbenchDisplayPage<T>(
  items: readonly T[],
  pageCursor: number,
  pageSize: number,
): WorkbenchDisplayPage<T> {
  const size = Math.max(1, Math.trunc(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const pageIndex = items.length
    ? positiveModulo(Math.trunc(pageCursor), pageCount)
    : 0;
  const start = pageIndex * size;
  return Object.freeze({
    items: freezeArray(items.slice(start, start + size)),
    pageIndex,
    pageCount,
  });
}

export function getWorkbenchDetailPage<T>(
  rows: readonly T[],
  pageCursor: number,
): WorkbenchDisplayPage<T> {
  return getWorkbenchDisplayPage(
    rows,
    pageCursor,
    WORKBENCH_DISPLAY_DETAIL_PAGE_SIZE,
  );
}

export function getWorkbenchPersonnelPage<T>(
  rows: readonly T[],
  pageCursor: number,
): WorkbenchDisplayPage<T> {
  return getWorkbenchDisplayPage(
    rows,
    pageCursor,
    WORKBENCH_DISPLAY_PERSONNEL_PAGE_SIZE,
  );
}

export function getWorkbenchHeatmapWindow(
  days: readonly string[],
  windowCursor: number,
): WorkbenchDisplayPage<string> {
  return getWorkbenchDisplayPage(
    days,
    windowCursor,
    WORKBENCH_DISPLAY_HEATMAP_DAY_WINDOW,
  );
}

export function getWorkbenchTopGroups<T extends { hours: number }>(
  groups: readonly T[],
): readonly T[] {
  return freezeArray(
    groups
      .map((group) => ({ ...group }))
      .sort((left, right) => right.hours - left.hours)
      .slice(0, WORKBENCH_DISPLAY_TOP_GROUP_LIMIT) as T[],
  );
}

export function createWorkbenchDisplayClock(
  durationMs: number,
  nowMs: number,
): WorkbenchDisplayClock {
  return Object.freeze({
    remainingMs: Math.max(0, finiteOrZero(durationMs)),
    startedAtMs: finiteOrZero(nowMs),
  });
}

export function getWorkbenchDisplayClockRemaining(
  clock: WorkbenchDisplayClock,
  nowMs: number,
): number {
  if (clock.startedAtMs === null) return clock.remainingMs;
  return Math.max(
    0,
    clock.remainingMs - Math.max(0, finiteOrZero(nowMs) - clock.startedAtMs),
  );
}

export function pauseWorkbenchDisplayClock(
  clock: WorkbenchDisplayClock,
  nowMs: number,
): WorkbenchDisplayClock {
  return Object.freeze({
    remainingMs: getWorkbenchDisplayClockRemaining(clock, nowMs),
    startedAtMs: null,
  });
}

export function resumeWorkbenchDisplayClock(
  clock: WorkbenchDisplayClock,
  nowMs: number,
): WorkbenchDisplayClock {
  if (clock.startedAtMs !== null) return clock;
  return Object.freeze({
    remainingMs: clock.remainingMs,
    startedAtMs: finiteOrZero(nowMs),
  });
}

export function createWorkbenchDisplaySnapshot(
  input: WorkbenchDisplaySnapshotInput,
): WorkbenchDisplaySnapshot {
  const selectedRangeHours = finiteOrZero(
    input.summary.selectedRangeHours ?? input.summary.totalHours ?? 0,
  );
  const dailyTargetHours = finiteOrZero(
    input.summary.dailyTargetHours ?? input.dailyTargetHours ?? 0,
  );
  const personnelRows = freezeArray(
    (input.personnelRows ?? []).map((row) => Object.freeze({ ...row })),
  );
  const workstations = freezeArray(
    input.workstations.map((row) => Object.freeze({ ...row })),
  );
  const heatmapDays = freezeArray([...input.heatmapDays].sort());
  const heatmapRows = freezeArray(
    input.heatmapRows
      .map((row) =>
        Object.freeze({
          ...row,
          hoursByDay: Object.freeze({ ...row.hoursByDay }),
        }),
      )
      .sort(
        (left, right) =>
          right.totalHours - left.totalHours ||
          left.robotId.localeCompare(right.robotId),
      )
      .slice(0, WORKBENCH_DISPLAY_HEATMAP_ROW_LIMIT),
  );
  const trend = freezeArray(
    input.trend
      .map((row) => Object.freeze({ ...row }))
      .sort((left, right) => left.day.localeCompare(right.day)),
  );
  const topGroups = getWorkbenchTopGroups(input.topGroups).map((group) =>
    Object.freeze({ ...group }),
  );

  return Object.freeze({
    organization: input.organization,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    dateRange: Object.freeze({ ...input.dateRange }),
    dailyTargetHours,
    summary: Object.freeze({
      organizationTotalHours: finiteOrZero(
        input.summary.organizationTotalHours ?? 0,
      ),
      selectedRangeHours,
      episodes: finiteOrZero(input.summary.episodes ?? 0),
      tasks: finiteOrZero(input.summary.tasks ?? 0),
      storageBytes: finiteOrZero(input.summary.storageBytes ?? 0),
      dailyTargetHours,
      totalBonus: finiteOrZero(
        input.summary.totalBonus ?? input.summary.projectedReward ?? 0,
      ),
      robotIds: finiteOrZero(input.summary.robotIds ?? 0),
      daysInRange:
        input.summary.daysInRange === null
          ? null
          : finiteOrZero(input.summary.daysInRange ?? 0),
    }),
    workstations,
    personnelRows,
    personnelBonusTotal: finiteOrZero(input.personnelBonusTotal ?? 0),
    unattributedHours: finiteOrZero(input.unattributedHours ?? 0),
    heatmapDays,
    heatmapRows,
    trend,
    topGroups: freezeArray(topGroups),
    replay: input.replay ? freezeReplaySnapshot(input.replay) : undefined,
  });
}

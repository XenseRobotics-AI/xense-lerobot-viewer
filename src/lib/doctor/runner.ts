import path from "node:path";
import {
  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS,
  DEFAULT_DOCTOR_SPEED_THRESHOLDS,
  DOCTOR_CHECK_IDS,
  type DoctorCheckId,
  type DoctorCheckResult,
  type DoctorDimensionJumpThresholds,
  type DoctorEpisodeRange,
  type DoctorProgress,
  type DoctorReport,
  type DoctorRunResponse,
  type DoctorSeverity,
  type DoctorSpeedThresholds,
} from "@/types/doctor.types";
import { loadDoctorDataset } from "./loader";
import { throwIfDoctorAborted, type LoadedDoctorDataset } from "./model";
import { checkAnomalies, checkPerEpisode } from "./checks/anomalies";
import { checkDimensionJumps } from "./checks/jumps";
import { checkSpeedLimits } from "./checks/speeds";
import {
  checkActions,
  checkConsistency,
  checkEpisodes,
  checkMetadata,
  checkStatistics,
  checkTemporal,
  checkTraining,
} from "./checks/core";
import { checkPortability, checkVideos } from "./checks/files";

export const TYPESCRIPT_DOCTOR_VERSION = "1.1.0-ts";

export interface RunDoctorOptions {
  maxEpisodes: number | null;
  episodeRange?: DoctorEpisodeRange | null;
  dimensionJumpThresholds?: DoctorDimensionJumpThresholds;
  speedThresholds?: DoctorSpeedThresholds;
  checks?: DoctorCheckId[] | null;
  signal?: AbortSignal;
  onProgress?: (progress: DoctorProgress) => void;
}

const CHECKS: Record<
  DoctorCheckId,
  (
    dataset: LoadedDoctorDataset,
  ) => DoctorCheckResult | Promise<DoctorCheckResult>
> = {
  metadata: checkMetadata,
  temporal: checkTemporal,
  actions: checkActions,
  dimension_jumps: checkDimensionJumps,
  speed_limits: checkSpeedLimits,
  videos: checkVideos,
  statistics: checkStatistics,
  episodes: checkEpisodes,
  consistency: checkConsistency,
  training: checkTraining,
  anomalies: checkAnomalies,
  portability: checkPortability,
  per_episode: checkPerEpisode,
};

const CHECK_NAMES: Record<DoctorCheckId, string> = {
  metadata: "Metadata & Format Compliance",
  temporal: "Temporal Consistency",
  actions: "Action Quality",
  dimension_jumps: "Dimension-Level Jump Detection",
  speed_limits: "TCP Speed Limit Detection",
  videos: "Video Integrity",
  statistics: "Data Distribution",
  episodes: "Episode Health",
  consistency: "Feature Consistency",
  training: "Training Readiness",
  anomalies: "Anomaly Detection",
  portability: "Portability",
  per_episode: "Per-Episode Summary",
};

function reportProgress(
  options: RunDoctorOptions,
  progress: Omit<DoctorProgress, "percent" | "overall_percent">,
): void {
  const percent =
    progress.total === 0
      ? 0
      : Math.round((progress.completed / progress.total) * 100);
  const overallPercent =
    progress.phase === "loading"
      ? Math.round(percent * 0.4)
      : progress.phase === "complete"
        ? 100
        : Math.round(40 + percent * 0.6);
  options.onProgress?.({
    ...progress,
    percent,
    overall_percent: overallPercent,
  });
}

function worstSeverity(checks: DoctorCheckResult[]): DoctorSeverity {
  if (checks.some((check) => check.severity === "FAIL")) return "FAIL";
  if (checks.some((check) => check.severity === "WARN")) return "WARN";
  return "PASS";
}

function countSeverity(
  checks: DoctorCheckResult[],
): Record<DoctorSeverity, number> {
  const counts: Record<DoctorSeverity, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of checks) counts[check.severity] += 1;
  return counts;
}

export async function runTypeScriptDoctor(
  datasetRoot: string,
  options: RunDoctorOptions,
): Promise<DoctorRunResponse> {
  throwIfDoctorAborted(options.signal);
  const startedAt = performance.now();
  reportProgress(options, {
    phase: "loading",
    completed: 0,
    total: 1,
    message: "Loading episode metadata and parquet data…",
  });
  const dataset = await loadDoctorDataset(datasetRoot, {
    maxEpisodes: options.maxEpisodes,
    episodeRange: options.episodeRange,
    signal: options.signal,
    onProgress: ({ fraction, message }) =>
      reportProgress(options, {
        phase: "loading",
        completed: Math.round(fraction * 100),
        total: 100,
        message,
      }),
  });
  throwIfDoctorAborted(options.signal);
  const selected = options.checks?.length
    ? options.checks
    : [...DOCTOR_CHECK_IDS];
  const dimensionJumpThresholds =
    options.dimensionJumpThresholds ?? DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS;
  const speedThresholds =
    options.speedThresholds ?? DEFAULT_DOCTOR_SPEED_THRESHOLDS;
  reportProgress(options, {
    phase: "checks",
    completed: 0,
    total: selected.length,
    message: `Loaded ${dataset.episodesData.length.toLocaleString()} episodes. Starting diagnostic checks…`,
  });
  const checks: DoctorCheckResult[] = [];
  for (const [index, checkId] of selected.entries()) {
    throwIfDoctorAborted(options.signal);
    reportProgress(options, {
      phase: "checks",
      completed: index,
      total: selected.length,
      check_id: checkId,
      check_name: CHECK_NAMES[checkId],
      message: `Running ${CHECK_NAMES[checkId]} (${index + 1}/${selected.length})…`,
    });
    checks.push(
      await (checkId === "dimension_jumps"
        ? checkDimensionJumps(dataset, dimensionJumpThresholds)
        : checkId === "speed_limits"
          ? checkSpeedLimits(dataset, speedThresholds)
          : CHECKS[checkId](dataset)),
    );
    reportProgress(options, {
      phase: "checks",
      completed: index + 1,
      total: selected.length,
      check_id: checkId,
      check_name: CHECK_NAMES[checkId],
      message: `Completed ${CHECK_NAMES[checkId]} (${index + 1}/${selected.length})`,
    });
    // Let request cancellation and the route timeout run between CPU-bound checks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throwIfDoctorAborted(options.signal);
  const info = dataset.info;
  const report: DoctorReport = {
    version: TYPESCRIPT_DOCTOR_VERSION,
    dataset_path: dataset.displayPath,
    dataset_name: path.basename(datasetRoot) || null,
    codebase_version: info?.codebaseVersion ?? null,
    format_version: info?.formatVersion ?? null,
    total_episodes: info?.totalEpisodes ?? null,
    total_frames: info?.totalFrames ?? null,
    fps: info?.fps ?? null,
    overall_severity: worstSeverity(checks),
    checks,
    summary: countSeverity(checks),
  };
  const response: DoctorRunResponse = {
    ok: true,
    report,
    execution: {
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      requested_max_episodes: options.maxEpisodes,
      requested_episode_range: options.episodeRange ?? null,
      dimension_jump_thresholds: { ...dimensionJumpThresholds },
      speed_thresholds: { ...speedThresholds },
      loaded_episode_count: dataset.episodesData.length,
      loaded_episode_indices: dataset.episodesData.map(
        (episode) => episode.episodeIndex,
      ),
      engine: "typescript",
      cache_hit: false,
    },
  };
  reportProgress(options, {
    phase: "complete",
    completed: 1,
    total: 1,
    message: "Diagnosis complete",
  });
  return response;
}

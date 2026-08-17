import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { datasetHours } from "@/utils/corpusStats";
import {
  DEFAULT_DATASET_QUALITY_CONFIG,
  runDatasetChecks,
  type DatasetQualityAggregateStatus,
  type DatasetQualityCheckResult,
} from "@/utils/datasetQualityChecks";

export type HomepageDatasetStatisticsRow = {
  encodedPath: string;
  name: string;
  robotType: string | null;
  localStatus: LocalDatasetSummary["integrity"]["status"];
  episodes: number;
  frames: number;
  hours: number;
  averageEpisodeSeconds: number | null;
  checks: DatasetQualityCheckResult[];
  checkStatus: DatasetQualityAggregateStatus;
  failedChecks: number;
  warningChecks: number;
  skippedChecks: number;
  passedChecks: number;
  hasIssue: boolean;
};

export type HomepageDatasetStatistics = {
  datasets: number;
  episodes: number;
  frames: number;
  hours: number;
  healthy: number;
  issues: number;
  rows: HomepageDatasetStatisticsRow[];
};

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build the Workbench-style homepage summary from the discovery result.
 *
 * The homepage deliberately does not decode every tasks.parquet file during a
 * scan. Prompt quality therefore reports SKIP here, while name and duration
 * checks still run with the same shared rules used by the per-dataset
 * Workbench tab. A skipped check is visible but is not counted as an issue.
 */
export function buildHomepageDatasetStatistics(
  datasets: readonly LocalDatasetSummary[],
): HomepageDatasetStatistics {
  const rows = datasets.map((dataset): HomepageDatasetStatisticsRow => {
    const episodes = nonNegativeFinite(dataset.total_episodes);
    const frames = nonNegativeFinite(dataset.total_frames);
    const hours = datasetHours(dataset);
    const quality = runDatasetChecks(
      {
        dataset_name: dataset.relativePath,
        total_episodes: episodes,
        duration_hours: hours,
        tasks: null,
      },
      DEFAULT_DATASET_QUALITY_CONFIG,
    );
    const skippedChecks = quality.results.filter(
      (check) => check.status === "skip",
    ).length;
    const passedChecks = quality.results.filter(
      (check) => check.status === "ok",
    ).length;
    const hasIssue =
      dataset.integrity.status !== "ok" || quality.aggregate.worst !== "ok";

    return {
      encodedPath: dataset.encodedPath,
      name: dataset.relativePath,
      robotType: dataset.robot_type,
      localStatus: dataset.integrity.status,
      episodes,
      frames,
      hours,
      averageEpisodeSeconds:
        episodes > 0 && hours > 0 ? (hours * 3600) / episodes : null,
      checks: quality.results,
      checkStatus: quality.aggregate.worst,
      failedChecks: quality.aggregate.n_fail,
      warningChecks: quality.aggregate.n_warn,
      skippedChecks,
      passedChecks,
      hasIssue,
    };
  });

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const healthy = rows.filter((row) => !row.hasIssue).length;
  return {
    datasets: rows.length,
    episodes: rows.reduce((sum, row) => sum + row.episodes, 0),
    frames: rows.reduce((sum, row) => sum + row.frames, 0),
    hours: rows.reduce((sum, row) => sum + row.hours, 0),
    healthy,
    issues: rows.length - healthy,
    rows,
  };
}

export function filterHomepageDatasetStatisticsRows(
  rows: readonly HomepageDatasetStatisticsRow[],
  query: string,
  issuesOnly: boolean,
): HomepageDatasetStatisticsRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (issuesOnly && !row.hasIssue) return false;
    if (!needle) return true;
    return (
      row.name.toLocaleLowerCase().includes(needle) ||
      (row.robotType ?? "").toLocaleLowerCase().includes(needle)
    );
  });
}

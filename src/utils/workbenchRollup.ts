import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { getDatasetPrefix } from "@/utils/datasetGrouping";
import { WORKBENCH_UPLOADER_NAMES } from "@/utils/workbenchUploaderNames";

export type WorkbenchRollupDimension =
  | "uploader"
  | "task"
  | "robot_type"
  | "source";

export type WorkbenchRollupDataset = Pick<
  LocalDatasetSummary,
  "relativePath" | "total_episodes" | "total_frames" | "fps" | "robot_type"
> & {
  uploader?: string | null;
  uploaderName?: string | null;
};

export type WorkbenchRollupRow = {
  group: string;
  count: number;
  episodes: number;
  frames: number;
  hours: number;
  pctHours: number;
};

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Workbench task grouping: leaf repo name with a trailing MMDD removed. */
export function workbenchTaskPrefix(relativePath: string): string {
  const leaf = relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
  return leaf.replace(/-\d{4}$/u, "") || leaf || "—";
}

export function workbenchRollupLabel(
  dataset: WorkbenchRollupDataset,
  dimension: WorkbenchRollupDimension,
): string {
  if (dimension === "uploader") {
    return (
      dataset.uploaderName ||
      (dataset.uploader ? WORKBENCH_UPLOADER_NAMES[dataset.uploader] : null) ||
      dataset.uploader ||
      "未知"
    );
  }
  if (dimension === "task") return workbenchTaskPrefix(dataset.relativePath);
  if (dimension === "robot_type") return dataset.robot_type || "—";
  return getDatasetPrefix(dataset.relativePath);
}

/**
 * Port of tacverse-workbench's rollup(): count and sum datasets, then sort by
 * recorded hours. The input is intentionally the local discovery summary so
 * grouping never changes the Viewer browse or episode-loading path.
 */
export function computeWorkbenchRollup(
  datasets: readonly WorkbenchRollupDataset[],
  dimension: WorkbenchRollupDimension,
): WorkbenchRollupRow[] {
  const groups = new Map<string, Omit<WorkbenchRollupRow, "pctHours">>();

  for (const dataset of datasets) {
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
    const frames = Number(dataset.total_frames);
    const fps = Number(dataset.fps);
    if (
      Number.isFinite(frames) &&
      frames > 0 &&
      Number.isFinite(fps) &&
      fps > 0
    ) {
      current.hours += frames / fps / 3600;
    }
    groups.set(group, current);
  }

  const rows = Array.from(groups.values());
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);
  return rows
    .map((row) => ({
      ...row,
      hours: Math.round(row.hours * 1000) / 1000,
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

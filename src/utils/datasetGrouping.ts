import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";

/**
 * Group datasets on the homepage by the first segment of their relative path
 * (the "org"/prefix, e.g. `Xense` in `Xense/pack_6_cosmetic_bottles_into_carton`).
 * Datasets are discovered from disk as `<prefix>/<task_name>[/...]`; the prefix
 * becomes a top-level browsing category and the remainder is the task name.
 */

/** Bucket for datasets whose relative path has no `/` (directly under root). */
export const UNGROUPED_PREFIX = "Ungrouped";

/** First path segment of a dataset relative path, or `UNGROUPED_PREFIX`. */
export function getDatasetPrefix(relativePath: string): string {
  const idx = relativePath.indexOf("/");
  if (idx === -1) return UNGROUPED_PREFIX;
  return relativePath.slice(0, idx);
}

/**
 * Everything after the first path segment — the human-facing task name.
 * `Xense/pack` → `pack`, `Xense/a/b` → `a/b`, single-segment → the path itself.
 */
export function getDatasetTaskName(relativePath: string): string {
  const idx = relativePath.indexOf("/");
  if (idx === -1) return relativePath;
  return relativePath.slice(idx + 1);
}

export type DatasetGroup = {
  prefix: string;
  datasets: LocalDatasetSummary[];
  counts: { ok: number; empty: number; incomplete: number };
  totalEpisodes: number;
  totalFrames: number;
  /** Summed bytes on disk — the primary key for category-card ordering. */
  totalBytes: number;
  /** First non-null thumbnail among the group's datasets, used as the card art. */
  thumbnailVideoUrl: string | null;
  /**
   * Distinct `robot_type` values in the group, most-used first.
   *
   * Summarised here rather than in the card so the landing page can name the
   * rig without opening the category: a source directory is an owner, not a
   * robot, and one source can hold several (TacVerse carries both TacCap and
   * RDT captures). Datasets with no declared robot type are simply absent —
   * an empty array means "nothing declared", never "one unknown robot".
   */
  robotTypes: string[];
};

/**
 * Card ordering: biggest first, so the top-left of every grid is the most
 * substantial dataset.
 *
 * **Bytes on disk lead.** "How big is this dataset" is a storage question
 * first, and `sizeBytes` answers it directly rather than by proxy — a
 * high-resolution multi-camera recording and a single low-res one can report
 * the same frame count while differing tenfold on disk.
 *
 * Frames rank next, for the reason the tape is proportioned by hours: an
 * episode is an arbitrary slice and sources differ by an order of magnitude in
 * episode length, so episode count alone would rank a pile of short
 * calibration clips above a long teleoperation corpus. That tier still matters
 * — `sizeBytes` is 0 for a dataset whose directory could not be walked, and
 * those must not all collapse to the bottom in path order. Episode count
 * breaks frame ties, and the path breaks the rest so the order is stable
 * across renders.
 */
export function compareDatasetsBySize(
  a: LocalDatasetSummary,
  b: LocalDatasetSummary,
): number {
  return (
    (b.sizeBytes || 0) - (a.sizeBytes || 0) ||
    (b.total_frames || 0) - (a.total_frames || 0) ||
    (b.total_episodes || 0) - (a.total_episodes || 0) ||
    a.relativePath.localeCompare(b.relativePath)
  );
}

/**
 * Distinct robot types across a set of datasets, ordered by how many datasets
 * declare each — so a category card leads with the rig that actually
 * characterises the source, and a handful of stragglers do not outrank it.
 * Ties break on name so the order is stable across renders.
 */
export function rankRobotTypes(datasets: LocalDatasetSummary[]): string[] {
  const counts = new Map<string, number>();
  for (const ds of datasets) {
    const robot = ds.robot_type?.trim();
    if (!robot) continue;
    counts.set(robot, (counts.get(robot) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([robot]) => robot);
}

/**
 * Bucket datasets by prefix, aggregating per-group health counts and episode
 * totals, and picking the first available thumbnail as the category art.
 *
 * Both levels are ordered largest-first: each group's datasets by
 * `compareDatasetsBySize`, and the groups themselves on the same keys summed
 * (bytes, then frames, then episodes) — which also means the category art comes
 * from the group's biggest dataset that has a thumbnail.
 */
export function groupDatasetsByPrefix(
  datasets: LocalDatasetSummary[],
): DatasetGroup[] {
  const groups = new Map<string, DatasetGroup>();

  for (const ds of datasets) {
    const prefix = getDatasetPrefix(ds.relativePath);
    let group = groups.get(prefix);
    if (!group) {
      group = {
        prefix,
        datasets: [],
        counts: { ok: 0, empty: 0, incomplete: 0 },
        totalEpisodes: 0,
        totalFrames: 0,
        totalBytes: 0,
        thumbnailVideoUrl: null,
        robotTypes: [],
      };
      groups.set(prefix, group);
    }

    group.datasets.push(ds);
    group.totalEpisodes += ds.total_episodes || 0;
    group.totalFrames += ds.total_frames || 0;
    group.totalBytes += ds.sizeBytes || 0;
    if (ds.integrity.status === "ok") group.counts.ok += 1;
    else if (ds.integrity.status === "empty") group.counts.empty += 1;
    else group.counts.incomplete += 1;
  }

  const ordered = Array.from(groups.values());
  for (const group of ordered) {
    group.datasets.sort(compareDatasetsBySize);
    group.thumbnailVideoUrl =
      group.datasets.find((ds) => ds.thumbnailVideoUrl)?.thumbnailVideoUrl ??
      null;
    group.robotTypes = rankRobotTypes(group.datasets);
  }

  return ordered.sort(
    (a, b) =>
      b.totalBytes - a.totalBytes ||
      b.totalFrames - a.totalFrames ||
      b.totalEpisodes - a.totalEpisodes ||
      a.prefix.localeCompare(b.prefix),
  );
}

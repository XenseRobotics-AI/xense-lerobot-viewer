/**
 * Aggregate statistics for the whole local corpus, used by the homepage tape.
 *
 * The headline unit is **recorded hours**, not episode count: an episode is an
 * arbitrary slice, so 1,468 short calibration episodes and 2,596 long
 * teleoperation episodes are not comparable quantities. Hours are, which is why
 * the tape is proportioned by duration and labels episodes separately — the gap
 * between the two is the interesting part.
 */

import type { DatasetGroup } from "@/utils/datasetGrouping";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";

export type CorpusSegment = {
  prefix: string;
  tasks: number;
  hours: number;
  episodes: number;
  frames: number;
  /** Bytes on disk across the source's datasets. */
  bytes: number;
  /** Fraction of the corpus's total hours, 0–1. Zero when the corpus is empty. */
  share: number;
  /**
   * Mean episode duration in seconds, or null when the source has no episodes.
   * This is the quality signal the bar itself cannot show — two sources with
   * similar episode counts can differ by an order of magnitude here, which is
   * usually the difference between real teleoperation and calibration clips.
   */
  avgEpisodeSeconds: number | null;
  /**
   * Distinct `robot_type` values recorded under this source, most-used first.
   * Carried through from the group because the source panel is the only place
   * left that describes a source as a whole.
   */
  robotTypes: string[];
};

export type CorpusStats = {
  totalHours: number;
  totalEpisodes: number;
  totalFrames: number;
  totalTasks: number;
  /** Bytes on disk across the whole corpus. */
  totalBytes: number;
  /** Segments sorted by hours, descending. Zero-hour groups are kept — a group
   *  that scanned but has no playable duration is a fact worth showing. */
  segments: CorpusSegment[];
};

/** Duration of one dataset in hours. Guards fps 0 / missing, which would divide
 *  by zero and poison every downstream total with NaN/Infinity. */
export function datasetHours(dataset: LocalDatasetSummary): number {
  const { total_frames: frames, fps } = dataset;
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) return 0;
  if (frames <= 0) return 0;
  return frames / fps / 3600;
}

export function computeCorpusStats(groups: DatasetGroup[]): CorpusStats {
  const segments: CorpusSegment[] = groups.map((group) => {
    let hours = 0;
    let episodes = 0;
    let frames = 0;
    let bytes = 0;
    for (const dataset of group.datasets) {
      hours += datasetHours(dataset);
      episodes += dataset.total_episodes || 0;
      frames += dataset.total_frames || 0;
      bytes += dataset.sizeBytes || 0;
    }
    return {
      prefix: group.prefix,
      tasks: group.datasets.length,
      hours,
      episodes,
      frames,
      bytes,
      share: 0,
      avgEpisodeSeconds: episodes > 0 ? (hours * 3600) / episodes : null,
      robotTypes: group.robotTypes,
    };
  });

  const totalHours = segments.reduce((sum, s) => sum + s.hours, 0);
  for (const segment of segments) {
    segment.share = totalHours > 0 ? segment.hours / totalHours : 0;
  }
  segments.sort(
    (a, b) => b.hours - a.hours || a.prefix.localeCompare(b.prefix),
  );

  return {
    totalHours,
    totalEpisodes: segments.reduce((sum, s) => sum + s.episodes, 0),
    totalFrames: segments.reduce((sum, s) => sum + s.frames, 0),
    totalTasks: segments.reduce((sum, s) => sum + s.tasks, 0),
    totalBytes: segments.reduce((sum, s) => sum + s.bytes, 0),
    segments,
  };
}

/**
 * An hours figure, always to one decimal, with thousands separators.
 *
 * The tenth is not decoration: a day of recording moves a four-figure corpus
 * total by less than 1%, and rounding to whole hours hid that entirely — the
 * headline sat on the same integer for days at a time.
 */
export function formatHoursValue(hours: number): string {
  const safe = Number.isFinite(hours) && hours > 0 ? hours : 0;
  return safe.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Headline duration. Sub-hour corpora read in minutes so a fresh install shows
 *  "18 min" rather than a stack of leading zeroes. */
export function formatHours(hours: number): { value: string; unit: string } {
  if (!Number.isFinite(hours) || hours <= 0) {
    return { value: formatHoursValue(0), unit: "h" };
  }
  if (hours < 1) return { value: String(Math.round(hours * 60)), unit: "min" };
  return { value: formatHoursValue(hours), unit: "h" };
}

/** Mean episode length, rendered at the precision the magnitude deserves. */
export function formatEpisodeLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = seconds / 60;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
}

/** Compact count for secondary readouts: 45019623 → "45.0M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US");
}

/**
 * Tape segment widths in percent.
 *
 * Raw shares would render a 0.6% group as a sub-pixel sliver: invisible, and
 * impossible to hover. Every non-empty segment is floored at `minPercent`, and
 * the borrowed width is taken back from the segments above the floor in
 * proportion to their size, so the bar still sums to 100%.
 */
export function tapeWidths(
  segments: CorpusSegment[],
  minPercent = 2.5,
): number[] {
  const shares = segments.map((s) => s.share * 100);
  const belowFloor = shares
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w > 0 && w < minPercent);
  if (belowFloor.length === 0) return shares;

  const debt = belowFloor.reduce((sum, { w }) => sum + (minPercent - w), 0);
  const donorTotal = shares.reduce(
    (sum, w) => sum + (w >= minPercent ? w : 0),
    0,
  );

  return shares.map((w) => {
    if (w <= 0) return 0;
    if (w < minPercent) return minPercent;
    // Donors give up width in proportion to their own size.
    return donorTotal > 0 ? w - debt * (w / donorTotal) : w;
  });
}

/**
 * Segment colors: a cyan→violet ramp anchored on the app's accent.
 *
 * Deliberately monochromatic-adjacent. Emerald / red / amber / orange all carry
 * reserved meanings elsewhere in the UI (healthy / incomplete / empty /
 * flagged), so a categorical rainbow here would collide with status colour and
 * make the tape read as a health bar, which it is not.
 */
export const TAPE_COLORS = [
  "#38bdf8",
  "#4f8ef7",
  "#7c6cf5",
  "#a855f7",
  "#d946ef",
] as const;

export function tapeColor(index: number): string {
  return TAPE_COLORS[index % TAPE_COLORS.length];
}

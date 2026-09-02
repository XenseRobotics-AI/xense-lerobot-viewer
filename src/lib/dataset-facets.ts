/**
 * Derived, read-only facets for browsing the corpus — the pure half.
 *
 * ⚠️ **This module must stay free of `node:` imports.** The homepage grid is a
 * client component and reaches these predicates through `@/utils/corpusFilters`;
 * a single `node:fs/promises` at the top level here propagates into the client
 * bundle and fails the build with `UnhandledSchemeError`. Everything that
 * touches the filesystem lives in `dataset-facets-server.ts`.
 *
 * These values are *derived*, never authored: unlike `dataset-tags.ts` (which
 * persists user-curated values to `meta/xense_tags.json`), everything here is
 * recomputed from files already on disk. Nothing is written back, so a facet
 * cannot drift out of sync with the data it describes.
 */

/** The bucket a dataset lives in — the second segment of its relative path. */
export type CorpusBucket =
  | "merged"
  | "raw"
  | "failed"
  | "released"
  | "in-processing";

const BUCKETS = new Set<string>([
  "merged",
  "raw",
  "failed",
  "released",
  "in-processing",
]);

/**
 * How a capture date was established. Reported alongside the date itself
 * because the three sources are not equally trustworthy, and because
 * "unknown" has to stay visibly distinct from "before the cutoff".
 *
 * Measured over the 542 local datasets: `manifest` 43, `sessions` 65,
 * `name` 359, `none` 75 (13.8%).
 */
export type DateEvidence = "manifest" | "sessions" | "name" | "none";

export type DatasetFacets = {
  /** Null when the path has no recognised bucket segment. */
  bucket: CorpusBucket | null;
  /** Earliest capture date as `YYYY-MM-DD`, or null when nothing establishes one. */
  capturedFrom: string | null;
  /** Latest capture date; equals `capturedFrom` for a single-day dataset. */
  capturedTo: string | null;
  dateEvidence: DateEvidence;
  /**
   * True when the dataset's shape deviates from the corpus norm (20-dim state,
   * 6 video streams). The numbers themselves are `stateDim` / `videoStreams`
   * below — this stays a plain flag so the badge text can be built in the UI
   * through i18n rather than baked into one language here.
   *
   * Deliberately *not* a filter dimension: 538 of 542 datasets share the one
   * shape, so a dropdown would be 99.3% single-valued. As a badge it earns its
   * place, because the handful it marks are the known half-configured captures.
   */
  shapeAnomaly: boolean;
  stateDim: number | null;
  videoStreams: number;
  headStreams: number;
};

export const EMPTY_FACETS: DatasetFacets = {
  bucket: null,
  capturedFrom: null,
  capturedTo: null,
  dateEvidence: "none",
  shapeAnomaly: false,
  stateDim: null,
  videoStreams: 0,
  headStreams: 0,
};

/** Default shape for non-UMI datasets; XTac-UMI has its own 29/8 norm below. */
export const NORMAL_STATE_DIM = 20;
export const NORMAL_VIDEO_STREAMS = 6;

/** First release requires captures on or after this date. */
export const CAPTURE_CUTOFF = "2026-08-15";

export function bucketOf(relativePath: string): CorpusBucket | null {
  const segment = relativePath.split("/")[1];
  return segment && BUCKETS.has(segment) ? (segment as CorpusBucket) : null;
}

/** `taccap-g1-wipe-mirror-0822` → `2026-08-22`. Null when there is no suffix. */
export function dateFromName(name: string): string | null {
  const m = /-(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const [, mm, dd] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // The corpus is single-year; there is no year anywhere in the suffix.
  return `2026-${mm}-${dd}`;
}

/**
 * Flags a dataset whose state dimension or camera count departs from its
 * robot-specific norm. XTac-UMI uses 29 state dimensions and 8 video streams;
 * the remaining supported corpus uses the historical 20/6 shape.
 *
 * Both directions matter and neither is a superset of the other: the corpus
 * holds three datasets with head *video* but only 20 state dims, and one with
 * 29 state dims but no head video. Each is a capture that was configured half
 * way, so the label names what was actually found rather than "anomaly".
 */
export function shapeAnomalyOf(
  stateDim: number | null,
  videoStreams: number,
  robotType?: string | null,
): boolean {
  const isXtacUmi = robotType?.toLowerCase().includes("xtac-umi") ?? false;
  const expectedStateDim = isXtacUmi ? 29 : NORMAL_STATE_DIM;
  const expectedVideoStreams = isXtacUmi ? 8 : NORMAL_VIDEO_STREAMS;
  const dimOdd = stateDim !== null && stateDim !== expectedStateDim;
  const streamsOdd = videoStreams !== expectedVideoStreams;
  return dimOdd || streamsOdd;
}

/** True when any part of the capture span is on or after the cutoff. */
export function isAfterCutoff(facets: DatasetFacets): boolean {
  return facets.capturedTo !== null && facets.capturedTo >= CAPTURE_CUTOFF;
}

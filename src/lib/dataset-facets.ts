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

import { normalizeRobotType } from "@/lib/so101-robot";

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
   * True when the dataset's shape disagrees with what its own `robot_type` is
   * supposed to record. The numbers themselves are `stateDim` / `videoStreams`
   * below — this stays a plain flag so the badge text can be built in the UI
   * through i18n rather than baked into one language here.
   *
   * Deliberately *not* a filter dimension: nearly every dataset in a source
   * shares one shape, so a dropdown would be all but single-valued. As a badge
   * it earns its place, because the handful it marks are the known
   * half-configured captures.
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

/** What one robot type is supposed to record. */
export type RobotShape = {
  stateDim: number;
  videoStreams: number;
};

/**
 * Canonical shape per robot type, keyed by the separator-stripped name
 * (`normalizeRobotType`) and matched as a substring so a versioned spelling
 * like `xtac_umi_g1_v2` still resolves.
 *
 * The shape *is* the robot's signature — each entry is fixed by the rig that
 * recorded it, not by convention:
 *
 * - `bi_taccap_gripper` — 20 dims (two 9-DoF TCP poses + two gripper
 *   positions), 6 cameras (two tactile pairs, two wrists).
 * - `xtac_umi_g1` — 29 dims, 8 cameras (the two above plus the head pair).
 * - `bi_rdt_gripper` — 20 dims, the same bimanual TCP layout as TacCap, but 7
 *   cameras: the four tactile, two wrists, and one `side` view.
 *
 * Keeping this a table rather than a flat list of allowed pairs is what lets a
 * 20-dim + 7-stream *TacCap* capture still be flagged: 20/7 is correct for RDT
 * and wrong for TacCap, and a global whitelist could not tell them apart.
 */
const ROBOT_SHAPES: { match: string; shape: RobotShape }[] = [
  { match: "bitaccapgripper", shape: { stateDim: 20, videoStreams: 6 } },
  { match: "xtacumi", shape: { stateDim: 29, videoStreams: 8 } },
  { match: "birdtgripper", shape: { stateDim: 20, videoStreams: 7 } },
];

/** The shape this robot type should record, or null when it is not a known one. */
export function expectedShapeOf(robotType: string | null): RobotShape | null {
  const normalized = normalizeRobotType(robotType);
  if (!normalized) return null;
  for (const entry of ROBOT_SHAPES) {
    if (normalized.includes(entry.match)) return entry.shape;
  }
  return null;
}

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
 * Flags a dataset whose state/video shape disagrees with its own robot type.
 *
 * The check is robot-aware rather than a global whitelist because the shapes
 * overlap on one axis: TacCap and RDT both record 20 state dims and differ only
 * in stream count (6 vs 7). Judged against the union, a TacCap capture that
 * silently gained a seventh camera reads as a valid RDT dataset and is never
 * flagged — which is the half-configured case the badge exists to catch.
 *
 * Both directions of a mismatch matter and neither is a superset of the other:
 * the corpus holds datasets with head *video* but only 20 state dims, and one
 * with 29 state dims but no head video. Each is a capture that was configured
 * half way, so the badge names what was actually found rather than "anomaly".
 *
 * An unrecognised or missing `robotType` has no expectation to check against,
 * so it falls back to "matches some known rig" — enough to keep a genuinely
 * foreign shape (lerobot's 2-dim PushT, say) flagged without inventing a rule
 * for a robot this build has never been told about.
 */
export function shapeAnomalyOf(
  stateDim: number | null,
  videoStreams: number,
  robotType: string | null,
): boolean {
  if (stateDim === null) return true;
  const expected = expectedShapeOf(robotType);
  if (expected) {
    return !(
      stateDim === expected.stateDim && videoStreams === expected.videoStreams
    );
  }
  return !ROBOT_SHAPES.some(
    (entry) =>
      stateDim === entry.shape.stateDim &&
      videoStreams === entry.shape.videoStreams,
  );
}

/** True when any part of the capture span is on or after the cutoff. */
export function isAfterCutoff(facets: DatasetFacets): boolean {
  return facets.capturedTo !== null && facets.capturedTo >= CAPTURE_CUTOFF;
}

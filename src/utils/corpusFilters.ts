/**
 * Secondary filters for browsing one corpus category — bucket, capture date,
 * and the shape-anomaly shortcut.
 *
 * Kept apart from the grid component so the predicates stay pure and testable:
 * the date rule in particular has an "unknown" case that must not quietly fold
 * into a range, and that is exactly the kind of thing a UI-only implementation
 * gets wrong without anyone noticing.
 */

import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { CAPTURE_CUTOFF, type CorpusBucket } from "@/lib/dataset-facets";

/** `all`, one bucket, or `none` for datasets outside the bucketed layout. */
export type BucketFilter = "all" | CorpusBucket | "none";

/**
 * How the date filter is being applied.
 *
 * `unknown` is its own mode rather than a corner of the range on purpose.
 * Roughly one dataset in seven has no date evidence at all; letting a range
 * sweep them in — or letting them vanish with no way to ask for them — would
 * both misrepresent the corpus.
 */
export type DateMode = "all" | "range" | "unknown";

export type DateFilter = {
  mode: DateMode;
  /** Inclusive `YYYY-MM-DD` bounds. Empty string means "open on this side". */
  from: string;
  to: string;
};

export const DATE_FILTER_ALL: DateFilter = { mode: "all", from: "", to: "" };

/** The first-release preset: everything captured on or after the cutoff. */
export const DATE_FILTER_AFTER_CUTOFF: DateFilter = {
  mode: "range",
  from: CAPTURE_CUTOFF,
  to: "",
};

export const BUCKET_ORDER: CorpusBucket[] = [
  "merged",
  "raw",
  "failed",
  "released",
  "in-processing",
];

export function matchesBucket(
  dataset: LocalDatasetSummary,
  filter: BucketFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "none") return dataset.facets.bucket === null;
  return dataset.facets.bucket === filter;
}

/**
 * A dataset matches a range when its capture span **overlaps** it.
 *
 * Overlap, not containment: a merged dataset spans every day it was built
 * from, so asking for "2026-08-20 onwards" has to return one that ran
 * 08-11 → 08-22. Requiring full containment would silently drop exactly the
 * merged products the range is most often used to find.
 */
export function matchesDate(
  dataset: LocalDatasetSummary,
  filter: DateFilter,
): boolean {
  const { capturedFrom, capturedTo, dateEvidence } = dataset.facets;
  if (filter.mode === "all") return true;
  if (filter.mode === "unknown") return dateEvidence === "none";

  // Undated datasets never satisfy a range — they are reachable only through
  // the explicit `unknown` mode, so they can neither hide inside a result nor
  // disappear without a way to ask for them.
  if (dateEvidence === "none" || capturedFrom === null || capturedTo === null) {
    return false;
  }
  if (filter.from && capturedTo < filter.from) return false;
  if (filter.to && capturedFrom > filter.to) return false;
  return true;
}

export function matchesAnomalyOnly(
  dataset: LocalDatasetSummary,
  anomalyOnly: boolean,
): boolean {
  return !anomalyOnly || dataset.facets.shapeAnomaly;
}

export type FacetCounts = {
  buckets: Record<string, number>;
  /** Datasets with no recognised bucket segment. */
  unbucketed: number;
  /** Datasets carrying any date evidence at all. */
  dated: number;
  unknown: number;
  anomalies: number;
  /** Span covered by the dated datasets — bounds for the date inputs. */
  earliest: string | null;
  latest: string | null;
};

/** Counts for the filter chips, computed once over the unfiltered list. */
export function countFacets(datasets: LocalDatasetSummary[]): FacetCounts {
  const counts: FacetCounts = {
    buckets: {},
    unbucketed: 0,
    dated: 0,
    unknown: 0,
    anomalies: 0,
    earliest: null,
    latest: null,
  };
  for (const ds of datasets) {
    const { bucket, capturedFrom, capturedTo, dateEvidence, shapeAnomaly } =
      ds.facets;
    if (bucket) counts.buckets[bucket] = (counts.buckets[bucket] ?? 0) + 1;
    else counts.unbucketed += 1;

    if (dateEvidence === "none") {
      counts.unknown += 1;
    } else {
      counts.dated += 1;
      if (
        capturedFrom &&
        (!counts.earliest || capturedFrom < counts.earliest)
      ) {
        counts.earliest = capturedFrom;
      }
      if (capturedTo && (!counts.latest || capturedTo > counts.latest)) {
        counts.latest = capturedTo;
      }
    }

    if (shapeAnomaly) counts.anomalies += 1;
  }
  return counts;
}

/** How many datasets a given date filter would keep — for the live count. */
export function countMatchingDate(
  datasets: LocalDatasetSummary[],
  filter: DateFilter,
): number {
  let n = 0;
  for (const ds of datasets) if (matchesDate(ds, filter)) n += 1;
  return n;
}

export { CAPTURE_CUTOFF };

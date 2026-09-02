import { describe, expect, test } from "bun:test";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import type { DatasetFacets } from "@/lib/dataset-facets";
import { EMPTY_TAGS } from "@/lib/dataset-tags";
import {
  DATE_FILTER_AFTER_CUTOFF,
  DATE_FILTER_ALL,
  countFacets,
  matchesAnomalyOnly,
  matchesBucket,
  matchesDate,
  type DateFilter,
} from "@/utils/corpusFilters";

function ds(facets: Partial<DatasetFacets>): LocalDatasetSummary {
  return {
    relativePath: "TacVerse/merged/x",
    encodedPath: "enc",
    codebase_version: "v3.0",
    robot_type: "bi_taccap_gripper",
    total_episodes: 1,
    total_frames: 1,
    fps: 30,
    sizeBytes: 1,
    thumbnailVideoUrl: null,
    integrity: {
      hasData: true,
      hasVideos: true,
      hasEpisodes: true,
      status: "ok",
    },
    tags: { ...EMPTY_TAGS },
    facets: {
      bucket: "merged",
      capturedFrom: "2026-08-20",
      capturedTo: "2026-08-20",
      dateEvidence: "name",
      shapeAnomaly: false,
      stateDim: 20,
      videoStreams: 6,
      headStreams: 0,
      ...facets,
    },
  };
}

describe("matchesBucket", () => {
  test("`all` lets everything through, including unbucketed", () => {
    expect(matchesBucket(ds({ bucket: null }), "all")).toBe(true);
  });

  test("`none` selects exactly the unbucketed", () => {
    expect(matchesBucket(ds({ bucket: null }), "none")).toBe(true);
    expect(matchesBucket(ds({ bucket: "raw" }), "none")).toBe(false);
  });

  test("a named bucket matches only itself", () => {
    expect(matchesBucket(ds({ bucket: "raw" }), "raw")).toBe(true);
    expect(matchesBucket(ds({ bucket: "merged" }), "raw")).toBe(false);
  });
});

describe("matchesDate", () => {
  const dated = (from: string, to: string) =>
    ds({ capturedFrom: from, capturedTo: to, dateEvidence: "name" });
  const undated = ds({
    capturedFrom: null,
    capturedTo: null,
    dateEvidence: "none",
  });
  const range = (from: string, to: string): DateFilter => ({
    mode: "range",
    from,
    to,
  });

  test("`all` keeps everything, dated or not", () => {
    expect(matchesDate(undated, DATE_FILTER_ALL)).toBe(true);
    expect(
      matchesDate(dated("2026-07-01", "2026-07-01"), DATE_FILTER_ALL),
    ).toBe(true);
  });

  test("a span that merely overlaps the range counts", () => {
    // Containment would be wrong: a merged dataset spans every day it was
    // built from, so asking for 08-20 onwards must still return one that ran
    // 08-11 → 08-22 — which is exactly the kind of product the range is for.
    expect(
      matchesDate(dated("2026-08-11", "2026-08-22"), range("2026-08-20", "")),
    ).toBe(true);
    expect(
      matchesDate(dated("2026-08-11", "2026-08-22"), range("", "2026-08-12")),
    ).toBe(true);
  });

  test("a span entirely outside the range does not", () => {
    expect(
      matchesDate(dated("2026-07-01", "2026-07-05"), range("2026-08-15", "")),
    ).toBe(false);
    expect(
      matchesDate(dated("2026-08-20", "2026-08-22"), range("", "2026-08-15")),
    ).toBe(false);
  });

  test("an open side means unbounded, not empty", () => {
    expect(matchesDate(dated("2026-07-01", "2026-07-01"), range("", ""))).toBe(
      true,
    );
  });

  test("the cutoff preset is inclusive of the cutoff day", () => {
    expect(
      matchesDate(dated("2026-08-15", "2026-08-15"), DATE_FILTER_AFTER_CUTOFF),
    ).toBe(true);
    expect(
      matchesDate(dated("2026-08-14", "2026-08-14"), DATE_FILTER_AFTER_CUTOFF),
    ).toBe(false);
  });

  test("undated datasets are reachable only through `unknown`", () => {
    // They must neither hide inside a range result nor vanish with no way to
    // ask for them — a seventh of the corpus lands here.
    expect(matchesDate(undated, { mode: "unknown", from: "", to: "" })).toBe(
      true,
    );
    expect(matchesDate(undated, range("", ""))).toBe(false);
    expect(matchesDate(undated, DATE_FILTER_AFTER_CUTOFF)).toBe(false);
  });

  test("a dated dataset never appears under `unknown`", () => {
    expect(
      matchesDate(dated("2026-08-20", "2026-08-20"), {
        mode: "unknown",
        from: "",
        to: "",
      }),
    ).toBe(false);
  });
});

describe("matchesAnomalyOnly", () => {
  test("off lets everything through", () => {
    expect(matchesAnomalyOnly(ds({ shapeAnomaly: false }), false)).toBe(true);
  });

  test("on keeps only flagged datasets", () => {
    expect(matchesAnomalyOnly(ds({ shapeAnomaly: false }), true)).toBe(false);
    expect(matchesAnomalyOnly(ds({ shapeAnomaly: true }), true)).toBe(true);
  });
});

describe("countFacets", () => {
  test("dated + unknown accounts for every dataset, and bounds the inputs", () => {
    const list = [
      ds({
        capturedFrom: "2026-08-20",
        capturedTo: "2026-08-22",
        dateEvidence: "name",
      }),
      ds({
        capturedFrom: "2026-07-01",
        capturedTo: "2026-08-01",
        dateEvidence: "name",
      }),
      ds({ capturedFrom: null, capturedTo: null, dateEvidence: "none" }),
    ];
    const counts = countFacets(list);
    expect(counts.dated + counts.unknown).toBe(list.length);
    // The bounds feed the date inputs' min/max, so they must span the data.
    expect(counts.earliest).toBe("2026-07-01");
    expect(counts.latest).toBe("2026-08-22");
  });

  test("counts buckets and separates the unbucketed", () => {
    const counts = countFacets([
      ds({ bucket: "merged" }),
      ds({ bucket: "raw" }),
      ds({ bucket: "raw" }),
      ds({ bucket: null }),
    ]);
    expect(counts.buckets).toEqual({ merged: 1, raw: 2 });
    expect(counts.unbucketed).toBe(1);
  });

  test("counts anomalies", () => {
    expect(countFacets([ds({ shapeAnomaly: true }), ds({})]).anomalies).toBe(1);
  });
});

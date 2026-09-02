import { describe, expect, test } from "bun:test";
import {
  CAPTURE_CUTOFF,
  bucketOf,
  dateFromName,
  isAfterCutoff,
  shapeAnomalyOf,
} from "@/lib/dataset-facets";

describe("bucketOf", () => {
  test("reads the second path segment", () => {
    expect(bucketOf("TacVerse/merged/taccap-g1-wipe-mirror")).toBe("merged");
    expect(bucketOf("TacVerse/raw/taccap-g1-wipe-mirror-0822")).toBe("raw");
    expect(bucketOf("TacVerse/in-processing/x")).toBe("in-processing");
  });

  test("is null for anything that is not a known bucket", () => {
    // A dataset directly under a top-level dir, and a stray middle segment,
    // must not be silently reported as some bucket.
    expect(bucketOf("Xense/some-dataset")).toBeNull();
    expect(bucketOf("TacVerse/not-a-bucket/x")).toBeNull();
  });
});

describe("dateFromName", () => {
  test("reads an -MMDD suffix", () => {
    expect(dateFromName("taccap-g1-wipe-mirror-0822")).toBe("2026-08-22");
  });

  test("returns null rather than guessing", () => {
    expect(dateFromName("taccap-g1-wipe-mirror")).toBeNull();
    expect(dateFromName("taccap-g1-x-9999")).toBeNull(); // month 99
  });
});

describe("shapeAnomalyOf", () => {
  test("the corpus norm is not flagged", () => {
    expect(shapeAnomalyOf(20, 6)).toBe(false);
  });

  test("flags both half-configured directions", () => {
    // The numbers live on the facets; this only says "not the norm".
    // Neither is a superset of the other: head video without head state dims,
    // and head state dims without head video. Both are real captures on disk.
    expect(shapeAnomalyOf(20, 8)).toBe(true);
    expect(shapeAnomalyOf(29, 6)).toBe(true);
  });

  test("accepts the XTac-UMI 29-dim + 8-stream shape", () => {
    expect(shapeAnomalyOf(29, 8, "xtac-umi-g1")).toBe(false);
    expect(shapeAnomalyOf(20, 8, "xtac-umi-g1")).toBe(true);
  });
});

describe("isAfterCutoff", () => {
  const base = {
    bucket: null,
    shapeAnomaly: null,
    stateDim: null,
    videoStreams: 0,
    headStreams: 0,
    dateEvidence: "name" as const,
  };

  test("the cutoff day itself counts as after", () => {
    expect(
      isAfterCutoff({
        ...base,
        capturedFrom: CAPTURE_CUTOFF,
        capturedTo: CAPTURE_CUTOFF,
      }),
    ).toBe(true);
  });

  test("a span that reaches past the cutoff counts, even if it starts before", () => {
    // A merged dataset can straddle the line; the filter asks whether it holds
    // any qualifying data, not whether all of it qualifies.
    expect(
      isAfterCutoff({
        ...base,
        capturedFrom: "2026-08-11",
        capturedTo: "2026-08-22",
      }),
    ).toBe(true);
  });

  test("entirely earlier spans do not count", () => {
    expect(
      isAfterCutoff({
        ...base,
        capturedFrom: "2026-08-11",
        capturedTo: "2026-08-14",
      }),
    ).toBe(false);
  });
});

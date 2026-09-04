import { describe, expect, test } from "bun:test";
import {
  CAPTURE_CUTOFF,
  bucketOf,
  dateFromName,
  isAfterCutoff,
  expectedShapeOf,
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
  test("each robot type's own shape is not flagged", () => {
    expect(shapeAnomalyOf(20, 6, "bi_taccap_gripper")).toBe(false);
    expect(shapeAnomalyOf(29, 8, "xtac_umi_g1")).toBe(false);
    expect(shapeAnomalyOf(20, 7, "bi_rdt_gripper")).toBe(false);
  });

  test("reads either separator spelling of a robot type", () => {
    expect(shapeAnomalyOf(29, 8, "xtac-umi-g1")).toBe(false);
    expect(shapeAnomalyOf(29, 8, "XTac_UMI_G1")).toBe(false);
    expect(shapeAnomalyOf(20, 7, "BI-RDT-GRIPPER")).toBe(false);
  });

  test("flags a shape that belongs to a different robot", () => {
    // The whole point of checking against the robot type rather than a union
    // of allowed pairs: 20 + 7 is correct for RDT and wrong for TacCap, so a
    // TacCap capture that gained a seventh camera has to stay visible.
    expect(shapeAnomalyOf(20, 7, "bi_taccap_gripper")).toBe(true);
    expect(shapeAnomalyOf(20, 6, "bi_rdt_gripper")).toBe(true);
    expect(shapeAnomalyOf(29, 8, "bi_rdt_gripper")).toBe(true);
  });

  test("flags both half-configured directions", () => {
    // The numbers live on the facets; this only says "not what this rig
    // records". Neither is a superset of the other: head video without head
    // state dims, and head state dims without head video. Both are real
    // captures on disk.
    expect(shapeAnomalyOf(20, 8, "bi_taccap_gripper")).toBe(true);
    expect(shapeAnomalyOf(29, 6, "xtac_umi_g1")).toBe(true);
  });

  test("an unknown robot type falls back to any known shape", () => {
    // Nothing to check against, so the question becomes "does this look like
    // any rig we know" rather than a rule invented for an unseen robot.
    expect(shapeAnomalyOf(20, 6, null)).toBe(false);
    expect(shapeAnomalyOf(20, 7, "some_new_arm")).toBe(false);
    expect(shapeAnomalyOf(29, 8, "")).toBe(false);
    expect(shapeAnomalyOf(2, 1, "unknown")).toBe(true);
    expect(shapeAnomalyOf(21, 6, null)).toBe(true);
  });

  test("a missing state dimension is always flagged", () => {
    expect(shapeAnomalyOf(null, 6, "bi_taccap_gripper")).toBe(true);
    expect(shapeAnomalyOf(null, 0, null)).toBe(true);
  });
});

describe("expectedShapeOf", () => {
  test("resolves each known robot type", () => {
    expect(expectedShapeOf("bi_taccap_gripper")).toEqual({
      stateDim: 20,
      videoStreams: 6,
    });
    expect(expectedShapeOf("xtac_umi_g1")).toEqual({
      stateDim: 29,
      videoStreams: 8,
    });
    expect(expectedShapeOf("bi_rdt_gripper")).toEqual({
      stateDim: 20,
      videoStreams: 7,
    });
  });

  test("is null for an unknown or absent robot type", () => {
    expect(expectedShapeOf(null)).toBeNull();
    expect(expectedShapeOf("")).toBeNull();
    expect(expectedShapeOf("so101_follower")).toBeNull();
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

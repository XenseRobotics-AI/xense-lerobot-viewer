import { describe, expect, test } from "bun:test";
import {
  coerceTactileAtomBoundaries,
  orderedHands,
} from "@/types/tactile-atom.types";

const VALID = {
  episode_index: 0,
  dataset: "block_to_box",
  fps: null,
  hands: {
    left: { boundary_frames: [0, 34, 88], boundary_times: [0.0, 1.13, 2.93] },
    right: { boundary_frames: [0, 60, 88], boundary_times: [0.0, 2.0, 2.93] },
  },
  provenance: {
    boundary_source: "algo",
    algo_config_fingerprint: "abc123",
    detected_at: "2026-09-08T09:48:28Z",
  },
};

describe("coerceTactileAtomBoundaries", () => {
  test("accepts a well-formed record", () => {
    const out = coerceTactileAtomBoundaries(VALID);
    expect(out).not.toBeNull();
    expect(out?.episode_index).toBe(0);
    expect(out?.hands.left.boundary_frames).toEqual([0, 34, 88]);
    expect(out?.provenance.boundary_source).toBe("algo");
  });

  test("rejects non-objects", () => {
    expect(coerceTactileAtomBoundaries(null)).toBeNull();
    expect(coerceTactileAtomBoundaries("nope")).toBeNull();
    expect(coerceTactileAtomBoundaries(42)).toBeNull();
  });

  test("rejects a record with no usable hands", () => {
    expect(coerceTactileAtomBoundaries({ hands: {} })).toBeNull();
    expect(
      coerceTactileAtomBoundaries({ hands: { left: { boundary_frames: [] } } }),
    ).toBeNull();
  });

  test("drops a hand whose boundary_frames isn't an array of numbers, keeps the rest", () => {
    const out = coerceTactileAtomBoundaries({
      ...VALID,
      hands: {
        left: VALID.hands.left,
        right: { boundary_frames: "not-an-array" },
      },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.hands)).toEqual(["left"]);
  });

  test("defaults boundary_source to 'unknown' when provenance is missing", () => {
    const out = coerceTactileAtomBoundaries({ hands: VALID.hands });
    expect(out?.provenance.boundary_source).toBe("unknown");
  });
});

describe("orderedHands", () => {
  test("puts left before right regardless of input order", () => {
    const boundaries = coerceTactileAtomBoundaries({
      hands: { right: VALID.hands.right, left: VALID.hands.left },
      provenance: { boundary_source: "algo" },
    })!;
    expect(orderedHands(boundaries)).toEqual(["left", "right"]);
  });

  test("sorts unknown hand keys alphabetically after left/right", () => {
    const boundaries = coerceTactileAtomBoundaries({
      hands: {
        gripper: VALID.hands.left,
        right: VALID.hands.right,
        left: VALID.hands.left,
      },
      provenance: { boundary_source: "algo" },
    })!;
    expect(orderedHands(boundaries)).toEqual(["left", "right", "gripper"]);
  });
});

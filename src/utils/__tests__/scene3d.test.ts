import { describe, expect, test } from "bun:test";
import {
  niceGridStep,
  sceneBoundsFromPointArrays,
  toScenePoint,
} from "@/utils/scene3d";

describe("toScenePoint", () => {
  test("maps the dataset's Z-up frame onto Three.js Y-up", () => {
    expect(toScenePoint(1, 2, 3)).toEqual([1, 3, -2]);
  });

  test("keeps the frame right-handed (x cross y === z)", () => {
    const [x] = [toScenePoint(1, 0, 0)];
    const [y] = [toScenePoint(0, 1, 0)];
    const [z] = [toScenePoint(0, 0, 1)];
    // scene x cross scene y should equal scene z
    // `+ 0` normalises the -0 both the mapping and the cross product produce;
    // toEqual distinguishes it from 0.
    const normalize = (values: readonly number[]) => values.map((v) => v + 0);
    const cross = [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
    expect(normalize(cross)).toEqual(normalize(z));
  });
});

describe("sceneBoundsFromPointArrays", () => {
  test("spans every supplied trajectory", () => {
    const bounds = sceneBoundsFromPointArrays([
      [0, 0, 0, 1, 0, 0],
      [-1, 0, 0, 0, 2, 4],
    ]);
    expect(bounds.min.x).toBe(-1);
    expect(bounds.max.x).toBe(1);
    // dataset z -> scene y
    expect(bounds.max.y).toBe(4);
    // dataset y -> scene -z
    expect(bounds.min.z).toBe(-2);
    expect(bounds.center.x).toBe(0);
  });

  test("falls back to a unit box when nothing finite arrives", () => {
    const bounds = sceneBoundsFromPointArrays([]);
    expect(bounds.min.x).toBe(-0.5);
    expect(bounds.max.x).toBe(0.5);
    expect(bounds.extent).toBe(1);
  });

  test("never reports a degenerate extent", () => {
    const bounds = sceneBoundsFromPointArrays([[1, 1, 1, 1, 1, 1]]);
    expect(bounds.extent).toBe(0.1);
  });
});

describe("niceGridStep", () => {
  test("rounds to a 1/2/5 multiple of a power of ten", () => {
    expect(niceGridStep(10)).toBe(1);
    expect(niceGridStep(1)).toBe(0.1);
    expect(niceGridStep(15)).toBe(2);
    expect(niceGridStep(45)).toBe(5);
  });

  test("stays positive for a zero extent", () => {
    expect(niceGridStep(0)).toBeGreaterThan(0);
  });
});

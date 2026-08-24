import { describe, expect, test } from "bun:test";
import { evenlySampleArray, evenlySampleIndices } from "@/utils/sampling";

describe("evenlySampleIndices", () => {
  test("returns every index when the target covers the source", () => {
    expect(evenlySampleIndices(4, 10)).toEqual([0, 1, 2, 3]);
    expect(evenlySampleIndices(0, 5)).toEqual([]);
    expect(evenlySampleIndices(5, 0)).toEqual([]);
    expect(evenlySampleIndices(5, 1)).toEqual([0]);
  });

  test("keeps the first and last index and stays sorted", () => {
    const indices = evenlySampleIndices(100, 5);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(99);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  test("never repeats an index when rounding collides", () => {
    for (let length = 2; length <= 40; length++) {
      for (let target = 2; target <= length; target++) {
        const indices = evenlySampleIndices(length, target);
        expect(new Set(indices).size).toBe(indices.length);
        expect(indices.length).toBe(target);
      }
    }
  });
});

describe("evenlySampleArray", () => {
  test("passes short arrays through untouched", () => {
    const items = [1, 2, 3];
    expect(evenlySampleArray(items, 10)).toBe(items);
  });

  test("thins long arrays down to the cap", () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const sampled = evenlySampleArray(items, 5);
    expect(sampled.length).toBe(5);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(49);
  });
});

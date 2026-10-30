import { describe, expect, test } from "bun:test";
import { normalizeHiddenVideoNames } from "../videoVisibility";

describe("video visibility boundaries", () => {
  test("drops cameras that disappeared and keeps one camera visible", () => {
    expect(
      normalizeHiddenVideoNames(
        ["head", "left_wrist"],
        ["old", "head", "left_wrist"],
      ),
    ).toEqual(["head"]);
  });

  test("deduplicates hidden names without changing their order", () => {
    expect(
      normalizeHiddenVideoNames(["head", "wrist", "side"], ["wrist", "wrist"]),
    ).toEqual(["wrist"]);
  });

  test("returns no hidden names for an empty stream list", () => {
    expect(normalizeHiddenVideoNames([], ["head"])).toEqual([]);
  });
});

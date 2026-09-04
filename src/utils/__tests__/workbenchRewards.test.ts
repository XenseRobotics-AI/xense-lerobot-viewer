import { describe, expect, test } from "bun:test";
import {
  allocateWorkbenchCents,
  DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE,
  normalizeWorkbenchQualityBonusByGrade,
  qualityBonusForGrade,
} from "@/utils/workbenchRewards";

describe("Workbench quality reward math", () => {
  test("maps the default A/B/C/D quality pools", () => {
    expect(DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE).toEqual({
      A: 20,
      B: 10,
      C: 0,
      D: -10,
    });
    expect(
      ["A", "B", "C", "D"].map((grade) =>
        qualityBonusForGrade(grade as "A" | "B" | "C" | "D"),
      ),
    ).toEqual([20, 10, 0, -10]);
  });

  test("normalizes configured quality values to cents", () => {
    expect(
      normalizeWorkbenchQualityBonusByGrade({ A: 1.239, D: -2.345 }),
    ).toEqual({
      A: 1.24,
      B: 10,
      C: 0,
      D: -2.35,
    });
  });

  test("allocates positive and negative pools in exact cents", () => {
    expect(allocateWorkbenchCents(100, [1, 2])).toEqual([33, 67]);
    expect(allocateWorkbenchCents(-1000, [1, 2])).toEqual([-333, -667]);
    expect(allocateWorkbenchCents(20, [0, 0])).toEqual([0, 0]);
  });
});

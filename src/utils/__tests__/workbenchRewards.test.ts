import { describe, expect, test } from "bun:test";
import {
  allocateWorkbenchCents,
  DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
  DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE,
  evaluateWorkbenchRewardRules,
  formatWorkbenchAverageEpisode,
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

describe("Workbench episode duration reward", () => {
  const rules = {
    enabled: true,
    dailyTargetHours: 6,
    levels: [
      {
        id: "negative",
        label: "Negative",
        minPercent: 0,
        maxPercent: 50,
        amount: -10,
      },
      { id: "zero", label: "Zero", minPercent: 50, maxPercent: 100, amount: 0 },
      {
        id: "positive",
        label: "Positive",
        minPercent: 100,
        maxPercent: null,
        amount: 10.01,
      },
    ],
    episodeDurationLevels: [...DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS],
  };

  test("uses weighted total seconds per episode and exact 20s/40s boundaries", () => {
    const under20 = evaluateWorkbenchRewardRules(1, 1, rules, 181);
    expect(under20.averageEpisodeSeconds).toBeCloseTo(19.89, 2);
    expect(under20.multiplier).toBe(1.2);
    expect(under20.baseAmount).toBe(10.01);
    expect(under20.amount).toBe(12.01);
    expect(formatWorkbenchAverageEpisode(under20)).toContain("×1.2");

    expect(evaluateWorkbenchRewardRules(1, 1, rules, 180).multiplier).toBe(1.1);
    expect(evaluateWorkbenchRewardRules(1, 1, rules, 90).multiplier).toBe(1);
  });

  test("does not amplify zero or negative rewards and defaults missing episodes to ×1", () => {
    const negative = evaluateWorkbenchRewardRules(0.25, 1, rules, 100);
    expect(negative.baseAmount).toBe(-10);
    expect(negative.multiplier).toBe(1.2);
    expect(negative.amount).toBe(-10);

    const zero = evaluateWorkbenchRewardRules(0.75, 1, rules, 200);
    expect(zero.amount).toBe(0);
    const missing = evaluateWorkbenchRewardRules(1, 1, rules, 0);
    expect(missing.averageEpisodeSeconds).toBeNull();
    expect(missing.multiplier).toBe(1);
    expect(missing.amount).toBe(10.01);
    expect(formatWorkbenchAverageEpisode(missing)).toBe("—");
  });
});

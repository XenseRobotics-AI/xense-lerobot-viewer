import { describe, expect, test } from "bun:test";
import type { WorkbenchPersonnelConfig } from "@/types/workbench-personnel.types";
import type { WorkbenchDatasetScore } from "@/types/workbench-score.types";
import type { WorkbenchRollupDataset } from "@/utils/workbenchRollup";
import { computeWorkbenchPersonnelRollup } from "@/utils/workbenchPersonnel";

const rules = {
  enabled: true,
  dailyTargetHours: 6,
  levels: [
    {
      id: "below",
      label: "未达标",
      minPercent: 0,
      maxPercent: 100,
      amount: -10,
    },
    { id: "met", label: "达标", minPercent: 100, maxPercent: null, amount: 20 },
  ],
  qualityBonusByGrade: { A: 20, B: 10, C: 0, D: -10 },
};

const config: WorkbenchPersonnelConfig = {
  org: "TacVerse",
  updatedAt: null,
  people: [
    { id: "one", displayName: "一号", email: "one@example.com" },
    { id: "two", displayName: "二号", email: "two@example.com" },
  ],
  schedules: {
    "2026-09-03": [
      {
        workstation: "A1",
        members: [
          { personId: "one", creditFactor: 1 },
          { personId: "two", creditFactor: 2 },
        ],
      },
    ],
  },
};

const dataset: WorkbenchRollupDataset = {
  relativePath: "TacVerse/task-0903",
  total_episodes: 1,
  total_frames: 64800,
  fps: 30,
  robot_type: "g1",
  sizeBytes: 0,
  robotId: "robot-1",
  dailyAdditions: [{ day: "2026-09-03", episodes: 1, frames: 64800, hours: 6 }],
};

const score: WorkbenchDatasetScore = {
  status: "scored",
  score: 100,
  grade: "A",
  doctorReport: null,
  scoredAt: "2026-09-04T00:00:00.000Z",
};

describe("Workbench quality settlement", () => {
  test("allocates one dataset pool by positive contribution factors", () => {
    const result = computeWorkbenchPersonnelRollup(
      [dataset],
      { "robot-1": "A1" },
      config,
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
      new Map([[dataset.relativePath, score]]),
    );
    const one = result.rows.find((row) => row.personId === "one");
    const two = result.rows.find((row) => row.personId === "two");
    expect(one).toMatchObject({
      hours: 3,
      qualityBonus: 6.67,
      durationBonus: 10,
      totalBonus: 16.67,
    });
    expect(two).toMatchObject({
      hours: 3,
      qualityBonus: 13.33,
      durationBonus: 10,
      totalBonus: 23.33,
    });
    expect(result.qualityBonusTotal).toBe(20);
    expect(result.totalBonus).toBe(40);
    expect(result.qualitySettlements).toEqual([
      {
        datasetPath: dataset.relativePath,
        grade: "A",
        pool: 20,
        allocated: true,
        status: "allocated",
        allocations: { one: 6.67, two: 13.33 },
      },
    ]);
  });

  test("freezes failed quality results and leaves unmapped pools unassigned", () => {
    const failed: WorkbenchDatasetScore = {
      ...score,
      status: "retry",
      grade: null,
      score: null,
      error: "retry",
    };
    const result = computeWorkbenchPersonnelRollup(
      [dataset],
      {},
      config,
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
      new Map([[dataset.relativePath, failed]]),
    );
    expect(result.qualityBonusTotal).toBe(0);
    expect(result.qualitySettlements).toEqual([
      {
        datasetPath: dataset.relativePath,
        grade: null,
        pool: 0,
        allocated: false,
        status: "pending",
        allocations: {},
      },
    ]);

    const unassigned = computeWorkbenchPersonnelRollup(
      [dataset],
      {},
      config,
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
      new Map([[dataset.relativePath, score]]),
    );
    expect(unassigned.qualitySettlements[0]).toMatchObject({
      pool: 20,
      allocated: false,
      status: "unassigned",
    });
    expect(unassigned.qualityBonusTotal).toBe(0);
  });
});

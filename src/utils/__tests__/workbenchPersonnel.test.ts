import { describe, expect, test } from "bun:test";
import type { WorkbenchPersonnelConfig } from "@/types/workbench-personnel.types";
import type { WorkbenchRollupDataset } from "@/utils/workbenchRollup";
import {
  computeWorkbenchPersonnelRollup,
  resolveWorkbenchPersonnelSchedule,
} from "@/utils/workbenchPersonnel";
import type { WorkbenchRewardRulesConfig } from "@/utils/workbenchRewards";

const rules: WorkbenchRewardRulesConfig = {
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
    {
      id: "met",
      label: "达标",
      minPercent: 100,
      maxPercent: null,
      amount: 20,
    },
  ],
};

function dataset(
  robotId: string,
  additions: Array<{ day: string; hours: number }>,
): WorkbenchRollupDataset {
  return {
    relativePath: `TacVerse/${robotId}`,
    total_episodes: 0,
    total_frames: 0,
    fps: 30,
    robot_type: "bi_taccap",
    sizeBytes: 0,
    robotId,
    dailyAdditions: additions.map((addition) => ({
      ...addition,
      episodes: 1,
      frames: 1,
    })),
  };
}

function personnelConfig(): WorkbenchPersonnelConfig {
  return {
    org: "TacVerse",
    updatedAt: null,
    people: [
      { id: "zhang", displayName: "张三", email: "zhang@example.com" },
      { id: "li", displayName: "李四", email: "" },
    ],
    schedules: {
      "2026-09-03": [
        {
          workstation: "A1",
          collectorCount: 2,
          members: [
            { personId: "zhang", creditFactor: 1 },
            { personId: "li", creditFactor: 1 },
          ],
        },
      ],
    },
  };
}

describe("personnel schedule inheritance", () => {
  const schedules = personnelConfig().schedules;

  test("inherits the latest schedule on or before the requested day", () => {
    expect(
      resolveWorkbenchPersonnelSchedule(schedules, "2026-09-04"),
    ).toMatchObject({
      sourceDate: "2026-09-03",
      isExplicit: false,
    });
  });

  test("uses an explicit override, including an empty schedule", () => {
    const overridden = { ...schedules, "2026-09-04": [] };
    expect(
      resolveWorkbenchPersonnelSchedule(overridden, "2026-09-04"),
    ).toMatchObject({
      sourceDate: "2026-09-04",
      isExplicit: true,
      assignments: [],
    });
    expect(
      resolveWorkbenchPersonnelSchedule(overridden, "2026-09-05"),
    ).toMatchObject({ sourceDate: "2026-09-04", assignments: [] });
  });

  test("deleting an override restores inheritance and dates before the first config are empty", () => {
    const overridden = { ...schedules, "2026-09-04": [] };
    delete overridden["2026-09-04"];
    expect(
      resolveWorkbenchPersonnelSchedule(overridden, "2026-09-04").sourceDate,
    ).toBe("2026-09-03");
    expect(
      resolveWorkbenchPersonnelSchedule(schedules, "2026-09-02"),
    ).toMatchObject({ sourceDate: null, assignments: [] });
  });
});

describe("personnel workload rollup", () => {
  test("divides co-assigned workstation hours evenly by original collectors", () => {
    const config = personnelConfig();
    config.schedules["2026-09-03"][0].members[1].creditFactor = 3;
    const result = computeWorkbenchPersonnelRollup(
      [
        dataset("robot-1", [{ day: "2026-09-03", hours: 2 }]),
        dataset("robot-2", [{ day: "2026-09-03", hours: 4 }]),
      ],
      { "robot-1": "A1", "robot-2": "A1" },
      config,
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
    );

    expect(result.rows.map((row) => [row.personnel, row.hours])).toEqual([
      ["李四", 3],
      ["张三", 3],
    ]);
    expect(result.rows.every((row) => row.targetHours === 3)).toBeTrue();
    expect(result.rows.every((row) => row.reward.amount === 10)).toBeTrue();
    expect(result.rows.every((row) => row.durationBonus === 10)).toBeTrue();
    expect(result.totalBonus).toBe(20);
  });

  test("divides workstation hours by the original collector count", () => {
    const config = personnelConfig();
    config.schedules["2026-09-03"][0].collectorCount = 4;

    const result = computeWorkbenchPersonnelRollup(
      [dataset("robot-1", [{ day: "2026-09-03", hours: 6 }])],
      { "robot-1": "A1" },
      config,
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
    );

    expect(result.rows.map((row) => row.hours)).toEqual([1.5, 1.5]);
  });

  test("adds hours across changed workstations but counts one target day per person", () => {
    const config = personnelConfig();
    config.schedules["2026-09-04"] = [
      {
        workstation: "B2",
        members: [{ personId: "zhang", creditFactor: 1 }],
      },
      {
        workstation: "C3",
        members: [{ personId: "zhang", creditFactor: 1 }],
      },
    ];
    const result = computeWorkbenchPersonnelRollup(
      [
        dataset("robot-1", [
          { day: "2026-09-03", hours: 3 },
          { day: "2026-09-04", hours: 2 },
        ]),
        dataset("robot-2", [{ day: "2026-09-04", hours: 4 }]),
      ],
      { "robot-1": "B2", "robot-2": "C3" },
      config,
      { startDate: "2026-09-03", endDate: "2026-09-05" },
      rules,
    );

    const zhang = result.rows.find((row) => row.personId === "zhang");
    expect(zhang).toMatchObject({
      hours: 6,
      scheduledDays: 2,
      targetHours: 15,
      workstations: ["A1", "B2", "C3"],
    });
    expect(result.unattributedWorkstations).toEqual([
      { day: "2026-09-03", workstation: "B2", hours: 3 },
    ]);
  });

  test("uses the legacy left-SN workstation mapping with normalized credits", () => {
    const legacy = dataset("legacy", [{ day: "2026-09-03", hours: 6 }]);
    legacy.robotId = null;
    legacy.leftGripperSn = "left-sn";
    const result = computeWorkbenchPersonnelRollup(
      [legacy],
      { "left-sn": "A1" },
      personnelConfig(),
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
    );

    expect(result.rows.every((row) => row.hours === 3)).toBeTrue();
    expect(result.unattributedHours).toBe(0);
  });

  test("shows scheduled people with zero output and enforces half-open boundaries", () => {
    const result = computeWorkbenchPersonnelRollup(
      [
        dataset("robot-1", [
          { day: "2026-09-02", hours: 8 },
          { day: "2026-09-04", hours: 8 },
        ]),
      ],
      { "robot-1": "A1" },
      personnelConfig(),
      { startDate: "2026-09-03", endDate: "2026-09-04" },
      rules,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.hours === 0)).toBeTrue();
    expect(result.rows.every((row) => row.reward.amount === -5)).toBeTrue();
    expect(result.unattributedHours).toBe(0);
  });
});

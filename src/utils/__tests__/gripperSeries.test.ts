import { describe, expect, test } from "bun:test";
import {
  chartSeriesFeature,
  gripperSeriesKeys,
  isGripperFeature,
  selectGripperSeriesRows,
} from "@/utils/gripperSeries";
import { CHART_CONFIG } from "@/utils/constants";
import type { ChartSeriesRow } from "@/types/chart.types";

const DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER; // " | "

describe("chartSeriesFeature", () => {
  test("takes the dimension from a flat `source | feature` key", () => {
    expect(chartSeriesFeature(`action${DELIM}left_gripper.pos`)).toBe(
      "left_gripper.pos",
    );
  });

  test("returns a nested group key unchanged — it is already the feature", () => {
    // `groupRowBySuffix` drops the prefix when several sources record the same
    // dimension, so the bare key is the feature name.
    expect(chartSeriesFeature("right_gripper.pos")).toBe("right_gripper.pos");
  });
});

describe("isGripperFeature", () => {
  test("matches the spellings the rigs actually record", () => {
    for (const name of [
      "gripper",
      "gripper.pos",
      "left_gripper.pos",
      "right_gripper.position",
      "main_gripper.q",
      "Gripper",
    ]) {
      expect(`${name}:${isGripperFeature(name)}`).toBe(`${name}:true`);
    }
  });

  test("ignores other features, including numbered dimensions", () => {
    for (const name of [
      "left_tcp.x",
      "shoulder_pan.pos",
      "0",
      "7",
      "left_tcp.vx (m/s)",
      "grippers",
    ]) {
      expect(`${name}:${isGripperFeature(name)}`).toBe(`${name}:false`);
    }
  });
});

const flatGroup: ChartSeriesRow[] = [
  { timestamp: 0, [`action${DELIM}left_tcp.x`]: 0.1 },
  { timestamp: 0.1, [`action${DELIM}left_tcp.x`]: 0.2 },
];

const gripperGroup: ChartSeriesRow[] = [
  {
    timestamp: 0,
    "left_gripper.pos": { action: 1, "observation.state": 0.98 },
    [`action${DELIM}right_gripper.pos`]: 0.5,
  },
  {
    timestamp: 0.1,
    "left_gripper.pos": { action: 0, "observation.state": 0.12 },
    [`action${DELIM}right_gripper.pos`]: 0.4,
  },
];

describe("gripperSeriesKeys", () => {
  test("finds gripper series in both the nested and flat key shapes", () => {
    expect(gripperSeriesKeys([flatGroup, gripperGroup])).toEqual([
      "left_gripper.pos",
      `action${DELIM}right_gripper.pos`,
    ]);
  });

  test("is empty when nothing names a gripper", () => {
    expect(gripperSeriesKeys([flatGroup])).toEqual([]);
    expect(gripperSeriesKeys([])).toEqual([]);
  });
});

describe("selectGripperSeriesRows", () => {
  test("keeps only the gripper entries, timestamps included", () => {
    const rows = selectGripperSeriesRows([flatGroup, gripperGroup]);
    expect(rows).toEqual([
      {
        timestamp: 0,
        "left_gripper.pos": { action: 1, "observation.state": 0.98 },
        [`action${DELIM}right_gripper.pos`]: 0.5,
      },
      {
        timestamp: 0.1,
        "left_gripper.pos": { action: 0, "observation.state": 0.12 },
        [`action${DELIM}right_gripper.pos`]: 0.4,
      },
    ]);
  });

  test("merges gripper series that live in different scale groups", () => {
    const left: ChartSeriesRow[] = [
      { timestamp: 0, [`action${DELIM}left_gripper.pos`]: 1 },
    ];
    const right: ChartSeriesRow[] = [
      { timestamp: 0, [`action${DELIM}right_gripper.pos`]: 0 },
    ];
    expect(selectGripperSeriesRows([left, flatGroup, right])).toEqual([
      {
        timestamp: 0,
        [`action${DELIM}left_gripper.pos`]: 1,
        [`action${DELIM}right_gripper.pos`]: 0,
      },
    ]);
  });

  test("spans the longest contributing group", () => {
    const long: ChartSeriesRow[] = [
      { timestamp: 0, gripper: 1 },
      { timestamp: 0.1, gripper: 0 },
      { timestamp: 0.2, gripper: 0 },
    ];
    expect(selectGripperSeriesRows([long, flatGroup])).toHaveLength(3);
  });

  test("returns nothing when no group carries a gripper series", () => {
    expect(selectGripperSeriesRows([flatGroup])).toEqual([]);
  });
});

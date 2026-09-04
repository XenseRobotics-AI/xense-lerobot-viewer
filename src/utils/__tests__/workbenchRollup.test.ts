import { describe, expect, test } from "bun:test";
import { formatWorkbenchRewardAmount } from "@/utils/workbenchRewards";
import {
  WORKBENCH_LEFT_SN_REWARD_AMOUNT,
  computeWorkbenchAdditionRollup,
  computeWorkbenchAdditionTimeline,
  computeWorkbenchRollup,
  computeWorkbenchTimeline,
  countHalfOpenDays,
  formatWorkbenchRewardCoins,
  getWorkbenchOkrAchievementRate,
  workbenchDatasetName,
  workbenchGroupDatasetNames,
  workbenchGroupSourceRepoIds,
  getWorkbenchDefaultDateRange,
  getWorkbenchDefaultDateTimeRange,
  getWorkbenchDateTimeRangeShortcut,
  getWorkbenchLeftSnWorkstation,
  getWorkbenchLeftSnTargetHours,
  getWorkbenchLatestAvailableDateTimeRange,
  getWorkbenchOkrRewardAmount,
  getWorkbenchOkrSymbol,
  hasWorkbenchDatasetDateSuffix,
  isWorkbenchIgnoredRobotId,
  normalizeWorkbenchDateRange,
  workbenchAdditionAvailableDays,
  workbenchAdditionDatasetPaths,
  workbenchDatasetSuffixDay,
  workbenchDayKey,
  workbenchGroupAdditionDatasetNames,
  workbenchRollupLabel,
  workbenchTaskPrefix,
  type WorkbenchRollupDataset,
} from "@/utils/workbenchRollup";

function dataset(
  relativePath: string,
  overrides: Partial<WorkbenchRollupDataset> = {},
): WorkbenchRollupDataset {
  return {
    relativePath,
    total_episodes: 10,
    total_frames: 36_000,
    fps: 10,
    robot_type: "g1",
    sizeBytes: 0,
    leftGripperSn: null,
    ...overrides,
  };
}

describe("workbenchTaskPrefix", () => {
  test("drops the owner and trailing MMDD suffix", () => {
    expect(workbenchTaskPrefix("TacVerse/taccap-g1-place-cup-0817")).toBe(
      "taccap-g1-place-cup",
    );
  });

  test("keeps a task without a date suffix", () => {
    expect(workbenchTaskPrefix("TacVerse/place-cup")).toBe("place-cup");
  });
});

describe("workbenchDatasetName", () => {
  test("returns the leaf dataset name without the organization prefix", () => {
    expect(
      workbenchDatasetName("TacVerse/taccap-g1-arrange-tabletop-items-0826"),
    ).toBe("taccap-g1-arrange-tabletop-items-0826");
  });
});

describe("workbench dataset date suffix", () => {
  test("accepts repo leaves ending in a valid MMDD date", () => {
    expect(
      workbenchDatasetSuffixDay(
        "TacVerse/taccap-g1-arrange-tabletop-items-0826",
        "2026-08-27T10:00:00Z",
      ),
    ).toBe("2026-08-26");
    expect(
      hasWorkbenchDatasetDateSuffix(
        "TacVerse/taccap-g1-arrange-tabletop-items-0826",
        "2026-08-27T10:00:00Z",
      ),
    ).toBe(true);
  });

  test("rejects repair outputs and invalid date suffixes", () => {
    expect(
      workbenchDatasetSuffixDay(
        "TacVerse/taccap-g1-fold-garment-0819-repair-tactile",
        "2026-08-27T10:00:00Z",
      ),
    ).toBeNull();
    expect(
      hasWorkbenchDatasetDateSuffix("TacVerse/taccap-g1-bad-date-1399"),
    ).toBe(false);
  });
});

describe("isWorkbenchIgnoredRobotId", () => {
  test("ignores the legacy default robot id", () => {
    expect(isWorkbenchIgnoredRobotId("bi_taccap_0")).toBe(true);
    expect(isWorkbenchIgnoredRobotId(" bi_taccap_0 ")).toBe(true);
    expect(isWorkbenchIgnoredRobotId("bi_taccap_8")).toBe(false);
    expect(isWorkbenchIgnoredRobotId(null)).toBe(false);
  });
});

describe("workbenchRollupLabel", () => {
  const row = dataset("TacVerse/task-0817", {
    uploader: "XR-Bot0",
    uploaderName: "洪锐",
  });

  test("uses the friendly uploader name when available", () => {
    expect(workbenchRollupLabel(row, "uploader")).toBe("洪锐");
  });

  test("supports source, task and robot type", () => {
    expect(workbenchRollupLabel(row, "source")).toBe("TacVerse");
    expect(workbenchRollupLabel(row, "task")).toBe("task");
    expect(workbenchRollupLabel(row, "robot_type")).toBe("g1");
    expect(
      workbenchRollupLabel(
        dataset("TacVerse/task-0817", { leftGripperSn: "TCGU01A28Z0069m" }),
        "left_gripper_sn",
      ),
    ).toBe("TCGU01A28Z0069m");
  });
});

describe("getWorkbenchDefaultDateRange", () => {
  test("defaults to the previous local day through the current local day as an exclusive end", () => {
    expect(getWorkbenchDefaultDateRange(new Date(2026, 7, 26, 12))).toEqual({
      startDate: "2026-08-25",
      endDate: "2026-08-26",
    });
  });
});

describe("getWorkbenchDefaultDateTimeRange", () => {
  test("defaults to the previous local day 00:00 through today 00:00", () => {
    expect(getWorkbenchDefaultDateTimeRange(new Date(2026, 7, 26, 12))).toEqual(
      {
        startDateTime: "2026-08-25T00:00",
        endDateTime: "2026-08-26T00:00",
      },
    );
  });
});

describe("Workbench production-day date ranges", () => {
  test("selects the latest available day and its exclusive next-day boundary", () => {
    expect(
      getWorkbenchLatestAvailableDateTimeRange([
        "2026-08-28",
        "2026-09-02",
        "2026-09-02",
      ]),
    ).toEqual({
      startDateTime: "2026-09-02T00:00",
      endDateTime: "2026-09-03T00:00",
    });
  });

  test("falls back to yesterday when no production day is available", () => {
    expect(
      getWorkbenchLatestAvailableDateTimeRange([], new Date(2026, 7, 26, 12)),
    ).toEqual({
      startDateTime: "2026-08-25T00:00",
      endDateTime: "2026-08-26T00:00",
    });
  });

  test("supports the five local date shortcuts", () => {
    const now = new Date(2026, 7, 26, 12);
    expect(getWorkbenchDateTimeRangeShortcut("today", now)).toEqual({
      startDateTime: "2026-08-26T00:00",
      endDateTime: "2026-08-27T00:00",
    });
    expect(getWorkbenchDateTimeRangeShortcut("yesterday", now)).toEqual({
      startDateTime: "2026-08-25T00:00",
      endDateTime: "2026-08-26T00:00",
    });
    expect(getWorkbenchDateTimeRangeShortcut("last7Days", now)).toEqual({
      startDateTime: "2026-08-20T00:00",
      endDateTime: "2026-08-27T00:00",
    });
    expect(getWorkbenchDateTimeRangeShortcut("thisWeek", now)).toEqual({
      startDateTime: "2026-08-24T00:00",
      endDateTime: "2026-08-27T00:00",
    });
    expect(getWorkbenchDateTimeRangeShortcut("lastWeek", now)).toEqual({
      startDateTime: "2026-08-17T00:00",
      endDateTime: "2026-08-24T00:00",
    });
  });
});

describe("Left SN OKR helpers", () => {
  test("counts half-open days and scales the target by the configured daily hours", () => {
    const range = {
      startDate: "2026-08-25",
      endDate: "2026-08-26",
    };

    expect(countHalfOpenDays(range)).toBe(1);
    expect(getWorkbenchLeftSnTargetHours(range)).toBe(6);
    expect(getWorkbenchLeftSnTargetHours(range, 7.5)).toBe(7.5);
  });

  test("maps hours to the expected emoji states", () => {
    expect(getWorkbenchOkrSymbol(12, 12)).toBe("✅");
    expect(getWorkbenchOkrSymbol(10.8, 12)).toBe("…");
    expect(getWorkbenchOkrSymbol(10.79, 12)).toBe("❌");
    expect(getWorkbenchOkrSymbol(Number.NaN, 12)).toBe("—");
  });

  test("returns the configured reward only for completed OKRs", () => {
    expect(WORKBENCH_LEFT_SN_REWARD_AMOUNT).toBe(20);
    expect(getWorkbenchOkrRewardAmount(12, 12, 300)).toBe(300);
    expect(getWorkbenchOkrRewardAmount(9.6, 12, 300)).toBe(0);
    expect(getWorkbenchOkrRewardAmount(12, 12, 0)).toBe(0);
  });

  test("turns hours and target hours into a percent achievement rate", () => {
    expect(getWorkbenchOkrAchievementRate(12, 12)).toBe(100);
    expect(getWorkbenchOkrAchievementRate(10.8, 12)).toBe(90);
    expect(getWorkbenchOkrAchievementRate(0, 12)).toBe(0);
    expect(getWorkbenchOkrAchievementRate(12, 0)).toBeNull();
  });

  test("formats one coin per 10 reward units", () => {
    expect(formatWorkbenchRewardCoins(20)).toBe("🪙🪙");
    expect(formatWorkbenchRewardCoins(30)).toBe("🪙🪙🪙");
    expect(formatWorkbenchRewardCoins(0)).toBe("—");
  });

  test("adds the coin emoji only to positive reward amounts", () => {
    expect(formatWorkbenchRewardAmount(20)).toBe("¥+20 🪙");
    expect(formatWorkbenchRewardAmount(-20)).toBe("¥-20");
    expect(formatWorkbenchRewardAmount(0)).toBe("¥0");
  });

  test("returns a placeholder when no Workstation mapping is provided", () => {
    expect(getWorkbenchLeftSnWorkstation("TCGU01A28Z0033m")).toBe("—");
    expect(getWorkbenchLeftSnWorkstation("unknown")).toBe("—");
  });

  test("uses caller-provided Workstation mappings", () => {
    expect(
      getWorkbenchLeftSnWorkstation("TCGU01A28Z0033m", {
        TCGU01A28Z0033m: "Z9",
      }),
    ).toBe("Z9");
    expect(getWorkbenchLeftSnWorkstation("TCGU01A28Z0071m", {})).toBe("—");
  });
});

describe("computeWorkbenchRollup", () => {
  test("sums counts, episodes, frames and hours, sorted by hours", () => {
    const rows = computeWorkbenchRollup(
      [
        dataset("TacVerse/a-0817", { uploader: "alice" }),
        dataset("TacVerse/b-0817", {
          uploader: "alice",
          total_episodes: 5,
          total_frames: 18_000,
        }),
        dataset("TacVerse/c-0817", {
          uploader: "bob",
          total_episodes: 2,
          total_frames: 3_600,
        }),
      ],
      "uploader",
    );

    expect(rows.map((row) => row.group)).toEqual(["alice", "bob"]);
    expect(rows[0]).toMatchObject({
      count: 2,
      episodes: 15,
      frames: 54_000,
      hours: 1.5,
    });
    expect(rows[0].pctHours).toBeCloseTo(93.8, 1);
    expect(rows[1].pctHours).toBeCloseTo(6.3, 1);
  });

  test("returns zero shares for data with no valid duration", () => {
    const rows = computeWorkbenchRollup(
      [dataset("TacVerse/a-0817", { fps: 0, robot_type: null })],
      "robot_type",
    );
    expect(rows).toEqual([
      {
        group: "—",
        count: 1,
        episodes: 10,
        frames: 36_000,
        hours: 0,
        pctHours: 0,
      },
    ]);
  });

  test("prefers refreshed catalog duration hours when present", () => {
    const rows = computeWorkbenchRollup(
      [
        dataset("TacVerse/catalog-0817", {
          total_episodes: 0,
          total_frames: 0,
          fps: 0,
          durationHours: 3.25,
        }),
      ],
      "source",
    );

    expect(rows).toEqual([
      expect.objectContaining({ hours: 3.25, pctHours: 100 }),
    ]);
  });

  test("returns dataset names for each Left SN group in the date range", () => {
    const names = workbenchGroupDatasetNames(
      [
        dataset("TacVerse/taccap-g1-arrange-tabletop-items-0826", {
          leftGripperSn: "TCGU01A28Z0033m",
          lastModified: "2026-08-26T08:00:00Z",
        }),
        dataset("TacVerse/taccap-g1-place-cup-0825", {
          leftGripperSn: "TCGU01A28Z0033m",
          lastModified: "2026-08-25T08:00:00Z",
        }),
        dataset("TacVerse/taccap-g1-fold-cloth-0826", {
          leftGripperSn: "TCGU01A28Z0069m",
          lastModified: "2026-08-26T08:00:00Z",
        }),
      ],
      "left_gripper_sn",
      { startDate: "2026-08-26", endDate: "2026-08-27" },
    );

    expect(names.get("TCGU01A28Z0033m")).toEqual([
      "taccap-g1-arrange-tabletop-items-0826",
    ]);
    expect(names.get("TCGU01A28Z0069m")).toEqual(["taccap-g1-fold-cloth-0826"]);
  });

  test("groups totals by left gripper serial", () => {
    const rows = computeWorkbenchRollup(
      [
        dataset("TacVerse/a-0817", {
          leftGripperSn: "TCGU01A28Z0069m",
        }),
        dataset("TacVerse/b-0817", {
          total_episodes: 5,
          total_frames: 18_000,
          leftGripperSn: "TCGU01A28Z0001m",
        }),
        dataset("TacVerse/c-0817", {
          total_episodes: 1,
          total_frames: 3_600,
          leftGripperSn: null,
        }),
      ],
      "left_gripper_sn",
    );

    expect(rows.map((row) => row.group)).toEqual([
      "TCGU01A28Z0069m",
      "TCGU01A28Z0001m",
      "—",
    ]);
    expect(rows[0]).toMatchObject({ count: 1, episodes: 10, hours: 1 });
  });

  test("sanitizes malformed negative and non-finite counts", () => {
    const rows = computeWorkbenchRollup(
      [
        dataset("TacVerse/bad-0817", {
          total_episodes: -4,
          total_frames: Number.NaN,
          fps: 30,
        }),
      ],
      "source",
    );
    expect(rows).toEqual([
      expect.objectContaining({ count: 1, episodes: 0, frames: 0, hours: 0 }),
    ]);
  });
});

describe("workbenchDayKey", () => {
  test("normalizes ISO timestamps to a UTC day key", () => {
    expect(workbenchDayKey("2026-08-25T23:30:00+08:00")).toBe("2026-08-25");
    expect(workbenchDayKey("2026-08-28T16:30:00Z")).toBe("2026-08-28");
  });

  test("rejects missing and invalid values", () => {
    expect(workbenchDayKey(null)).toBeNull();
    expect(workbenchDayKey("not-a-date")).toBeNull();
  });
});

describe("normalizeWorkbenchDateRange", () => {
  test("fills missing bounds from available days and swaps reversed input", () => {
    expect(
      normalizeWorkbenchDateRange("2026-08-21", "2026-08-19", [
        "2026-08-18",
        "2026-08-20",
        "2026-08-22",
      ]),
    ).toEqual({ startDate: "2026-08-19", endDate: "2026-08-21" });
    expect(
      normalizeWorkbenchDateRange(null, null, ["2026-08-20", "2026-08-18"]),
    ).toEqual({ startDate: "2026-08-18", endDate: "2026-08-21" });
  });

  test("keeps explicit ranges outside the available data", () => {
    expect(
      normalizeWorkbenchDateRange("2026-08-01", "2026-09-01", [
        "2026-08-18",
        "2026-08-20",
      ]),
    ).toEqual({ startDate: "2026-08-01", endDate: "2026-09-01" });
  });
});

describe("workbench source repo ids", () => {
  test("returns sorted full Hub repo ids for each robot_id group", () => {
    const repos = workbenchGroupSourceRepoIds(
      [
        dataset("TacVerse/raw/z-last-0828", {
          robotId: "robot-a",
          dailyAdditions: [
            { day: "2026-08-28", episodes: 1, frames: 3600, hours: 0.1 },
          ],
        }),
        dataset("TacVerse/a-first-0828", {
          robotId: "robot-a",
          dailyAdditions: [
            { day: "2026-08-28", episodes: 2, frames: 7200, hours: 0.2 },
          ],
        }),
        dataset("TacVerse/taccap-g1-fold-garment-0819-repair-tactile", {
          robotId: "robot-a",
          dailyAdditions: [
            { day: "2026-08-28", episodes: 2, frames: 7200, hours: 0.2 },
          ],
        }),
        dataset("TacVerse/robot-b-0828", {
          robotId: "robot-b",
          dailyAdditions: [
            { day: "2026-08-28", episodes: 3, frames: 10800, hours: 0.3 },
          ],
        }),
        dataset("TacVerse/out-of-range-0827", {
          robotId: "robot-a",
          dailyAdditions: [
            { day: "2026-08-27", episodes: 4, frames: 14400, hours: 0.4 },
          ],
        }),
      ],
      "robot_id",
      { startDate: "2026-08-28", endDate: "2026-08-29" },
    );

    expect(repos.get("robot-a")).toEqual([
      "TacVerse/a-first-0828",
      "TacVerse/z-last-0828",
    ]);
    expect(repos.get("robot-b")).toEqual(["TacVerse/robot-b-0828"]);
  });
});

describe("date-aware workbench rollups", () => {
  test("filters grouped totals to the half-open date range", () => {
    const rows = computeWorkbenchRollup(
      [
        dataset("TacVerse/task-a-0817", {
          uploader: "alice",
          lastModified: "2026-08-17T12:00:00Z",
        }),
        dataset("TacVerse/task-b-0818", {
          uploader: "bob",
          total_episodes: 5,
          total_frames: 18_000,
          lastModified: "2026-08-18T12:00:00Z",
        }),
        dataset("TacVerse/task-c-0819", {
          uploader: "alice",
          total_episodes: 2,
          total_frames: 3_600,
          lastModified: "2026-08-19T12:00:00Z",
        }),
      ],
      "uploader",
      { startDate: "2026-08-18", endDate: "2026-08-19" },
    );

    expect(rows.map((row) => row.group)).toEqual(["bob"]);
    expect(rows[0]).toMatchObject({ count: 1, episodes: 5, hours: 0.5 });
  });

  test("builds daily rows with cumulative totals", () => {
    const timeline = computeWorkbenchTimeline(
      [
        dataset("TacVerse/a-0817", {
          lastModified: "2026-08-17T01:00:00Z",
        }),
        dataset("TacVerse/b-0817", {
          total_episodes: 5,
          total_frames: 18_000,
          lastModified: "2026-08-17T10:00:00Z",
        }),
        dataset("TacVerse/c-0818", {
          total_episodes: 2,
          total_frames: 3_600,
          lastModified: "2026-08-18T10:00:00Z",
        }),
      ],
      { startDate: "2026-08-17", endDate: "2026-08-18" },
    );

    expect(timeline.rows).toEqual([
      expect.objectContaining({
        day: "2026-08-17",
        datasets: 2,
        episodes: 15,
        hours: 1.5,
        cumulativeDatasets: 2,
        cumulativeEpisodes: 15,
        cumulativeHours: 1.5,
      }),
    ]);
    expect(timeline.total).toMatchObject({
      datasets: 2,
      episodes: 15,
      hours: 1.5,
    });
  });
});

test("returns unique dataset paths in the half-open range", () => {
  const item = dataset("TacVerse/repeated-task", {
    dailyAdditions: [
      { day: "2026-08-28", episodes: 1, frames: 1, hours: 0.1 },
      { day: "2026-08-29", episodes: 1, frames: 1, hours: 0.1 },
    ],
  });
  expect(
    workbenchAdditionDatasetPaths([item, item], {
      startDate: "2026-08-28",
      endDate: "2026-08-30",
    }),
  ).toEqual(["TacVerse/repeated-task"]);
});

describe("strict workbench addition rollups", () => {
  test("rolls up only positive daily additions in the selected UTC range", () => {
    const rows = computeWorkbenchAdditionRollup(
      [
        dataset("TacVerse/task-a-0828", {
          uploader: "alice",
          dailyAdditions: [
            { day: "2026-08-28", episodes: 10, frames: 36_000, hours: 1 },
            { day: "2026-08-29", episodes: 0, frames: 0, hours: 0 },
          ],
        }),
        dataset("TacVerse/task-b-0828", {
          uploader: "alice",
          total_episodes: 500,
          total_frames: 1_800_000,
          dailyAdditions: [
            { day: "2026-08-28", episodes: 5, frames: 18_000, hours: 0.5 },
          ],
        }),
        dataset("TacVerse/metadata-only-0828", {
          uploader: "bob",
          total_episodes: 400,
          total_frames: 1_440_000,
          lastModified: "2026-08-28T04:00:00Z",
        }),
      ],
      "uploader",
      { startDate: "2026-08-28", endDate: "2026-08-29" },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        group: "alice",
        count: 2,
        episodes: 15,
        frames: 54_000,
        hours: 1.5,
        pctHours: 100,
      }),
    ]);
  });

  test("builds strict daily timelines and dataset name tooltips from additions", () => {
    const datasets = [
      dataset("TacVerse/task-a-0828", {
        leftGripperSn: "left-a",
        dailyAdditions: [
          { day: "2026-08-28", episodes: 10, frames: 36_000, hours: 1 },
          { day: "2026-08-29", episodes: 4, frames: 14_400, hours: 0.4 },
        ],
      }),
      dataset("TacVerse/task-b-0828", {
        leftGripperSn: "left-a",
        dailyAdditions: [
          { day: "2026-08-28", episodes: 5, frames: 18_000, hours: 0.5 },
        ],
      }),
    ];

    expect(workbenchAdditionAvailableDays(datasets)).toEqual([
      "2026-08-28",
      "2026-08-28",
      "2026-08-29",
    ]);
    expect(
      workbenchGroupAdditionDatasetNames(datasets, "left_gripper_sn", {
        startDate: "2026-08-29",
        endDate: "2026-08-30",
      }).get("left-a"),
    ).toEqual(["task-a-0828"]);

    const timeline = computeWorkbenchAdditionTimeline(datasets, {
      startDate: "2026-08-28",
      endDate: "2026-08-30",
    });

    expect(timeline.rows).toEqual([
      expect.objectContaining({
        day: "2026-08-28",
        datasets: 2,
        episodes: 15,
        hours: 1.5,
        cumulativeDatasets: 2,
        cumulativeEpisodes: 15,
      }),
      expect.objectContaining({
        day: "2026-08-29",
        datasets: 1,
        episodes: 4,
        hours: 0.4,
        cumulativeDatasets: 3,
        cumulativeEpisodes: 19,
      }),
    ]);
    expect(timeline.total).toMatchObject({
      datasets: 2,
      episodes: 19,
      hours: 1.9,
    });
  });
});

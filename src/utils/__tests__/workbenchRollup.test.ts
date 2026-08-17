import { describe, expect, test } from "bun:test";
import {
  computeWorkbenchRollup,
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

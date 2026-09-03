import { describe, expect, test } from "bun:test";
import {
  computeWorkbenchAdditionRollup,
  workbenchGroupSourceRepoIds,
  type WorkbenchRollupDataset,
} from "@/utils/workbenchRollup";

function dataset(relativePath: string): WorkbenchRollupDataset {
  return {
    relativePath,
    total_episodes: 10,
    total_frames: 36_000,
    fps: 10,
    robot_type: "g1",
    sizeBytes: 0,
    robotId: "robot-a",
    dailyAdditions: [
      { day: "2026-09-02", episodes: 10, frames: 36_000, hours: 1 },
    ],
  };
}

describe("Workbench rollups and merged datasets", () => {
  test("does not include merged datasets in Source repos or totals", () => {
    const normal = dataset("TacVerse/taccap-g1-arrange-desk-items-0902");
    const merged = dataset(
      "TacVerse/merged/taccap-g1-arrange-desk-items-09902",
    );
    const options = { startDate: "2026-09-02", endDate: "2026-09-03" };

    expect(
      workbenchGroupSourceRepoIds([normal, merged], "robot_id", options).get(
        "robot-a",
      ),
    ).toEqual(["TacVerse/taccap-g1-arrange-desk-items-0902"]);
    expect(
      computeWorkbenchAdditionRollup([normal, merged], "robot_id", options),
    ).toEqual([
      expect.objectContaining({
        group: "robot-a",
        count: 1,
        episodes: 10,
        frames: 36_000,
        hours: 1,
      }),
    ]);
  });
});

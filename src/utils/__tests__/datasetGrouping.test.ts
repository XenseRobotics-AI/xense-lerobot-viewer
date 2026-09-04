import { describe, expect, test } from "bun:test";
import type {
  DatasetIntegrity,
  LocalDatasetSummary,
} from "@/lib/local-datasets-discovery";
import {
  UNGROUPED_PREFIX,
  compareDatasetsBySize,
  getDatasetPrefix,
  getDatasetTaskName,
  groupDatasetsByPrefix,
  rankRobotTypes,
} from "@/utils/datasetGrouping";

const INTEGRITY: Record<DatasetIntegrity["status"], DatasetIntegrity> = {
  ok: { hasData: true, hasVideos: true, hasEpisodes: true, status: "ok" },
  empty: {
    hasData: true,
    hasVideos: true,
    hasEpisodes: false,
    status: "empty",
  },
  incomplete: {
    hasData: false,
    hasVideos: true,
    hasEpisodes: true,
    status: "incomplete",
  },
};

function makeDataset(
  relativePath: string,
  overrides: Partial<LocalDatasetSummary> = {},
): LocalDatasetSummary {
  return {
    relativePath,
    encodedPath: `enc(${relativePath})`,
    codebase_version: "v3.0",
    robot_type: "so101_follower",
    total_episodes: 1,
    total_frames: 100,
    fps: 30,
    sizeBytes: 0,
    thumbnailVideoUrl: null,
    integrity: INTEGRITY.ok,
    tags: { task: null, scene: null, objects: [] },
    ...overrides,
  };
}

describe("getDatasetPrefix", () => {
  test("returns the first path segment", () => {
    expect(getDatasetPrefix("Xense/pack_bottles")).toBe("Xense");
    expect(getDatasetPrefix("TacVerse/a/b/c")).toBe("TacVerse");
  });

  test("falls back to UNGROUPED_PREFIX for single-segment paths", () => {
    expect(getDatasetPrefix("loose_dataset")).toBe(UNGROUPED_PREFIX);
  });
});

describe("getDatasetTaskName", () => {
  test("returns everything after the first segment", () => {
    expect(getDatasetTaskName("Xense/pack_bottles")).toBe("pack_bottles");
    expect(getDatasetTaskName("Xense/nested/task")).toBe("nested/task");
  });

  test("returns the whole path for single-segment paths", () => {
    expect(getDatasetTaskName("loose_dataset")).toBe("loose_dataset");
  });
});

describe("compareDatasetsBySize", () => {
  test("orders by frames descending", () => {
    const sorted = [
      makeDataset("a", { total_frames: 100 }),
      makeDataset("b", { total_frames: 9_000 }),
      makeDataset("c", { total_frames: 500 }),
    ].sort(compareDatasetsBySize);
    expect(sorted.map((d) => d.relativePath)).toEqual(["b", "c", "a"]);
  });

  test("bytes on disk outrank frames", () => {
    // Same frame count, tenfold difference on disk: resolution and camera
    // count are invisible to `total_frames`.
    const sorted = [
      makeDataset("lowres", { total_frames: 10_000, sizeBytes: 1_000_000 }),
      makeDataset("hires", { total_frames: 10_000, sizeBytes: 10_000_000 }),
    ].sort(compareDatasetsBySize);
    expect(sorted.map((d) => d.relativePath)).toEqual(["hires", "lowres"]);
  });

  test("a bigger frame count does not beat a bigger directory", () => {
    const sorted = [
      makeDataset("manyframes", { total_frames: 999_999, sizeBytes: 5_000 }),
      makeDataset("bigondisk", { total_frames: 10, sizeBytes: 9_000_000 }),
    ].sort(compareDatasetsBySize);
    expect(sorted[0].relativePath).toBe("bigondisk");
  });

  test("falls back to frames when sizes are unknown", () => {
    // sizeBytes is 0 for a directory that could not be walked; those must not
    // all collapse to the bottom in path order.
    const sorted = [
      makeDataset("a", { total_frames: 100, sizeBytes: 0 }),
      makeDataset("b", { total_frames: 9_000, sizeBytes: 0 }),
      makeDataset("c", { total_frames: 500, sizeBytes: 0 }),
    ].sort(compareDatasetsBySize);
    expect(sorted.map((d) => d.relativePath)).toEqual(["b", "c", "a"]);
  });

  test("breaks frame ties on episode count, then on path", () => {
    const sorted = [
      makeDataset("z", { total_frames: 0, total_episodes: 2 }),
      makeDataset("a", { total_frames: 0, total_episodes: 2 }),
      makeDataset("m", { total_frames: 0, total_episodes: 40 }),
    ].sort(compareDatasetsBySize);
    expect(sorted.map((d) => d.relativePath)).toEqual(["m", "a", "z"]);
  });
});

describe("groupDatasetsByPrefix", () => {
  test("buckets datasets by prefix and sorts groups largest-first", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/small", { total_frames: 100 }),
      makeDataset("TacVerse/one", { total_frames: 5_000 }),
      makeDataset("Xense/big", { total_frames: 20_000 }),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(["Xense", "TacVerse"]);
    expect(groups[0].datasets.map((d) => d.relativePath)).toEqual([
      "Xense/big",
      "Xense/small",
    ]);
  });

  test("sums bytes per group and ranks the category cards on them", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/a", { total_frames: 900_000, sizeBytes: 1_000 }),
      makeDataset("TacVerse/a", { total_frames: 10, sizeBytes: 4_000 }),
      makeDataset("TacVerse/b", { total_frames: 10, sizeBytes: 5_000 }),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(["TacVerse", "Xense"]);
    expect(groups[0].totalBytes).toBe(9_000);
    expect(groups[1].totalBytes).toBe(1_000);
  });

  test("falls back to episode totals, then prefix, for equal-frame groups", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("B/one", { total_frames: 0, total_episodes: 1 }),
      makeDataset("A/one", { total_frames: 0, total_episodes: 1 }),
      makeDataset("C/one", { total_frames: 0, total_episodes: 9 }),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(["C", "A", "B"]);
  });

  test("aggregates health counts, episodes and frames per group", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/a", {
        total_episodes: 5,
        total_frames: 500,
        integrity: INTEGRITY.ok,
      }),
      makeDataset("Xense/b", {
        total_episodes: 3,
        total_frames: 300,
        integrity: INTEGRITY.incomplete,
      }),
      makeDataset("Xense/c", {
        total_episodes: 0,
        total_frames: 0,
        integrity: INTEGRITY.empty,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].counts).toEqual({ ok: 1, empty: 1, incomplete: 1 });
    expect(groups[0].totalEpisodes).toBe(8);
    expect(groups[0].totalFrames).toBe(800);
  });

  test("picks the first non-null thumbnail as the group art", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/a", { thumbnailVideoUrl: null }),
      makeDataset("Xense/b", { thumbnailVideoUrl: "/api/thumb/b.mp4" }),
      makeDataset("Xense/c", { thumbnailVideoUrl: "/api/thumb/c.mp4" }),
    ]);
    expect(groups[0].thumbnailVideoUrl).toBe("/api/thumb/b.mp4");
  });

  test("group art comes from the largest dataset that has a thumbnail", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/a", {
        total_frames: 100,
        thumbnailVideoUrl: "/api/thumb/a.mp4",
      }),
      makeDataset("Xense/b", { total_frames: 9_000, thumbnailVideoUrl: null }),
      makeDataset("Xense/c", {
        total_frames: 5_000,
        thumbnailVideoUrl: "/api/thumb/c.mp4",
      }),
    ]);
    expect(groups[0].thumbnailVideoUrl).toBe("/api/thumb/c.mp4");
  });

  test("groups single-segment datasets under UNGROUPED_PREFIX", () => {
    const groups = groupDatasetsByPrefix([makeDataset("loose_dataset")]);
    expect(groups[0].prefix).toBe(UNGROUPED_PREFIX);
    expect(groups[0].datasets).toHaveLength(1);
  });

  test("returns an empty array for no datasets", () => {
    expect(groupDatasetsByPrefix([])).toEqual([]);
  });
});

describe("rankRobotTypes", () => {
  test("orders by how many datasets declare each type", () => {
    const datasets = [
      makeDataset("TacVerse/a", { robot_type: "bi_rdt_gripper" }),
      makeDataset("TacVerse/b", { robot_type: "bi_taccap_gripper" }),
      makeDataset("TacVerse/c", { robot_type: "bi_taccap_gripper" }),
      makeDataset("TacVerse/d", { robot_type: "bi_rdt_gripper" }),
      makeDataset("TacVerse/e", { robot_type: "bi_taccap_gripper" }),
    ];
    expect(rankRobotTypes(datasets)).toEqual([
      "bi_taccap_gripper",
      "bi_rdt_gripper",
    ]);
  });

  test("breaks ties on name so the order is stable", () => {
    const datasets = [
      makeDataset("TacVerse/a", { robot_type: "xtac_umi_g1" }),
      makeDataset("TacVerse/b", { robot_type: "bi_rdt_gripper" }),
    ];
    expect(rankRobotTypes(datasets)).toEqual(["bi_rdt_gripper", "xtac_umi_g1"]);
  });

  test("omits datasets with no declared robot type", () => {
    // Absent means "nothing declared" — never a chip reading `unknown`.
    const datasets = [
      makeDataset("TacVerse/a", { robot_type: null }),
      makeDataset("TacVerse/b", { robot_type: "   " }),
      makeDataset("TacVerse/c", { robot_type: "bi_rdt_gripper" }),
    ];
    expect(rankRobotTypes(datasets)).toEqual(["bi_rdt_gripper"]);
  });
});

describe("groupDatasetsByPrefix robot types", () => {
  test("summarises each group's robot types", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("TacVerse/a", { robot_type: "bi_rdt_gripper" }),
      makeDataset("TacVerse/b", { robot_type: "bi_taccap_gripper" }),
      makeDataset("TacVerse/c", { robot_type: "bi_taccap_gripper" }),
      makeDataset("XTac-UMI/d", { robot_type: "xtac_umi_g1" }),
    ]);
    const tacverse = groups.find((g) => g.prefix === "TacVerse");
    expect(tacverse?.robotTypes).toEqual([
      "bi_taccap_gripper",
      "bi_rdt_gripper",
    ]);
    expect(groups.find((g) => g.prefix === "XTac-UMI")?.robotTypes).toEqual([
      "xtac_umi_g1",
    ]);
  });
});

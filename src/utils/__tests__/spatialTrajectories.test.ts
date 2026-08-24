import { describe, expect, test } from "bun:test";
import {
  extractSpatialTrajectory,
  findSpatialAxisGroups,
  spatialLayerFeatureKey,
  spatialPointsPerEpisode,
} from "@/utils/spatialTrajectories";

describe("findSpatialAxisGroups", () => {
  test("finds complete left and right TCP xyz groups", () => {
    const groups = findSpatialAxisGroups("action", [
      "left_tcp.x",
      "left_tcp.y",
      "left_tcp.z",
      "left_tcp.r1",
      "right_tcp.x",
      "right_tcp.y",
      "right_tcp.z",
    ]);

    expect(groups).toEqual([
      {
        id: "action:left_tcp",
        label: "left_tcp",
        indices: [0, 1, 2],
        axisNames: ["left_tcp.x", "left_tcp.y", "left_tcp.z"],
      },
      {
        id: "action:right_tcp",
        label: "right_tcp",
        indices: [4, 5, 6],
        axisNames: ["right_tcp.x", "right_tcp.y", "right_tcp.z"],
      },
    ]);
  });

  test("ignores incomplete and numeric-only groups", () => {
    expect(
      findSpatialAxisGroups("action", ["0", "1", "2", "tcp.x", "tcp.y"]),
    ).toEqual([]);
  });
});

describe("spatial trajectory sampling", () => {
  test("shares the global point budget across every episode and layer", () => {
    expect(spatialPointsPerEpisode(150, 2, 120_000, 240)).toBe(240);
    expect(spatialPointsPerEpisode(1000, 2, 120_000, 240)).toBe(60);
  });

  test("treats the total budget as a real upper bound", () => {
    // 100k episodes cannot be drawn within 120k points: a 2-point floor would
    // emit 400k. Callers cap the episode count instead.
    expect(spatialPointsPerEpisode(100_000, 2, 120_000, 240)).toBe(0);
    expect(spatialPointsPerEpisode(0, 2, 120_000, 240)).toBe(0);
    expect(spatialPointsPerEpisode(10, 0, 120_000, 240)).toBe(0);

    for (const episodes of [1, 10, 400, 60_000]) {
      for (const layers of [1, 2, 4]) {
        const perEpisode = spatialPointsPerEpisode(
          episodes,
          layers,
          120_000,
          240,
        );
        expect(perEpisode * episodes * layers).toBeLessThanOrEqual(120_000);
      }
    }
  });

  test("keeps the first and last positions when downsampling", () => {
    const rows = Array.from({ length: 10 }, (_, index) => [
      index,
      index + 0.1,
      index + 0.2,
    ]);
    const points = extractSpatialTrajectory(
      rows,
      {
        id: "action:tcp",
        label: "tcp",
        indices: [0, 1, 2],
        axisNames: ["tcp.x", "tcp.y", "tcp.z"],
      },
      3,
    );

    expect(points.slice(0, 3)).toEqual([0, 0.1, 0.2]);
    expect(points.slice(-3)).toEqual([9, 9.1, 9.2]);
    expect(points).toHaveLength(9);
  });
});

describe("spatialLayerFeatureKey", () => {
  test("returns the feature half of a layer id", () => {
    expect(spatialLayerFeatureKey("action:left_tcp")).toBe("action");
    expect(spatialLayerFeatureKey("observation.state:head")).toBe(
      "observation.state",
    );
  });

  test("falls back to the whole id when there is no separator", () => {
    expect(spatialLayerFeatureKey("action")).toBe("action");
    expect(spatialLayerFeatureKey(":left_tcp")).toBe(":left_tcp");
  });
});

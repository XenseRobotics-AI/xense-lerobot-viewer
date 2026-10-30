import { describe, expect, test } from "bun:test";
import { readEpisodeWorldFrame } from "@/utils/episodeWorldFrame";

const DEVICES = {
  version: 1,
  episodes: [
    {
      episode_index: 0,
      export: {
        world_frame: "head_yaw_at_episode_start",
        world_anchor: {
          position: [0.541, -0.296, -0.001],
          yaw_deg: -0.1,
          time_ns: 1,
        },
      },
    },
    {
      episode_index: 1,
      export: { world_frame: "recorded", world_anchor: null },
    },
    { episode_index: 2, devices: {} },
    {
      episode_index: 3,
      export: {
        world_frame: "head_yaw_at_episode_start",
        world_anchor: { position: [1, 2] },
      },
    },
  ],
};

describe("readEpisodeWorldFrame", () => {
  test("head-start episodes carry their recorded-world anchor", () => {
    expect(readEpisodeWorldFrame(DEVICES, 0)).toEqual({
      kind: "head-start",
      anchor: { position: [0.541, -0.296, -0.001], yawDeg: -0.1 },
    });
  });

  test("recorded frame and exports without the block are told apart", () => {
    expect(readEpisodeWorldFrame(DEVICES, 1)).toEqual({
      kind: "recorded",
      anchor: null,
    });
    expect(readEpisodeWorldFrame(DEVICES, 2).kind).toBe("unknown");
    expect(readEpisodeWorldFrame(DEVICES, 9).kind).toBe("unknown");
  });

  test("a malformed anchor keeps the frame but drops the anchor", () => {
    expect(readEpisodeWorldFrame(DEVICES, 3)).toEqual({
      kind: "head-start",
      anchor: null,
    });
  });

  test("missing or junk files read as unknown", () => {
    expect(readEpisodeWorldFrame(null, 0).kind).toBe("unknown");
    expect(readEpisodeWorldFrame({ episodes: "x" }, 0).kind).toBe("unknown");
  });

  test("v2 files resolve the shared export and keep the anchor inline", () => {
    const v2 = {
      version: 2,
      exports: {
        export_0: {
          world_frame: "head_yaw_at_episode_start",
          exporter: "taccap-collector",
        },
        export_1: { world_frame: "recorded" },
      },
      episodes: [
        {
          episode_index: 0,
          export: "export_0",
          world_anchor: {
            position: [-0.34, -0.32, 0],
            yaw_deg: 0.3,
            time_ns: 5,
          },
        },
        { episode_index: 1, export: "export_1" },
        { episode_index: 2, export: "export_9" },
      ],
    };
    expect(readEpisodeWorldFrame(v2, 0)).toEqual({
      kind: "head-start",
      anchor: { position: [-0.34, -0.32, 0], yawDeg: 0.3 },
    });
    expect(readEpisodeWorldFrame(v2, 1)).toEqual({
      kind: "recorded",
      anchor: null,
    });
    expect(readEpisodeWorldFrame(v2, 2).kind).toBe("unknown");
  });
});

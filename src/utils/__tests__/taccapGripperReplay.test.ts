import { describe, expect, test } from "bun:test";
import {
  extractTacCapGripperTracks,
  extractTacCapHeadTrack,
  normalizeTacCapGripperOpening,
  sampleTacCapGripperFrame,
  sampleTacCapHeadFrame,
  tacCapGripperSources,
} from "@/utils/taccapGripperReplay";
import {
  resolveTacCapPoseProfile,
  TACCAP_MEASURED_TRACKER_TO_TCP,
  type TacCapExtrinsicsMetadata,
} from "@/utils/taccapPoseSemantics";

function poseRow(
  timestamp: number,
  source: "action" | "observation.state",
  side: "left" | "right",
  x: number,
  gripper: number,
): Record<string, number> {
  const prefix = `${source} | ${side}_tcp`;
  return {
    timestamp,
    [`${prefix}.x`]: x,
    [`${prefix}.y`]: 0,
    [`${prefix}.z`]: 0,
    [`${prefix}.r1`]: 1,
    [`${prefix}.r2`]: 0,
    [`${prefix}.r3`]: 0,
    [`${prefix}.r4`]: 0,
    [`${prefix}.r5`]: 1,
    [`${prefix}.r6`]: 0,
    [`${source} | ${side}_gripper.pos`]: gripper,
  };
}

function headPoseRow(
  timestamp: number,
  source: "action" | "observation.state",
  x: number,
  label = "head",
): Record<string, number> {
  const prefix = `${source} | ${label}`;
  return {
    timestamp,
    [`${prefix}.x`]: x,
    [`${prefix}.y`]: 2,
    [`${prefix}.z`]: 3,
    [`${prefix}.r1`]: 1,
    [`${prefix}.r2`]: 0,
    [`${prefix}.r3`]: 0,
    [`${prefix}.r4`]: 0,
    [`${prefix}.r5`]: 1,
    [`${prefix}.r6`]: 0,
  };
}

describe("TacCap gripper replay", () => {
  test("selects one action track per side ahead of observation.state", () => {
    const rows = [0, 1].map((timestamp) => ({
      ...poseRow(timestamp, "observation.state", "left", timestamp + 10, 0.1),
      ...poseRow(timestamp, "action", "left", timestamp, 0.2),
      ...poseRow(timestamp, "action", "right", timestamp + 2, 0.3),
    }));

    const tracks = extractTacCapGripperTracks(rows);
    expect(tracks.map(({ side, source }) => ({ side, source }))).toEqual([
      { side: "left", source: "action" },
      { side: "right", source: "action" },
    ]);
    expect(tracks[0].gripperKey).toBe("action | left_gripper.pos");
    expect(tacCapGripperSources(rows)).toEqual(["action", "observation.state"]);

    const stateTracks = extractTacCapGripperTracks(rows, "observation.state");
    expect(stateTracks[0].source).toBe("observation.state");
  });

  test("samples link4 pose, rotation, and gripper opening at playback time", () => {
    const rows = [
      poseRow(0, "action", "left", 0, 0.2),
      poseRow(1, "action", "left", 1, 0.8),
    ];
    const [track] = extractTacCapGripperTracks(rows);

    expect(sampleTacCapGripperFrame(track, 0.5)).toEqual({
      side: "left",
      source: "action",
      position: [0.5, 0, 0],
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      opening: 0.5,
    });
  });

  test("extracts and samples an optional head pose independently", () => {
    const rows = [
      {
        ...poseRow(0, "action", "left", 0, 0.2),
        ...headPoseRow(0, "observation.state", 10),
        ...headPoseRow(0, "action", 0),
      },
      {
        ...poseRow(1, "action", "left", 1, 0.8),
        ...headPoseRow(1, "observation.state", 11),
        ...headPoseRow(1, "action", 1),
      },
    ];

    const actionHead = extractTacCapHeadTrack(rows, "action");
    expect(actionHead?.source).toBe("action");
    expect(sampleTacCapHeadFrame(actionHead!, 0.5)).toEqual({
      source: "action",
      position: [0.5, 2, 3],
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    });

    expect(extractTacCapHeadTrack(rows, "observation.state")?.source).toBe(
      "observation.state",
    );
  });

  test("accepts any complete pose label containing head", () => {
    for (const label of ["head_camera", "camera_head"]) {
      const rows = [0, 1].map((timestamp) => ({
        ...poseRow(timestamp, "action", "left", timestamp),
        ...headPoseRow(timestamp, "action", timestamp, label),
      }));

      const track = extractTacCapHeadTrack(rows, "action");
      expect(track?.source).toBe("action");
      expect(track?.pose.label).toBe(label);
      expect(track?.pose.points).toEqual([0, 2, 3, 1, 2, 3]);
    }
  });

  test("does not invent a head trajectory when only gripper poses exist", () => {
    const rows = [
      poseRow(0, "action", "left", 0, 0.2),
      poseRow(1, "action", "left", 1, 0.8),
    ];
    expect(extractTacCapHeadTrack(rows, "action")).toBeNull();
  });

  test("keeps native unit values and scales non-unit encoder ranges", () => {
    expect(normalizeTacCapGripperOpening(0.25, { min: 0.2, max: 0.3 })).toBe(
      0.25,
    );
    expect(normalizeTacCapGripperOpening(50, { min: 0, max: 100 })).toBe(0.5);
    expect(normalizeTacCapGripperOpening(150, { min: 0, max: 100 })).toBe(1);
  });

  test("normalizes a legacy tracker trajectory before playback", () => {
    const rows = [
      poseRow(0, "action", "left", 0, 0.2),
      poseRow(1, "action", "left", 1, 0.8),
    ];
    const metadata: TacCapExtrinsicsMetadata = {
      episodes: [
        {
          episode_index: 0,
          poses_are_ee: true,
          tracker_to_ee: {
            left: {
              position_m: [0, 0, 0],
              quaternion_wxyz: [1, 0, 0, 0],
            },
            right: {
              position_m: [0, 0, 0],
              quaternion_wxyz: [1, 0, 0, 0],
            },
          },
        },
      ],
    };
    const profile = resolveTacCapPoseProfile(metadata, 0, "tracker-to-tcp");
    const [track] = extractTacCapGripperTracks(rows, "action", profile);
    const frame = sampleTacCapGripperFrame(track, 0);

    expect(frame?.position).toEqual([
      ...TACCAP_MEASURED_TRACKER_TO_TCP.left.translation,
    ]);
    frame?.rotation.forEach((value, index) => {
      expect(value).toBeCloseTo(
        TACCAP_MEASURED_TRACKER_TO_TCP.left.rotation[index],
        12,
      );
    });
  });
});

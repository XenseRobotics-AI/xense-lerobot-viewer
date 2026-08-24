import { describe, expect, test } from "bun:test";
import {
  resolveTacCapPoseProfile,
  rotationMatrixTo6d,
  TACCAP_MEASURED_TRACKER_TO_TCP,
  transformTacCapTrackerPose,
  type TacCapExtrinsicsMetadata,
} from "@/utils/taccapPoseSemantics";

const identityExtrinsics: TacCapExtrinsicsMetadata = {
  version: 3,
  episodes: [
    {
      episode_index: 4,
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

describe("TacCap pose semantics", () => {
  test("keeps datasets without Collector metadata in canonical TCP mode", () => {
    expect(resolveTacCapPoseProfile(null, 89)).toEqual({
      mode: "canonical-tcp",
      correctionSource: "none",
      reason: "selected-tcp",
      corrections: { left: null, right: null },
    });
  });

  test("allows manually declaring recorded poses as canonical TCP", () => {
    expect(
      resolveTacCapPoseProfile(identityExtrinsics, 4, "canonical-tcp"),
    ).toEqual({
      mode: "canonical-tcp",
      correctionSource: "none",
      reason: "selected-tcp",
      corrections: { left: null, right: null },
    });
  });

  test("uses measured transforms for a manual Tracker override without metadata", () => {
    const profile = resolveTacCapPoseProfile(null, 89, "tracker-to-tcp");
    expect(profile.mode).toBe("tracker-to-tcp");
    expect(profile.correctionSource).toBe("measured-default");
    expect(profile.reason).toBe("selected-tracker");
    expect(profile.corrections.left).toBe(TACCAP_MEASURED_TRACKER_TO_TCP.left);
    expect(profile.corrections.right).toBe(
      TACCAP_MEASURED_TRACKER_TO_TCP.right,
    );
  });

  test("uses measured mount transforms for a manual Tracker override", () => {
    const profile = resolveTacCapPoseProfile(
      identityExtrinsics,
      4,
      "tracker-to-tcp",
    );
    expect(profile.mode).toBe("tracker-to-tcp");
    expect(profile.correctionSource).toBe("measured-default");
    expect(profile.reason).toBe("selected-tracker");
    expect(profile.corrections.left).toBe(TACCAP_MEASURED_TRACKER_TO_TCP.left);
    expect(profile.corrections.right).toBe(
      TACCAP_MEASURED_TRACKER_TO_TCP.right,
    );
  });

  test("keeps the default as TCP even when metadata contains an extrinsic", () => {
    const metadata: TacCapExtrinsicsMetadata = {
      episodes: [
        {
          episode_index: 0,
          poses_are_ee: true,
          tracker_to_ee: {
            left: {
              position_m: [-0.1, -0.2, 0.03],
              quaternion_wxyz: [0.70710678, 0, 0.70710678, 0],
            },
            right: {
              position_m: [-0.1, 0.2, 0.03],
              quaternion_wxyz: [0.70710678, 0, 0.70710678, 0],
            },
          },
        },
      ],
    };
    expect(resolveTacCapPoseProfile(metadata, 0)).toEqual({
      mode: "canonical-tcp",
      correctionSource: "none",
      reason: "selected-tcp",
      corrections: { left: null, right: null },
    });
  });

  test("matches the downward TCP direction observed in parts_sorting episode 4", () => {
    // action.left_tcp at frame 600 (20 s). Its recorded +X axis points upward
    // because this legacy export stores the physical tracker frame.
    const trackerRotation = [
      -0.5034552813, 0.3262242973, -0.8002161086, -0.178673923, 0.8666588068,
      0.4657453366, 0.8453451395, 0.3774655461, -0.3779898591,
    ] as const;
    const transformed = transformTacCapTrackerPose(
      [0.2713445425, -0.0466772392, -0.5154933333],
      [...trackerRotation],
      TACCAP_MEASURED_TRACKER_TO_TCP.left,
    );

    // First column is the canonical TCP +X direction. Negative world Z means
    // the gripper points down toward the work surface, matching the head video.
    expect(rotationMatrixTo6d(transformed.rotation)[2]).toBeCloseTo(-0.76, 2);
    // The known ~19.4 cm lever arm must also move the TCP origin.
    expect(transformed.position).not.toEqual([
      0.2713445425, -0.0466772392, -0.5154933333,
    ]);
  });
});

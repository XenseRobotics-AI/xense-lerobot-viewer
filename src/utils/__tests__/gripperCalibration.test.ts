import { describe, expect, test } from "bun:test";
import {
  gripperTravelForSide,
  readEpisodeGripperCalibration,
} from "@/utils/gripperCalibration";
import { mapNormalizedGripperToJoint } from "@/utils/urdfGripperMapping";

const SOURCES = {
  gripper_normalization: { per_episode_key: "episodes[].grippers" },
  episodes: [
    {
      episode_index: 0,
      grippers: {
        left_gripper: { closed_deg: -16.55, open_deg: 10.77, travel_rad: 0.476824 },
        right_gripper: { closed_deg: 156.26, open_deg: 182.65, travel_rad: 0.460592 },
      },
    },
    { episode_index: 1, grippers: { left_gripper: { travel_rad: 0.4381 } } },
  ],
};

describe("readEpisodeGripperCalibration", () => {
  test("reads the window of the named episode", () => {
    expect(readEpisodeGripperCalibration(SOURCES, 0)).toEqual({
      left_gripper: { travelRad: 0.476824 },
      right_gripper: { travelRad: 0.460592 },
    });
  });

  test("keys on episode_index, not on array position", () => {
    // The array is written in episode order today; the field is there, so a
    // reordering or a skipped episode must not silently shift the windows.
    const shuffled = { episodes: [...SOURCES.episodes].reverse() };
    expect(readEpisodeGripperCalibration(shuffled, 1)).toEqual({
      left_gripper: { travelRad: 0.4381 },
    });
  });

  test("a dataset from before the block reads as no calibration", () => {
    // Not an error: those datasets fall back to the joint limit, which is the
    // rendering they have always had.
    expect(readEpisodeGripperCalibration({ episodes: [{ episode_index: 0 }] }, 0)).toEqual({});
    expect(readEpisodeGripperCalibration({}, 0)).toEqual({});
    expect(readEpisodeGripperCalibration(null, 0)).toEqual({});
  });

  test("drops values that cannot be a travel", () => {
    const broken = {
      episodes: [
        {
          episode_index: 0,
          grippers: {
            left_gripper: { travel_rad: 0 },
            right_gripper: { travel_rad: "0.47" },
          },
        },
      ],
    };
    expect(readEpisodeGripperCalibration(broken, 0)).toEqual({});
  });

  test("gripperTravelForSide names the stream driving each jaw", () => {
    const windows = readEpisodeGripperCalibration(SOURCES, 0);
    expect(gripperTravelForSide(windows, "left")).toBeCloseTo(0.476824, 9);
    expect(gripperTravelForSide(windows, "right")).toBeCloseTo(0.460592, 9);
    expect(gripperTravelForSide({}, "left")).toBeNull();
    expect(gripperTravelForSide(null, "right")).toBeNull();
  });
});

describe("mapNormalizedGripperToJoint with a calibration window", () => {
  const limit = { lower: 0, upper: 0.7 };

  test("sends 1 to the calibrated window instead of the joint limit", () => {
    // The whole point: the RDT jaw's 0.7 rad is 40.1 deg, the recording's own
    // window is 27.3 deg, and drawing 1 at 0.7 renders it ~45% too far open.
    expect(mapNormalizedGripperToJoint(1, limit, 0.476824)).toBeCloseTo(0.476824, 9);
    expect(mapNormalizedGripperToJoint(0.5, limit, 0.476824)).toBeCloseTo(0.238412, 9);
    expect(mapNormalizedGripperToJoint(0, limit, 0.476824)).toBe(0);
  });

  test("falls back to the joint limit without one", () => {
    expect(mapNormalizedGripperToJoint(1, limit)).toBeCloseTo(0.7, 12);
    expect(mapNormalizedGripperToJoint(1, limit, null)).toBeCloseTo(0.7, 12);
  });

  test("never drives the joint past its own stop", () => {
    // A window wider than the mechanism would put the model through itself.
    expect(mapNormalizedGripperToJoint(1, limit, 1.2)).toBeCloseTo(0.7, 12);
  });

  test("carries the joint's sign", () => {
    const negative = { lower: -0.5047, upper: 0 };
    expect(mapNormalizedGripperToJoint(1, negative, 0.3)).toBeCloseTo(-0.3, 12);
  });
});

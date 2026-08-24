import { describe, expect, test } from "bun:test";
import {
  extractEpisodePoseTrajectories,
  hasEpisodePoseTrajectories,
  locateEpisodePoseTrajectory,
  rotation6dToMatrix,
  sampleEpisodePoseRotation,
  sampleEpisodePoseTrajectory,
} from "@/utils/poseTrajectory3d";

describe("episode 3D pose trajectories", () => {
  test("extracts complete action and state xyz groups", () => {
    const rows = [
      {
        timestamp: 0,
        "action | left_tcp.x": 1,
        "action | left_tcp.y": 2,
        "action | left_tcp.z": 3,
        "observation.state | left_tcp.x": 4,
        "observation.state | left_tcp.y": 5,
        "observation.state | left_tcp.z": 6,
      },
      {
        timestamp: 0.1,
        "action | left_tcp.x": 1.1,
        "action | left_tcp.y": 2.1,
        "action | left_tcp.z": 3.1,
        "observation.state | left_tcp.x": 4.1,
        "observation.state | left_tcp.y": 5.1,
        "observation.state | left_tcp.z": 6.1,
      },
    ];

    expect(extractEpisodePoseTrajectories(rows)).toEqual([
      {
        id: "action:left_tcp",
        source: "action",
        label: "left_tcp",
        axisNames: [
          "action | left_tcp.x",
          "action | left_tcp.y",
          "action | left_tcp.z",
        ],
        points: [1, 2, 3, 1.1, 2.1, 3.1],
        timestamps: [0, 0.1],
      },
      {
        id: "observation.state:left_tcp",
        source: "observation.state",
        label: "left_tcp",
        axisNames: [
          "observation.state | left_tcp.x",
          "observation.state | left_tcp.y",
          "observation.state | left_tcp.z",
        ],
        points: [4, 5, 6, 4.1, 5.1, 6.1],
        timestamps: [0, 0.1],
      },
    ]);
  });

  test("ignores incomplete groups and rows with invalid coordinates", () => {
    const rows = [
      {
        timestamp: 0,
        "action | tcp.x": 1,
        "action | tcp.y": 2,
        "action | tcp.z": 3,
        "action | incomplete.x": 1,
        "action | incomplete.y": 2,
      },
      {
        timestamp: 0.1,
        "action | tcp.x": Number.NaN,
        "action | tcp.y": 2,
        "action | tcp.z": 3,
      },
      {
        timestamp: 0.2,
        "action | tcp.x": 4,
        "action | tcp.y": 5,
        "action | tcp.z": 6,
      },
    ];

    const trajectories = extractEpisodePoseTrajectories(rows);
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].points).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hasEpisodePoseTrajectories(rows)).toBe(true);
    expect(hasEpisodePoseTrajectories([])).toBe(false);
  });

  test("interpolates the playback point and trail", () => {
    const [trajectory] = extractEpisodePoseTrajectories([
      {
        timestamp: 0,
        "action | tcp.x": 0,
        "action | tcp.y": 0,
        "action | tcp.z": 0,
      },
      {
        timestamp: 1,
        "action | tcp.x": 10,
        "action | tcp.y": 20,
        "action | tcp.z": 30,
      },
      {
        timestamp: 2,
        "action | tcp.x": 20,
        "action | tcp.y": 40,
        "action | tcp.z": 60,
      },
    ]);

    expect(sampleEpisodePoseTrajectory(trajectory, 0.5)).toEqual({
      point: [5, 10, 15],
      trailPoints: [0, 0, 0, 5, 10, 15],
    });
    expect(locateEpisodePoseTrajectory(trajectory, 0.5)).toEqual({
      point: [5, 10, 15],
      lowerIndex: 0,
      upperIndex: 1,
      alpha: 0.5,
      completedPointCount: 1,
    });
    expect(locateEpisodePoseTrajectory(trajectory, 1)).toEqual({
      point: [10, 20, 30],
      lowerIndex: 1,
      upperIndex: 1,
      alpha: 0,
      completedPointCount: 2,
    });
    expect(sampleEpisodePoseTrajectory(trajectory, 3)).toEqual({
      point: [20, 40, 60],
      trailPoints: [0, 0, 0, 10, 20, 30, 20, 40, 60],
    });
  });

  test("keeps a right TCP observation available at its exact frame time", () => {
    const [trajectory] = extractEpisodePoseTrajectories([
      {
        timestamp: 54.96666717529297,
        "observation.state | right_tcp.x": 0.4809504747390747,
        "observation.state | right_tcp.y": -0.11116164177656174,
        "observation.state | right_tcp.z": 0.008936967700719833,
      },
      {
        timestamp: 55,
        "observation.state | right_tcp.x": 0.481077641248703,
        "observation.state | right_tcp.y": -0.11074694246053696,
        "observation.state | right_tcp.z": 0.008774032816290855,
      },
      {
        timestamp: 55.03333282470703,
        "observation.state | right_tcp.x": 0.480960875749588,
        "observation.state | right_tcp.y": -0.11005648970603943,
        "observation.state | right_tcp.z": 0.008552470244467258,
      },
    ]);

    expect(trajectory.id).toBe("observation.state:right_tcp");
    expect(sampleEpisodePoseTrajectory(trajectory, 55)?.point).toEqual([
      0.481077641248703, -0.11074694246053696, 0.008774032816290855,
    ]);
  });

  test("keeps six-dimensional rotations aligned with the playback point", () => {
    const [trajectory] = extractEpisodePoseTrajectories([
      {
        timestamp: 0,
        "action | tcp.x": 0,
        "action | tcp.y": 0,
        "action | tcp.z": 0,
        "action | tcp.r1": 1,
        "action | tcp.r2": 0,
        "action | tcp.r3": 0,
        "action | tcp.r4": 0,
        "action | tcp.r5": 1,
        "action | tcp.r6": 0,
      },
      {
        timestamp: 1,
        "action | tcp.x": 1,
        "action | tcp.y": 0,
        "action | tcp.z": 0,
        "action | tcp.r1": 0,
        "action | tcp.r2": 1,
        "action | tcp.r3": 0,
        "action | tcp.r4": -1,
        "action | tcp.r5": 0,
        "action | tcp.r6": 0,
      },
    ]);

    expect(trajectory.rotationValues).toHaveLength(2);
    expect(sampleEpisodePoseRotation(trajectory, 0)).toEqual(
      rotation6dToMatrix([1, 0, 0, 0, 1, 0]),
    );
    expect(sampleEpisodePoseRotation(trajectory, 1)).toEqual(
      rotation6dToMatrix([0, 1, 0, -1, 0, 0]),
    );
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION,
  tacCapDatasetPointToScene,
  tacCapRecordedTcpSceneMatrix,
  tacCapRecordedTcpToRootMatrix,
} from "@/utils/taccapGripperTransforms";

describe("TacCap replay coordinate transforms", () => {
  test("defines matching link4 X/Y axes in both bundled URDFs", () => {
    for (const side of ["left", "right"] as const) {
      const urdf = readFileSync(
        resolve(`public/urdf/taccap-grippers/${side}/gripper.urdf`),
        "utf8",
      );
      const joint4 = urdf.match(/<joint name="joint4"[\s\S]*?<\/joint>/)?.[0];
      expect(joint4).toBeDefined();
      expect(joint4).toContain('rpy="0 0 0"');
    }
  });

  test("keeps the left link4 STL correction on the visual only", () => {
    const urdf = readFileSync(
      resolve("public/urdf/taccap-grippers/left/gripper.urdf"),
      "utf8",
    );
    const link4 = urdf.match(/<link name="link4">[\s\S]*?<\/link>/)?.[0];
    const joint4 = urdf.match(/<joint name="joint4"[\s\S]*?<\/joint>/)?.[0];
    expect(link4).toContain('rpy="0 0 -1.5707963267949"');
    expect(joint4).toContain('rpy="0 0 0"');
  });

  test("maps the world convention to the Three.js Y-up scene", () => {
    expect(tacCapDatasetPointToScene([1, 2, 3])).toEqual([1, 3, -2]);
    expect(
      tacCapRecordedTcpSceneMatrix([1, 2, 3], [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    ).toEqual([1, 0, 0, 1, 0, 0, 1, 3, 0, -1, 0, -2, 0, 0, 0, 1]);
  });

  test("keeps both grippers aligned to the same canonical TCP axes", () => {
    expect(TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION.left[0]).toBeCloseTo(
      TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION.right[0],
      4,
    );
    expect(TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION.left[1]).toBe(0);
    expect(TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION.right[1]).toBe(0);

    for (const side of ["left", "right"] as const) {
      const tcpToRoot = tacCapRecordedTcpToRootMatrix(side);
      // Both rotation blocks are identity, matching the canonical link4 axes
      // now declared by both bundled URDFs.
      expect([
        tcpToRoot[0],
        tcpToRoot[1],
        tcpToRoot[2],
        tcpToRoot[4],
        tcpToRoot[5],
        tcpToRoot[6],
        tcpToRoot[8],
        tcpToRoot[9],
        tcpToRoot[10],
      ]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
  });
});

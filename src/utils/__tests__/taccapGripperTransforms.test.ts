import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION,
  tacCapDatasetPointToScene,
  tacCapRecordedTcpSceneMatrix,
  tacCapRecordedTcpToRootMatrix,
  parseTcpFrameConvention,
  tcpConventionToModelMatrix,
  unrecognizedTcpFrameConvention,
} from "@/utils/taccapGripperTransforms";

const TACCAP_MAX_FINGER_ANGLE_DEGREES = 28.92;
const TACCAP_MAX_FINGER_ANGLE_RADIANS =
  (TACCAP_MAX_FINGER_ANGLE_DEGREES * Math.PI) / 180;

describe("TacCap replay coordinate transforms", () => {
  test("uses joint1 as the drive joint and gives both fingers a 28.92 degree range", () => {
    for (const side of ["left", "right"] as const) {
      const urdf = readFileSync(
        resolve(`public/urdf/taccap-grippers/${side}/gripper.urdf`),
        "utf8",
      );
      const joint1 = urdf.match(/<joint name="joint1"[\s\S]*?<\/joint>/)?.[0];
      const joint2 = urdf.match(/<joint name="joint2"[\s\S]*?<\/joint>/)?.[0];
      const joint1Limit = joint1?.match(
        /<limit lower="([^"]+)" upper="([^"]+)"/,
      );
      const joint2Limit = joint2?.match(
        /<limit lower="([^"]+)" upper="([^"]+)"/,
      );

      expect(joint1).toBeDefined();
      expect(joint2).toBeDefined();
      expect(Number(joint1Limit?.[1])).toBe(0);
      expect(Number(joint1Limit?.[2])).toBeCloseTo(
        TACCAP_MAX_FINGER_ANGLE_RADIANS,
        14,
      );
      expect(joint1).not.toContain("<mimic");
      expect(Number(joint2Limit?.[1])).toBeCloseTo(
        -TACCAP_MAX_FINGER_ANGLE_RADIANS,
        14,
      );
      expect(Number(joint2Limit?.[2])).toBe(0);
      expect(joint2).toContain(
        '<mimic joint="joint1" multiplier="-1" offset="0" />',
      );
    }
  });

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

function multiply4(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    let sum = 0;
    for (let k = 0; k < 4; k += 1) sum += a[row * 4 + k] * b[k * 4 + column];
    return sum;
  });
}

describe("TCP frame convention", () => {
  test("only an exact mirrored-v1 declaration selects the mirrored frame", () => {
    expect(parseTcpFrameConvention("mirrored-v1")).toBe("mirrored-v1");
    expect(parseTcpFrameConvention("same-axes-v0")).toBe("same-axes-v0");
    expect(parseTcpFrameConvention(undefined)).toBe("same-axes-v0");
    expect(parseTcpFrameConvention(null)).toBe("same-axes-v0");
    expect(parseTcpFrameConvention("Mirrored-V1")).toBe("same-axes-v0");
  });

  test("reports a declared value it cannot read, but not a missing key", () => {
    expect(unrecognizedTcpFrameConvention(undefined)).toBeNull();
    expect(unrecognizedTcpFrameConvention(null)).toBeNull();
    expect(unrecognizedTcpFrameConvention("same-axes-v0")).toBeNull();
    expect(unrecognizedTcpFrameConvention("mirrored-v1")).toBeNull();
    expect(unrecognizedTcpFrameConvention("mirrored")).toBe("mirrored");
    expect(unrecognizedTcpFrameConvention("")).toBe("");
    expect(unrecognizedTcpFrameConvention(1)).toBe("1");
  });

  test("leaves the right hand and every legacy dataset untouched", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(tcpConventionToModelMatrix("right", "mirrored-v1")).toEqual(
      identity as never,
    );
    expect(tcpConventionToModelMatrix("left", "same-axes-v0")).toEqual(
      identity as never,
    );
    expect(tcpConventionToModelMatrix("right", "same-axes-v0")).toEqual(
      identity as never,
    );
  });

  test("a mirrored-v1 left pose places the model exactly where its v0 pose did", () => {
    // An arbitrary left-hand rotation in the old convention (about Z then X).
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    const cx = Math.cos(-0.4);
    const sx = Math.sin(-0.4);
    const rz = [c, -s, 0, s, c, 0, 0, 0, 1];
    const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
    const v0 = Array.from({ length: 9 }, (_, index) => {
      const row = Math.floor(index / 3);
      const column = index % 3;
      let sum = 0;
      for (let k = 0; k < 3; k += 1)
        sum += rz[row * 3 + k] * rx[k * 3 + column];
      return sum;
    });
    // R_v1 = R_v0 · diag(1,-1,-1): the second and third columns flip sign,
    // which in 6D is exactly left_tcp.r4..r6.
    const v1 = v0.map((value, index) => (index % 3 === 0 ? value : -value));
    const position = [0.3, -0.1, 0.9] as const;
    const root = tacCapRecordedTcpToRootMatrix("left");

    const legacy = multiply4(
      multiply4(
        tacCapRecordedTcpSceneMatrix(position, v0 as never),
        tcpConventionToModelMatrix("left", "same-axes-v0"),
      ),
      root,
    );
    const mirrored = multiply4(
      multiply4(
        tacCapRecordedTcpSceneMatrix(position, v1 as never),
        tcpConventionToModelMatrix("left", "mirrored-v1"),
      ),
      root,
    );
    mirrored.forEach((value, index) => {
      expect(value).toBeCloseTo(legacy[index], 12);
    });
  });
});

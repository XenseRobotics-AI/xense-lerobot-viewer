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
import { bundledGripperProfile } from "@/utils/bundledGrippers";

const TACCAP_MAX_FINGER_ANGLE_DEGREES = 28.92;
const TACCAP_MAX_FINGER_ANGLE_RADIANS =
  (TACCAP_MAX_FINGER_ANGLE_DEGREES * Math.PI) / 180;

type Origin = { xyz: number[]; rpy: number[] };

function readMasterUrdf(side: "left" | "right"): string {
  return readFileSync(
    resolve(`public${bundledGripperProfile("bi_taccap_gripper")!.urdf(side)}`),
    "utf8",
  );
}

function jointBlock(urdf: string, name: string): string | undefined {
  return urdf.match(new RegExp(`<joint name="${name}"[\\s\\S]*?</joint>`))?.[0];
}

function parseOrigin(attributes: string): Origin {
  const read = (key: string) =>
    (attributes.match(new RegExp(`${key}="([^"]+)"`))?.[1] ?? "0 0 0")
      .trim()
      .split(/\s+/)
      .map(Number);
  return { xyz: read("xyz"), rpy: read("rpy") };
}

function jointOrigin(urdf: string, name: string): Origin {
  const origin = jointBlock(urdf, name)?.match(/<origin ([^>]*)\/>/)?.[1];
  if (!origin) throw new Error(`${name} has no origin`);
  return parseOrigin(origin);
}

/** URDF `<origin>` as a row-major 4×4: `Rz(yaw)·Ry(pitch)·Rx(roll)`. */
function originMatrix({ xyz, rpy }: Origin): number[] {
  const [cr, sr] = [Math.cos(rpy[0]), Math.sin(rpy[0])];
  const [cp, sp] = [Math.cos(rpy[1]), Math.sin(rpy[1])];
  const [cy, sy] = [Math.cos(rpy[2]), Math.sin(rpy[2])];
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    xyz[0],
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    xyz[1],
    -sp,
    cp * sr,
    cp * cr,
    xyz[2],
    0,
    0,
    0,
    1,
  ];
}

describe("TacCap replay coordinate transforms", () => {
  test("drives the right finger and mirrors the left over a 28.92 degree range", () => {
    for (const side of ["left", "right"] as const) {
      const urdf = readMasterUrdf(side);
      const drive = jointBlock(urdf, `${side}_right_joint`);
      const mimic = jointBlock(urdf, `${side}_left_joint`);
      const driveLimit = drive?.match(/<limit lower="([^"]+)" upper="([^"]+)"/);
      const mimicLimit = mimic?.match(/<limit lower="([^"]+)" upper="([^"]+)"/);

      expect(bundledGripperProfile("bi_taccap_gripper")!.driveJoint(side)).toBe(
        `${side}_right_joint`,
      );
      expect(drive).toBeDefined();
      expect(mimic).toBeDefined();
      expect(Number(driveLimit?.[1])).toBe(0);
      expect(Number(driveLimit?.[2])).toBeCloseTo(
        TACCAP_MAX_FINGER_ANGLE_RADIANS,
        14,
      );
      expect(drive).not.toContain("<mimic");
      expect(Number(mimicLimit?.[1])).toBeCloseTo(
        -TACCAP_MAX_FINGER_ANGLE_RADIANS,
        14,
      );
      expect(Number(mimicLimit?.[2])).toBe(0);
      expect(mimic).toContain(
        `<mimic joint="${side}_right_joint" multiplier="-1" offset="0" />`,
      );
    }
  });

  test("takes the root → TCP translation from each URDF's eef joint", () => {
    // The transform is a constant rather than read from the loaded model, so
    // this is what keeps it from drifting off the asset it is applied to.
    for (const side of ["left", "right"] as const) {
      const urdf = readMasterUrdf(side);
      const profile = bundledGripperProfile("bi_taccap_gripper")!;
      expect(urdf).toContain(`<link name="${profile.tcpFrameLink(side)}" />`);
      const eef = jointOrigin(urdf, `${side}_eef_joint`);
      expect(eef.rpy).toEqual([0, 0, 0]);
      expect(eef.xyz).toEqual([
        ...TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION[side],
      ]);
    }
  });

  test("places every mesh where the SolidWorks export it replaced did", () => {
    // The previous assets were the same STLs rooted at their native CAD frame,
    // with root → link4 (the recorded TCP) a pure translation. Re-rooting moved
    // the root, not the gripper: each mesh must still land in the same place
    // relative to the TCP, to within the 0.08 mm the mesh-derived EEF differs
    // from the old link4 origin.
    const solidworksRootToTcp = {
      left: [0.164636788170065, 0, -0.0158499715519367],
      right: [0.164643038155223, 0, -0.01599997155194],
    } as const;
    for (const side of ["left", "right"] as const) {
      const urdf = readMasterUrdf(side);
      const visual = urdf.match(
        /<visual name="[a-z]+_body_visual">\s*<origin ([^>]*)\/>/,
      )?.[1];
      expect(visual).toBeDefined();
      const meshInTcp = multiply4(
        tacCapRecordedTcpToRootMatrix(side),
        originMatrix(parseOrigin(visual!)),
      );
      const [x, y, z] = solidworksRootToTcp[side];
      const legacy = [1, 0, 0, -x, 0, 1, 0, -y, 0, 0, 1, -z, 0, 0, 0, 1];
      meshInTcp.forEach((value, index) => {
        expect(Math.abs(value - legacy[index])).toBeLessThan(1e-4);
      });
    }
  });

  test("maps the world convention to the Three.js Y-up scene", () => {
    expect(tacCapDatasetPointToScene([1, 2, 3])).toEqual([1, 3, -2]);
    expect(
      tacCapRecordedTcpSceneMatrix([1, 2, 3], [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    ).toEqual([1, 0, 0, 1, 0, 0, 1, 3, 0, -1, 0, -2, 0, 0, 0, 1]);
  });

  test("turns the URDF's +Z tool axis onto the recorded TCP's +X", () => {
    for (const side of ["left", "right"] as const) {
      const m = tacCapRecordedTcpToRootMatrix(side);
      // Columns are the root axes in TCP coordinates.
      expect([m[2], m[6], m[10]]).toEqual([1, 0, 0]); // root +Z → TCP +X
      expect([m[1], m[5], m[9]]).toEqual([0, 1, 0]); // root +Y → TCP +Y
      expect([m[0], m[4], m[8]]).toEqual([0, 0, -1]); // root +X → TCP -Z
      // The EEF origin itself maps onto the TCP origin.
      const [tx, ty, tz] = TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION[side];
      for (const row of [0, 1, 2]) {
        const base = row * 4;
        expect(
          m[base] * tx + m[base + 1] * ty + m[base + 2] * tz + m[base + 3],
        ).toBeCloseTo(0, 12);
      }
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

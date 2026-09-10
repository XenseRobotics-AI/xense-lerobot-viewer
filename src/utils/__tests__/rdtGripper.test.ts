import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundledGripperProfile } from "@/utils/bundledGrippers";
import { mapNormalizedGripperToJoint } from "@/utils/urdfGripperMapping";

const URDF = readFileSync(
  resolve("public/urdf/rdt-gripper/gripper.urdf"),
  "utf8",
);

/** The single joint the recorded opening drives; the rest mimic it. */
const DRIVE_JOINT = "R2";
const DRIVE_UPPER = 0.7;

function jointBlock(name: string): string {
  const start = URDF.indexOf(`<joint name="${name}"`);
  expect(start).toBeGreaterThan(-1);
  return URDF.slice(start, URDF.indexOf("</joint>", start));
}

describe("bundled RDT gripper URDF", () => {
  test("is self-contained — no ROS package paths", () => {
    // The whole point of re-exporting the vendor package: runtime loading must
    // not depend on a catkin workspace or on anything outside this repo.
    expect(URDF).not.toContain("package://");
    const meshes = [...URDF.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);
    expect(meshes.length).toBe(15);
    expect(meshes.every((m) => m.startsWith("meshes/"))).toBe(true);
  });

  test("carries the materials the loader needs", () => {
    // URDFLoader overwrites whatever material loadMeshCb sets, so a model
    // without these renders untextured.
    expect(URDF).toContain('<material name="shell">');
    expect(URDF).toContain('<material name="finger">');
  });

  test("drops the simulation-only blocks", () => {
    expect(URDF).not.toContain("<inertial");
    expect(URDF).not.toContain("<collision");
    expect(URDF).not.toContain("<gazebo");
  });

  test(`${DRIVE_JOINT} is the one driven joint`, () => {
    const block = jointBlock(DRIVE_JOINT);
    expect(block).toContain(`lower="0"`);
    expect(block).toContain(`upper="${DRIVE_UPPER}"`);
    expect(block).not.toContain("<mimic");
  });

  test("every other movable joint mimics it, directly or transitively", () => {
    const names = [...URDF.matchAll(/<joint name="([^"]+)" type="([^"]+)"/g)];
    const movable = names.filter(([, , type]) => type !== "fixed");
    // 14 joints, 2 of them fixed (the two pads).
    expect(names.length).toBe(14);
    expect(movable.length).toBe(12);
    for (const [, name] of movable) {
      if (name === DRIVE_JOINT) continue;
      expect(jointBlock(name)).toContain("<mimic");
    }
  });
});

describe("RDT gripper profile", () => {
  const profile = bundledGripperProfile("bi_rdt_gripper");

  test("resolves, and points at the bundled asset", () => {
    expect(profile).not.toBeNull();
    // One file for both arms — the URDF's Left_/Right_ are the two jaws.
    expect(profile!.urdf("left")).toBe("/urdf/rdt-gripper/gripper.urdf");
    expect(profile!.urdf("right")).toBe(profile!.urdf("left"));
    expect(profile!.driveJoint).toBe(DRIVE_JOINT);
  });

  test("its guard link exists in the URDF it loads", () => {
    // The guard only catches loading the wrong file; if it names a link the
    // model does not have, every RDT episode silently renders nothing.
    expect(URDF).toContain(`<link name="${profile!.tcpFrameLink}">`);
  });

  test("places the model root behind the TCP along the approach axis", () => {
    const m = profile!.rootFromTcp("left");
    // Row-major. The recorded TCP is the jaw midpoint, so the body sits behind
    // it: -0.2572 on the TCP frame's +X (forward).
    expect(m[3]).toBeCloseTo(-0.2572, 6);
    expect(m[7]).toBe(0);
    expect(m[11]).toBe(0);
    expect(m.slice(12)).toEqual([0, 0, 0, 1]);
  });

  test("its rotation is a real axis cycle, not the identity", () => {
    // This is what differs from TacCap, whose root->TCP is translation-only.
    // A determinant other than +1 would mirror or squash the model.
    const m = profile!.rootFromTcp("left");
    const r = [
      [m[0], m[1], m[2]],
      [m[4], m[5], m[6]],
      [m[8], m[9], m[10]],
    ];
    const det =
      r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
      r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
      r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    expect(det).toBeCloseTo(1, 12);
    expect(r).not.toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  test("the normalized opening spans the joint's full travel", () => {
    const limit = { lower: 0, upper: DRIVE_UPPER };
    expect(mapNormalizedGripperToJoint(0, limit)).toBe(0);
    expect(mapNormalizedGripperToJoint(0.5, limit)).toBeCloseTo(0.35, 12);
    expect(mapNormalizedGripperToJoint(1, limit)).toBeCloseTo(DRIVE_UPPER, 12);
  });
});

describe("TacCap profile still resolves through the shared path", () => {
  test("keeps its own asset, joint and translation-only transform", () => {
    const profile = bundledGripperProfile("bi_taccap_gripper");
    expect(profile).not.toBeNull();
    expect(profile!.urdf("left")).toBe(
      "/urdf/taccap-grippers/left/gripper.urdf",
    );
    expect(profile!.urdf("right")).toBe(
      "/urdf/taccap-grippers/right/gripper.urdf",
    );
    expect(profile!.driveJoint).toBe("joint1");
    const m = profile!.rootFromTcp("left");
    expect([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
  });

  test("a robot with no bundled model resolves to null", () => {
    expect(bundledGripperProfile("so101_follower")).toBeNull();
    expect(bundledGripperProfile(null)).toBeNull();
  });
});

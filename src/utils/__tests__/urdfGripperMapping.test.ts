import { describe, expect, test } from "bun:test";
import {
  isGripperDriveJoint,
  mapNormalizedGripperToJoint,
} from "@/utils/urdfGripperMapping";

describe("URDF gripper mapping", () => {
  test("identifies supported gripper drive joints", () => {
    expect(isGripperDriveJoint("gripper")).toBe(true);
    expect(isGripperDriveJoint("openarm_left_finger_joint1")).toBe(true);
    expect(isGripperDriveJoint("shoulder_pan")).toBe(false);
    expect(isGripperDriveJoint("openarm_left_finger_joint2")).toBe(false);
  });

  test("maps normalized values to a positive URDF opening limit", () => {
    const limit = { lower: -0.174533, upper: 1.74533 };
    expect(mapNormalizedGripperToJoint(0, limit)).toBe(0);
    expect(mapNormalizedGripperToJoint(0.5, limit)).toBeCloseTo(0.872665);
    expect(mapNormalizedGripperToJoint(1, limit)).toBeCloseTo(1.74533);
  });

  test("supports negative opening directions and clamps normalized input", () => {
    const limit = { lower: -1, upper: 0 };
    expect(mapNormalizedGripperToJoint(0.5, limit)).toBe(-0.5);
    expect(mapNormalizedGripperToJoint(-0.2, limit)).toBe(0);
    expect(mapNormalizedGripperToJoint(1.2, limit)).toBe(-1);
    expect(mapNormalizedGripperToJoint(Number.NaN, limit)).toBe(0);
  });
});

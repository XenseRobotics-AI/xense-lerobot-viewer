import { describe, expect, test } from "bun:test";
import { hasURDFSupport, isG1Robot, isTacCapRobot } from "@/lib/so101-robot";

describe("robot type classification", () => {
  test("routes XTac-UMI G1 types to the custom gripper scene", () => {
    expect(isTacCapRobot("xtac-umi-g1")).toBe(true);
    expect(hasURDFSupport("xtac-umi-g1")).toBe(true);
    // The name still identifies the G1 mounting platform, but TacCap/UMI
    // takes precedence in getRobotConfig and is rendered by the local models.
    expect(isG1Robot("xtac-umi-g1")).toBe(true);
  });

  test("keeps Unitree G1 classification for actual Unitree datasets", () => {
    expect(isTacCapRobot("unitree-g1")).toBe(false);
    expect(isG1Robot("unitree-g1")).toBe(true);
  });
});

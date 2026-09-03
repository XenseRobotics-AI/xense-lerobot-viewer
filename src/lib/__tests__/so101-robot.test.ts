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

  test("accepts either separator spelling of the XTac-UMI type", () => {
    // The local corpus records `xtac_umi_g1`; the hyphenated spelling also
    // exists upstream. Both must reach the local gripper scene, not Unitree's.
    for (const robotType of [
      "xtac_umi_g1",
      "xtac-umi-g1",
      "XTac_UMI_G1",
      "bi_taccap_gripper",
      "bi-taccap-gripper",
    ]) {
      expect(isTacCapRobot(robotType)).toBe(true);
      expect(hasURDFSupport(robotType)).toBe(true);
    }
  });

  test("keeps Unitree G1 classification for actual Unitree datasets", () => {
    expect(isTacCapRobot("unitree-g1")).toBe(false);
    expect(isG1Robot("unitree-g1")).toBe(true);
  });
});

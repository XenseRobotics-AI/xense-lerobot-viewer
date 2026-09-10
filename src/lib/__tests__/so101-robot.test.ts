import { describe, expect, test } from "bun:test";
import {
  hasURDFSupport,
  isG1Robot,
  isRdtGripperRobot,
  isTacCapRobot,
} from "@/lib/so101-robot";

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

describe("isRdtGripperRobot", () => {
  test("recognises the RDT gripper, in any separator spelling", () => {
    for (const spelling of [
      "bi_rdt_gripper",
      "bi-rdt-gripper",
      "BI_RDT_GRIPPER",
      "bi rdt gripper",
    ]) {
      expect(isRdtGripperRobot(spelling)).toBe(true);
    }
  });

  test("does not collide with TacCap", () => {
    // The two share a state layout and a replay path but load different
    // models, so a name that matched both would silently pick whichever
    // predicate `bundledGripperProfile` happens to test first.
    expect(isRdtGripperRobot("bi_taccap_gripper")).toBe(false);
    expect(isRdtGripperRobot("xtac_umi_g1")).toBe(false);
    expect(isTacCapRobot("bi_rdt_gripper")).toBe(false);
  });

  test("is null- and nonsense-safe", () => {
    expect(isRdtGripperRobot(null)).toBe(false);
    expect(isRdtGripperRobot("")).toBe(false);
    expect(isRdtGripperRobot("so101_follower")).toBe(false);
  });

  test("the RDT gripper now gets a 3D Replay tab", () => {
    // hasURDFSupport is what episode-viewer gates the tab on. Before the model
    // was bundled this was deliberately false; CLAUDE.md said so.
    expect(hasURDFSupport("bi_rdt_gripper")).toBe(true);
  });
});

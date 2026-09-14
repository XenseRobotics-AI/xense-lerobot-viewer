import type { Matrix4Elements } from "@/utils/taccapGripperTransforms";
import {
  TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION,
  tacCapRecordedTcpToRootMatrix,
} from "@/utils/taccapGripperTransforms";
import type { TacCapSide } from "@/utils/taccapGripperReplay";
import { isRdtGripperRobot, isTacCapRobot } from "@/lib/so101-robot";

/**
 * The handheld grippers whose 3D replay is driven by project-local URDFs rather
 * than by the shared HF bucket.
 *
 * These robots have no arm: what is recorded is a `{side}_tcp` pose plus a
 * normalized `{side}_gripper.pos`, so the viewer places a gripper model at each
 * recorded TCP and drives one joint. That is a different code path from the
 * generic `RobotScene`, which maps dataset columns onto a full kinematic chain.
 *
 * This profile is what keeps that path from being TacCap-shaped. Everything the
 * path needs to know about a particular gripper lives here; the replay data
 * pipeline in `taccapGripperReplay.ts` needs nothing, because it keys entirely
 * off the `{side}_tcp.*` / `{side}_gripper.pos` feature names that both rigs
 * happen to share.
 */
export type BundledGripperProfile = {
  /** Which URDF to load for a side. TacCap ships two files; RDT ships one. */
  urdf: (side: TacCapSide) => string;
  /** The single joint the normalized opening drives. Its mimics follow. */
  driveJoint: string;
  /**
   * A link that must exist once the URDF is loaded. Purely a guard against
   * loading the wrong file — the transform below is a constant, not read from
   * the model.
   */
  tcpFrameLink: string;
  /**
   * Recorded canonical TCP → model root, row-major. Applied as
   * `robot.matrix = tcpSceneMatrix * rootFromTcp`, so it answers "where does
   * the model root sit, expressed in the TCP frame".
   */
  rootFromTcp: (side: TacCapSide) => Matrix4Elements;
  /**
   * Half-extent added around the recorded trajectory when framing the scene.
   * Scales with the model, so the gripper is not clipped at the grid edge.
   */
  scenePadding: number;
  /**
   * Tint the finger material per side after load, so a gripper reads as the
   * same object as its trail. Null when the URDFs already bake a side colour.
   */
  tintFingersPerSide: boolean;
};

/**
 * RDT jaw midpoint above `base_link`, in metres, at the closed pose.
 *
 * ⚠️ **Derived from the URDF's forward kinematics, not measured.** TacCap's
 * equivalent is a number copied from the collector's `ee_transform.py`; the RDT
 * gripper has no such measurement anywhere — not in `xense-taccap-lerobot`
 * (which does not mention `ctag2f120` at all), not as a `taccap_extrinsics.json`
 * in the RDT datasets, and not beside the raw HDF5 the datasets were converted
 * from.
 *
 * Walking the chain `R2 -> Right_in -> Right_Pad` and its left mirror puts the
 * pads at `z=+0.2572` with a 2 mm gap when `R2=0`, opening to 88 mm at
 * `R2=0.7`. The jaw midpoint is the natural TCP for a parallel gripper, so that
 * is what this is. Replace it the moment a measured value exists.
 */
const RDT_ROOT_TO_TCP_Z = 0.2572;

/**
 * RDT recorded TCP → model root, row-major.
 *
 * Unlike TacCap this is **not** translation-only. The URDF approaches along its
 * own `+Z` and opens along `±X`, while the viewer's canonical TCP frame is
 * `+X forward, +Y left, +Z up`, so the TCP axes expressed in model coordinates
 * are `X_tcp = +Z_model`, `Y_tcp = +X_model`, `Z_tcp = +Y_model` — an axis
 * cycle, determinant +1. Inverting `[R | (0,0,z)]` gives `[Rᵀ | -Rᵀt]`, and
 * `-Rᵀt` is `(-z, 0, 0)`: the root sits `z` behind the TCP along the approach
 * axis, which is the geometry stated plainly.
 *
 * ⚠️ Derived, like the translation above. The rotation is the more fragile
 * half: a wrong axis cycle shows up as a gripper approaching sideways, which is
 * obvious on screen and is a one-constant fix here.
 */
function rdtRootFromTcpMatrix(): Matrix4Elements {
  return [0, 0, 1, -RDT_ROOT_TO_TCP_Z, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
}

const TACCAP_PROFILE: BundledGripperProfile = {
  urdf: (side) => `/urdf/taccap-grippers/${side}/gripper.urdf`,
  driveJoint: "joint1",
  tcpFrameLink: "link4",
  rootFromTcp: (side) => tacCapRecordedTcpToRootMatrix(side),
  // The link4 origin sits about 16.5 cm ahead of base_link.
  scenePadding: 0.2,
  tintFingersPerSide: false,
};

const RDT_PROFILE: BundledGripperProfile = {
  // One file for both arms: `Left_*` / `Right_*` in this URDF are the two jaws
  // of a single gripper, not two arms, so the same model is instantiated twice.
  urdf: () => "/urdf/rdt-gripper/gripper.urdf",
  driveJoint: "R2",
  tcpFrameLink: "Left_Pad_Link",
  rootFromTcp: rdtRootFromTcpMatrix,
  // Taller than TacCap: the jaws sit ~25.7 cm from the root, against ~16.5 cm.
  scenePadding: 0.3,
  tintFingersPerSide: true,
};

/**
 * The bundled-gripper profile for a robot type, or null when the robot is not
 * one of them (and so goes through the generic `RobotScene` path instead).
 *
 * Must agree with `hasURDFSupport`: a robot whose 3D tab is shown but that
 * resolves to neither a profile nor a bucket URDF would call
 * `URDFLoader.load("")`.
 */
export function bundledGripperProfile(
  robotType: string | null,
): BundledGripperProfile | null {
  if (isTacCapRobot(robotType)) return TACCAP_PROFILE;
  if (isRdtGripperRobot(robotType)) return RDT_PROFILE;
  return null;
}

export { RDT_ROOT_TO_TCP_Z, TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION };

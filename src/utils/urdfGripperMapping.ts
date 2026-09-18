export type UrdfJointLimit = {
  lower: number;
  upper: number;
};

export function isGripperDriveJoint(jointName: string): boolean {
  const lower = jointName.toLowerCase();
  return (
    lower === "gripper" ||
    lower.endsWith("_gripper") ||
    lower.includes("finger_joint1")
  );
}

/**
 * Map a normalized opening command onto the drive joint.
 *
 * Without a calibration window, 1 goes to the URDF limit farthest from zero —
 * the jaw's mechanical maximum. That is only right if the recording's 1 meant
 * "mechanically wide open", and on the RDT rig it does not: see
 * `@/utils/gripperCalibration`. Given `calibratedTravel`, 1 goes there instead,
 * still clamped to the joint's own stop so a stray number cannot drive the
 * model past its mechanism, and still carrying the joint's sign so a
 * negative-travel joint opens the way it is built to.
 */
export function mapNormalizedGripperToJoint(
  value: number,
  limit: UrdfJointLimit,
  calibratedTravel?: number | null,
): number {
  const normalized = Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
  if (!Number.isFinite(limit.lower) || !Number.isFinite(limit.upper)) {
    return normalized;
  }

  const maximumOpening =
    Math.abs(limit.upper) >= Math.abs(limit.lower) ? limit.upper : limit.lower;
  if (normalized === 0) return 0;
  if (
    typeof calibratedTravel === "number" &&
    Number.isFinite(calibratedTravel) &&
    calibratedTravel > 0
  ) {
    const travel = Math.min(calibratedTravel, Math.abs(maximumOpening));
    return Math.sign(maximumOpening) * normalized * travel;
  }
  return normalized * maximumOpening;
}

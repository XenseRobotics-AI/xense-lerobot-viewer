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

/** Map a normalized opening command to the URDF limit farthest from zero. */
export function mapNormalizedGripperToJoint(
  value: number,
  limit: UrdfJointLimit,
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
  return normalized * maximumOpening;
}

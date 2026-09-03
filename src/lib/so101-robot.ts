export function isSO101Robot(robotType: string | null): boolean {
  if (!robotType) return false;
  const lower = robotType.toLowerCase();
  return (
    lower.includes("so100") ||
    lower.includes("so101") ||
    lower === "so_follower"
  );
}

export function isOpenArmRobot(robotType: string | null): boolean {
  if (!robotType) return false;
  return robotType.toLowerCase().includes("openarm");
}

export function isG1Robot(robotType: string | null): boolean {
  if (!robotType) return false;
  const lower = robotType.toLowerCase();
  return lower.includes("g1") || lower.includes("unitree");
}

export function isTacCapRobot(robotType: string | null): boolean {
  if (!robotType) return false;
  // XTac-UMI is a G1-mounted UMI gripper. Its type name contains `g1`, but
  // it must use the project-local UMI gripper scene rather than Unitree's
  // full-body URDF. Keep the explicit legacy TacCap spelling as well.
  //
  // Match on a separator-stripped form: recordings in the wild spell the same
  // robot `xtac-umi-g1` and `xtac_umi_g1` (the on-disk corpus uses the
  // underscored one), and a spelling that misses here silently falls through
  // to the Unitree full-body URDF, which is the wrong scene entirely.
  const normalized = robotType.toLowerCase().replace(/[-_\s]+/g, "");
  return (
    normalized.includes("bitaccapgripper") || normalized.includes("xtacumi")
  );
}

export function hasURDFSupport(robotType: string | null): boolean {
  return (
    isSO101Robot(robotType) ||
    isOpenArmRobot(robotType) ||
    isG1Robot(robotType) ||
    isTacCapRobot(robotType)
  );
}

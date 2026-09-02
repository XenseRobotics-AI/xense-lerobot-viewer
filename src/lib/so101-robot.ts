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
  const lower = robotType.toLowerCase();
  // XTac-UMI is a G1-mounted UMI gripper. Its type name contains `g1`, but
  // it must use the project-local UMI gripper scene rather than Unitree's
  // full-body URDF. Keep the explicit legacy TacCap spelling as well.
  return lower.includes("bi_taccap_gripper") || lower.includes("xtac-umi");
}

export function hasURDFSupport(robotType: string | null): boolean {
  return (
    isSO101Robot(robotType) ||
    isOpenArmRobot(robotType) ||
    isG1Robot(robotType) ||
    isTacCapRobot(robotType)
  );
}

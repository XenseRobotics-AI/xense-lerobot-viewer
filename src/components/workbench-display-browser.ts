export type WorkbenchFullscreenTarget = {
  requestFullscreen?: () => Promise<void>;
};

export function isWorkbenchOrganizationDisplayPath(pathname: string): boolean {
  if (pathname === "/") return true;

  // The grouping panel is also available inside a local episode's Workbench
  // tab. Keep the entry scoped to that route shape so other episode pages (and
  // arbitrary nested routes) do not gain the organization Display control.
  return /^\/_local\/[^/]+\/episode_\d+\/?$/.test(pathname);
}

export async function requestWorkbenchDisplayFullscreen(
  target: WorkbenchFullscreenTarget,
): Promise<boolean> {
  if (!target.requestFullscreen) return false;
  try {
    await target.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

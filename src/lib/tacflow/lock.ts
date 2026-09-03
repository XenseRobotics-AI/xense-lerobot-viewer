export type ActiveTacFlowRun = {
  label: string;
  startedAt: number;
};

let activeRun: ActiveTacFlowRun | null = null;

export function tryAcquireTacFlowRun(
  label: string,
):
  | { ok: true; run: ActiveTacFlowRun }
  | { ok: false; active: ActiveTacFlowRun } {
  if (activeRun) return { ok: false, active: activeRun };

  activeRun = { label, startedAt: Date.now() };
  return { ok: true, run: activeRun };
}

export function releaseTacFlowRun(run: ActiveTacFlowRun): void {
  if (activeRun === run) activeRun = null;
}

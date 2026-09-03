import WorkbenchRuleBadge from "@/components/workbench-rule-badge";
import type { WorkbenchPersonnelRollup } from "@/types/workbench-personnel.types";
import { formatWorkbenchRewardAmount } from "@/utils/workbenchRewards";

export const WORKBENCH_PERSONNEL_WORKLOAD_COLUMNS = [
  "Personnel",
  "Workstation",
  "Hours",
  "Range target",
  "Rate",
  "Rule",
  "Reward",
] as const;

function formatHours(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

export default function WorkbenchPersonnelWorkload({
  rollup,
}: {
  rollup: WorkbenchPersonnelRollup;
}) {
  return (
    <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Personnel workload
          </h4>
          <p className="mt-1 text-[11px] text-slate-500">
            Daily workstation hours are attributed to every mapped data
            collector in full.
          </p>
        </div>
        <span className="text-[10px] text-slate-500">
          {rollup.rows.length} personnel
        </span>
      </div>
      {rollup.unattributedHours > 0 && (
        <div className="mb-3 rounded-md border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
          Personnel attribution incomplete:{" "}
          {formatHours(rollup.unattributedHours)} h cannot be assigned.
        </div>
      )}
      <div className="overflow-x-auto">
        <table
          aria-label="Personnel workload"
          className="w-full min-w-[900px] border-collapse text-left text-xs"
        >
          <thead className="bg-[var(--surface-2)] text-slate-400">
            <tr>
              {WORKBENCH_PERSONNEL_WORKLOAD_COLUMNS.map((column) => (
                <th key={column} className="px-3 py-2.5 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rollup.rows.length === 0 ? (
              <tr className="border-t border-white/5">
                <td
                  colSpan={WORKBENCH_PERSONNEL_WORKLOAD_COLUMNS.length}
                  className="px-3 py-5 text-center text-slate-500"
                >
                  No personnel mappings are configured.
                </td>
              </tr>
            ) : (
              rollup.rows.map((row) => (
                <tr key={row.personId} className="border-t border-white/5">
                  <td className="px-3 py-2.5 font-medium text-slate-100">
                    {row.personnel}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300">
                    {row.workstations.join(", ") || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                    {formatHours(row.hours)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                    {formatHours(row.targetHours)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                    {formatRate(row.ratePercent)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-300">
                    <WorkbenchRuleBadge
                      label={row.rule}
                      symbol={row.reward.symbol}
                    />
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 tabular-nums">
                    {formatWorkbenchRewardAmount(row.reward.amount)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-white/10 bg-white/[0.02]">
              <td
                colSpan={6}
                className="px-3 py-2.5 text-right font-medium text-slate-300"
              >
                Personnel bonus total
              </td>
              <td className="px-3 py-2.5 font-semibold text-slate-100 tabular-nums">
                {formatWorkbenchRewardAmount(rollup.totalBonus)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

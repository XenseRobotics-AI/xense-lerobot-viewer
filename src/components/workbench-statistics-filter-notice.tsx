import type { WorkbenchStatisticsFilterSummary } from "@/utils/workbenchStatisticsFilter";
import { WORKBENCH_STATISTICS_FILTER_RULE } from "@/utils/workbenchStatisticsFilter";

const EMPTY_FILTER: WorkbenchStatisticsFilterSummary = {
  rule: WORKBENCH_STATISTICS_FILTER_RULE,
  excludedDatasets: [],
};

export default function WorkbenchStatisticsFilterNotice({
  filter = EMPTY_FILTER,
}: {
  filter?: WorkbenchStatisticsFilterSummary;
}) {
  const excluded = filter.excludedDatasets;

  return (
    <section
      aria-label="Workbench statistics filter"
      className="rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs text-amber-100"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium text-amber-200">Statistics scope</div>
          <p className="mt-1 max-w-4xl text-amber-100/75">{filter.rule}</p>
        </div>
        <span className="shrink-0 rounded-full border border-amber-300/25 px-2 py-1 text-[10px] tabular-nums text-amber-200">
          {excluded.length.toLocaleString()} excluded
        </span>
      </div>
      {excluded.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-amber-200/90 hover:text-amber-100">
            View excluded datasets
          </summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded border border-amber-300/10 bg-black/10 p-2 font-mono text-[11px] text-amber-100/75">
            {excluded.map((dataset) => (
              <li key={dataset.relativePath}>{dataset.relativePath}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

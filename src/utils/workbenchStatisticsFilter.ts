/**
 * Workbench statistics intentionally exclude post-processing merge outputs.
 *
 * Local storage uses a bucket path such as `TacVerse/merged/<dataset>`, while
 * the source dataset is stored at `TacVerse/<dataset>`. Match the bucket as a
 * complete path segment so a legitimate dataset name containing "merged" is
 * not removed accidentally.
 */
export const WORKBENCH_STATISTICS_FILTER_SEGMENT = "merged";

export const WORKBENCH_STATISTICS_FILTER_RULE =
  "Exclude datasets whose local path contains the exact path segment `merged`; these are post-processing merge outputs and are not included in Workbench statistics.";

export type WorkbenchStatisticsExcludedDataset = Readonly<{
  relativePath: string;
  reason: "post-processing-merged-output";
}>;

export type WorkbenchStatisticsFilterSummary = Readonly<{
  rule: string;
  excludedDatasets: readonly WorkbenchStatisticsExcludedDataset[];
}>;

export function isWorkbenchStatisticsExcludedDataset(
  relativePath: string,
): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .some(
      (segment) =>
        segment.trim().toLocaleLowerCase() ===
        WORKBENCH_STATISTICS_FILTER_SEGMENT,
    );
}

export function createWorkbenchStatisticsFilterSummary(
  datasets: readonly { relativePath: string }[],
): WorkbenchStatisticsFilterSummary {
  const excludedDatasets = datasets
    .filter((dataset) =>
      isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
    )
    .map((dataset) => ({
      relativePath: dataset.relativePath,
      reason: "post-processing-merged-output" as const,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    rule: WORKBENCH_STATISTICS_FILTER_RULE,
    excludedDatasets,
  };
}

export function filterWorkbenchStatisticsDatasets<
  T extends { relativePath: string },
>(
  datasets: readonly T[],
): {
  included: T[];
  excluded: T[];
  summary: WorkbenchStatisticsFilterSummary;
} {
  const included: T[] = [];
  const excluded: T[] = [];
  for (const dataset of datasets) {
    (isWorkbenchStatisticsExcludedDataset(dataset.relativePath)
      ? excluded
      : included
    ).push(dataset);
  }

  return {
    included,
    excluded,
    summary: createWorkbenchStatisticsFilterSummary(excluded),
  };
}

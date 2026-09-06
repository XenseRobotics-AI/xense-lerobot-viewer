import type {
  TacverseHubCategoryCounts,
  TacverseHubCategoryFilter,
} from "@/utils/workbenchHubCategory";

export type TacverseLocalStatus = "downloaded" | "incomplete" | "missing";
export type TacverseIssuesStatus = "ok" | "warn" | "fail";
export type TacverseDatasetSort = "updated" | "created";
export type TacverseDatasetRowType = "dataset" | "folder" | "child";
export type TacverseMetricsState = "ok" | "partial" | "unavailable";

export type TacverseDatasetStatisticsRow = {
  rowType: TacverseDatasetRowType;
  repoId: string;
  hubRepoId: string;
  hubPath: string | null;
  hubUrl: string;
  name: string;
  robotType: string | null;
  robotTypes: string[];
  episodes: number | null;
  frames: number | null;
  hours: number | null;
  metricsState: TacverseMetricsState;
  categoryWarning: string | null;
  localStatus: TacverseLocalStatus;
  issuesStatus: TacverseIssuesStatus;
  createdAt: string | null;
  lastModified: string | null;
  downloads: number | null;
  children: TacverseDatasetStatisticsRow[];
};

export type TacverseDatasetStatisticsResponse = {
  organization: "TacVerse";
  refreshedAt: string | null;
  categoryFilter: TacverseHubCategoryFilter;
  hubTotal: number;
  categoryTotal: number;
  categoryCounts: TacverseHubCategoryCounts;
  datasets: TacverseDatasetStatisticsRow[];
  catalogFailures?: Array<{ repoId?: string; error?: string }>;
  error?: string;
};

export type TacverseDatasetStatisticsSummary = {
  datasets: number;
  episodes: number;
  frames: number;
  hours: number;
  issues: number;
  downloads: number;
};

function finiteNonNegative(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function summarizeTacverseDatasetStatistics(
  rows: readonly TacverseDatasetStatisticsRow[],
  hubTotal = rows.length,
): TacverseDatasetStatisticsSummary {
  return {
    datasets: hubTotal,
    episodes: rows.reduce(
      (sum, row) => sum + finiteNonNegative(row.episodes),
      0,
    ),
    frames: rows.reduce((sum, row) => sum + finiteNonNegative(row.frames), 0),
    hours: rows.reduce((sum, row) => sum + finiteNonNegative(row.hours), 0),
    issues: rows.filter((row) => row.issuesStatus !== "ok").length,
    downloads: rows.reduce(
      (sum, row) => sum + finiteNonNegative(row.downloads),
      0,
    ),
  };
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sortTacverseDatasetStatistics(
  rows: readonly TacverseDatasetStatisticsRow[],
  sort: TacverseDatasetSort,
): TacverseDatasetStatisticsRow[] {
  const field = sort === "created" ? "createdAt" : "lastModified";
  return rows
    .map((row, index) => ({ row, index, time: timestamp(row[field]) }))
    .sort((left, right) => {
      if (left.time === null && right.time === null) {
        return left.index - right.index;
      }
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      return right.time - left.time || left.index - right.index;
    })
    .map(({ row }) => row);
}

export function filterTacverseDatasetStatistics(
  rows: readonly TacverseDatasetStatisticsRow[],
  query: string,
  issuesOnly: boolean,
): TacverseDatasetStatisticsRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (issuesOnly && row.issuesStatus === "ok") return false;
    const searchable = [
      row.repoId,
      row.robotType ?? "",
      ...(row.robotTypes ?? []),
      ...(row.children ?? []).flatMap((child) => [
        child.repoId,
        child.name,
        child.robotType ?? "",
      ]),
    ];
    return (
      !needle ||
      searchable.some((value) => value.toLocaleLowerCase().includes(needle))
    );
  });
}

export function formatRelativeUpdatedAt(
  value: string | null,
  now = Date.now(),
): string {
  const parsed = timestamp(value);
  if (parsed === null) return "—";
  const seconds = Math.round((now - parsed) / 1000);
  const future = seconds < 0;
  const absolute = Math.abs(seconds);
  if (absolute < 60) return future ? "Updated shortly" : "Updated just now";

  const units: Array<[number, string]> = [
    [365 * 24 * 60 * 60, "year"],
    [30 * 24 * 60 * 60, "month"],
    [7 * 24 * 60 * 60, "week"],
    [24 * 60 * 60, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  const [unitSeconds, unit] =
    units.find(([threshold]) => absolute >= threshold) ?? units.at(-1)!;
  const amount = Math.max(1, Math.round(absolute / unitSeconds));
  const label = `${amount} ${unit}${amount === 1 ? "" : "s"}`;
  return future ? `Updated in about ${label}` : `Updated about ${label} ago`;
}

export function fullTimestamp(value: string | null): string | undefined {
  const parsed = timestamp(value);
  return parsed === null ? undefined : new Date(parsed).toISOString();
}

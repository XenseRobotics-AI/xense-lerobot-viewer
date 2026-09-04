import path from "node:path";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { getDatasetPrefix } from "@/utils/datasetGrouping";
import { isWorkbenchStatisticsExcludedDataset } from "@/utils/workbenchStatisticsFilter";
import type { WorkbenchTacFlowScoreLedgerEntry } from "@/types/workbench-score.types";
import {
  workbenchDayKey,
  workbenchDatasetSuffixDay,
} from "@/utils/workbenchRollup";

export type WorkbenchScoreDatasetMetadata = {
  lastModified?: string | null;
  repoId?: string | null;
};

export function normalizeWorkbenchScoreOrganization(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const org = value.trim();
  if (
    !org ||
    org.length > 128 ||
    org.includes("/") ||
    org.includes("\\") ||
    org.includes("..")
  )
    return null;
  return org;
}

export function normalizeWorkbenchScoreDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(trimmed)
    ? trimmed
    : /^(\d{4}-\d{2}-\d{2})T(?:\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u.exec(
        trimmed,
      )?.[1];
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.toISOString().slice(0, 10) === day ? day : null;
}

export function scoreDatasetDay(
  dataset: Pick<LocalDatasetSummary, "relativePath">,
  metadata: WorkbenchScoreDatasetMetadata | undefined,
  fallbackDay: string,
): string | null {
  return (
    workbenchDatasetSuffixDay(dataset.relativePath, metadata?.lastModified) ??
    workbenchDayKey(metadata?.lastModified) ??
    workbenchDatasetSuffixDay(dataset.relativePath, fallbackDay + "T00:00:00Z")
  );
}

export function selectWorkbenchDatasetsForScore(
  datasets: readonly LocalDatasetSummary[],
  organization: string,
  startDate: string,
  endDate: string,
  metadataByPath: ReadonlyMap<
    string,
    WorkbenchScoreDatasetMetadata
  > = new Map(),
): LocalDatasetSummary[] {
  return datasets
    .filter(
      (dataset) => getDatasetPrefix(dataset.relativePath) === organization,
    )
    .filter(
      (dataset) => !isWorkbenchStatisticsExcludedDataset(dataset.relativePath),
    )
    .filter((dataset) => {
      const day = scoreDatasetDay(
        dataset,
        metadataByPath.get(dataset.relativePath),
        startDate,
      );
      return Boolean(day && day >= startDate && day < endDate);
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function resolveWorkbenchDatasetAbsolutePath(
  root: string,
  relativePath: string,
): string | null {
  const segments = relativePath.split(/[\\/]+/u);
  if (
    !relativePath.trim() ||
    path.isAbsolute(relativePath) ||
    /^[A-Za-z]:[\\/]/u.test(relativePath) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    return null;
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...segments);
  const relative = path.relative(rootPath, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  return target;
}

export function isWorkbenchTacFlowScoreCacheHit(
  entry: WorkbenchTacFlowScoreLedgerEntry | undefined,
  fingerprint: string,
  tacflowVersion: string,
  weights: Readonly<Record<string, number>>,
): boolean {
  return Boolean(
    entry?.status === "scored" &&
    entry.datasetFingerprint === fingerprint &&
    entry.tacflowVersion === tacflowVersion &&
    normalizedWeightsEqual(entry.checkWeights, weights),
  );
}

export function normalizedWeightsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

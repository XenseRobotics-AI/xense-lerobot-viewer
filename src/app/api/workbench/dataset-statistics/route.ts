import fs from "node:fs/promises";
import path from "node:path";
import {
  readRawHfCatalog,
  type HfCatalogEntry,
  type HfCatalogFolderChild,
} from "@/lib/hf-catalog-cache";
import {
  discoverLocalDatasets,
  type LocalDatasetSummary,
} from "@/lib/local-datasets-discovery";
import { bucketOf } from "@/lib/dataset-facets";
import {
  DEFAULT_DATASET_QUALITY_CONFIG,
  runDatasetChecks,
} from "@/utils/datasetQualityChecks";
import {
  canonicalTacverseRepoId,
  classifyTacverseHubRepository,
  countTacverseHubCategories,
  EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
  hubRepoIdForLocalDatasetPath,
  isTacverseHubCategoryFilter,
  matchesTacverseHubCategory,
  type TacverseHubCategoryFilter,
  type TacverseHubClassificationInput,
} from "@/utils/workbenchHubCategory";
import type {
  TacverseDatasetStatisticsResponse,
  TacverseDatasetStatisticsRow,
  TacverseIssuesStatus,
  TacverseLocalStatus,
  TacverseMetricsState,
} from "@/utils/tacverseDatasetStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORGANIZATION = "TacVerse" as const;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeChildPath(value: unknown): string | null {
  const pathValue = stringOrNull(value);
  return pathValue &&
    !pathValue.startsWith(".") &&
    !pathValue.includes("/") &&
    !pathValue.includes("\\") &&
    pathValue !== ".."
    ? pathValue
    : null;
}

function hubUrl(repoId: string, childPath: string | null = null): string {
  const encodedRepo = repoId.split("/").map(encodeURIComponent).join("/");
  if (!childPath) return `https://huggingface.co/datasets/${encodedRepo}`;
  const encodedPath = childPath.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/datasets/${encodedRepo}/tree/main/${encodedPath}`;
}

function categoryInput(
  entry: HfCatalogEntry & { repoId: string },
): TacverseHubClassificationInput {
  return {
    repoId: entry.repoId,
    robotType: stringOrNull(entry.robotType),
    layout: stringOrNull(entry.layout),
    children: Array.isArray(entry.children) ? entry.children : null,
  };
}

function folderRepoIds(
  entries: readonly (HfCatalogEntry & { repoId: string })[],
): Set<string> {
  return new Set(
    entries
      .filter(
        (entry) =>
          classifyTacverseHubRepository(categoryInput(entry)).category ===
          "folder",
      )
      .map((entry) => entry.repoId),
  );
}

function localRank(dataset: LocalDatasetSummary): number {
  if (dataset.integrity.status === "ok") return 0;
  if (dataset.integrity.status === "empty") return 1;
  return 2;
}

function localDatasetsByRepo(
  datasets: readonly LocalDatasetSummary[],
  folders: ReadonlySet<string>,
): Map<string, LocalDatasetSummary> {
  const output = new Map<string, LocalDatasetSummary>();
  for (const dataset of datasets) {
    const repoId = hubRepoIdForLocalDatasetPath(
      dataset.relativePath,
      ORGANIZATION,
      folders,
    );
    if (!repoId) continue;
    const current = output.get(repoId);
    if (!current || localRank(dataset) < localRank(current)) {
      output.set(repoId, dataset);
    }
  }
  return output;
}

async function directLocalRepoNames(root: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(path.join(root, ORGANIZATION), {
      withFileTypes: true,
    });
    return new Set(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            bucketOf(`${ORGANIZATION}/${entry.name}`) === null,
        )
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function localStatus(
  local: LocalDatasetSummary | undefined,
  directCopyExists: boolean,
): TacverseLocalStatus {
  if (local) {
    return local.integrity.status === "ok" ? "downloaded" : "incomplete";
  }
  return directCopyExists ? "incomplete" : "missing";
}

function metricState(values: readonly (number | null)[]): TacverseMetricsState {
  const known = values.filter((value) => value !== null).length;
  if (known === 0) return "unavailable";
  return known === values.length ? "ok" : "partial";
}

function issuesStatus(
  entry: HfCatalogEntry,
  status: TacverseLocalStatus,
  episodes: number | null,
  hours: number | null,
  metricsState: TacverseMetricsState,
  categoryWarning: string | null,
  runTaccapQualityChecks: boolean,
): TacverseIssuesStatus {
  if (status !== "downloaded") return "fail";
  if (
    metricsState !== "ok" ||
    categoryWarning ||
    entry.metadataState === "error" ||
    entry.metadataState === "partial"
  ) {
    return "warn";
  }
  if (!runTaccapQualityChecks) return "ok";
  const quality = runDatasetChecks(
    {
      dataset_name: stringOrNull(entry.repoId),
      total_episodes: episodes,
      duration_hours: hours,
      tasks: null,
    },
    DEFAULT_DATASET_QUALITY_CONFIG,
  );
  if (quality.aggregate.n_fail > 0) return "fail";
  if (quality.aggregate.n_warn > 0) return "warn";
  return "ok";
}

function childRow(
  parent: HfCatalogEntry & { repoId: string },
  child: HfCatalogFolderChild,
  local: LocalDatasetSummary | undefined,
): TacverseDatasetStatisticsRow | null {
  const childPath = safeChildPath(child.path) ?? safeChildPath(child.name);
  if (!childPath) return null;
  const episodes = finiteNonNegative(child.totalEpisodes);
  const frames = finiteNonNegative(child.totalFrames);
  const fps = finiteNonNegative(child.fps);
  const explicitHours = finiteNonNegative(child.durationHours);
  const hours =
    explicitHours ??
    (frames !== null && fps !== null && fps > 0 ? frames / fps / 3600 : null);
  const state =
    child.metadataState === "error"
      ? "unavailable"
      : metricState([episodes, frames, hours]);
  const status = localStatus(local, false);
  return {
    rowType: "child",
    repoId: `${parent.repoId}/${childPath}`,
    hubRepoId: parent.repoId,
    hubPath: childPath,
    hubUrl: hubUrl(parent.repoId, childPath),
    name: stringOrNull(child.name) ?? childPath,
    robotType: stringOrNull(child.robotType),
    robotTypes: stringOrNull(child.robotType)
      ? [stringOrNull(child.robotType)!]
      : [],
    episodes,
    frames,
    hours,
    metricsState: state,
    categoryWarning:
      child.metadataState === "error"
        ? (stringOrNull(child.metadataError) ??
          "Child metadata is unavailable.")
        : null,
    localStatus: status,
    issuesStatus:
      status !== "downloaded" ? "fail" : state === "ok" ? "ok" : "warn",
    createdAt: stringOrNull(parent.createdAt),
    lastModified: stringOrNull(parent.lastModified),
    downloads: null,
    children: [],
  };
}

function aggregate(
  rows: readonly TacverseDatasetStatisticsRow[],
  field: "episodes" | "frames" | "hours",
): number | null {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is number => value !== null);
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function folderStatus(
  children: readonly TacverseDatasetStatisticsRow[],
  directCopyExists: boolean,
): TacverseLocalStatus {
  if (
    children.length > 0 &&
    children.every((child) => child.localStatus === "downloaded")
  ) {
    return "downloaded";
  }
  if (
    directCopyExists ||
    children.some((child) => child.localStatus !== "missing")
  ) {
    return "incomplete";
  }
  return "missing";
}

function rowFromCatalog(
  entry: HfCatalogEntry & { repoId: string },
  localByRepo: ReadonlyMap<string, LocalDatasetSummary>,
  localByPath: ReadonlyMap<string, LocalDatasetSummary>,
  directCopyExists: boolean,
): TacverseDatasetStatisticsRow {
  const classification = classifyTacverseHubRepository(categoryInput(entry));
  const base = {
    hubRepoId: entry.repoId,
    hubPath: null,
    hubUrl: hubUrl(entry.repoId),
    name: entry.repoId.slice(`${ORGANIZATION}/`.length),
    createdAt: stringOrNull(entry.createdAt),
    lastModified: stringOrNull(entry.lastModified),
    downloads: finiteNonNegative(entry.downloads),
  };

  if (classification.category === "folder") {
    const children = (Array.isArray(entry.children) ? entry.children : [])
      .map((child) => {
        const childPath =
          safeChildPath(child.path) ?? safeChildPath(child.name);
        return childRow(
          entry,
          child,
          childPath
            ? localByPath.get(`${entry.repoId}/${childPath}`)
            : undefined,
        );
      })
      .filter((row): row is TacverseDatasetStatisticsRow => row !== null);
    const episodes = aggregate(children, "episodes");
    const frames = aggregate(children, "frames");
    const hours = aggregate(children, "hours");
    const robotTypes = Array.from(
      new Set(
        children
          .map((child) => child.robotType)
          .filter((value): value is string => value !== null),
      ),
    ).sort();
    const status = folderStatus(children, directCopyExists);
    const hasPartialChild = children.some(
      (child) => child.metricsState !== "ok",
    );
    const state: TacverseMetricsState =
      children.length === 0 ||
      [episodes, frames, hours].every((v) => v === null)
        ? "unavailable"
        : hasPartialChild
          ? "partial"
          : "ok";
    return {
      rowType: "folder",
      repoId: entry.repoId,
      ...base,
      robotType: robotTypes.length === 1 ? robotTypes[0] : null,
      robotTypes,
      episodes,
      frames,
      hours,
      metricsState: state,
      categoryWarning: null,
      localStatus: status,
      issuesStatus:
        status !== "downloaded" ? "fail" : state === "ok" ? "ok" : "warn",
      children,
    };
  }

  const episodes = finiteNonNegative(entry.totalEpisodes);
  const frames = finiteNonNegative(entry.totalFrames);
  const fps = finiteNonNegative(entry.fps);
  const explicitHours = finiteNonNegative(entry.durationHours);
  const hours =
    explicitHours ??
    (frames !== null && fps !== null && fps > 0 ? frames / fps / 3600 : null);
  const state =
    entry.metadataState === "error"
      ? "unavailable"
      : metricState([episodes, frames, hours]);
  const status = localStatus(localByRepo.get(entry.repoId), directCopyExists);
  const robotType = stringOrNull(entry.robotType);
  return {
    rowType: "dataset",
    repoId: entry.repoId,
    ...base,
    robotType,
    robotTypes: robotType ? [robotType] : [],
    episodes,
    frames,
    hours,
    metricsState: state,
    categoryWarning: classification.warning,
    localStatus: status,
    issuesStatus: issuesStatus(
      entry,
      status,
      episodes,
      hours,
      state,
      classification.warning,
      classification.category === "taccap-g1",
    ),
    children: [],
  };
}

function categoryFromRequest(
  request: Request,
): { ok: true; value: TacverseHubCategoryFilter } | { ok: false } {
  const value = new URL(request.url).searchParams.get("category");
  if (value === null) return { ok: true, value: "all" };
  return isTacverseHubCategoryFilter(value)
    ? { ok: true, value }
    : { ok: false };
}

export async function GET(request: Request): Promise<Response> {
  const category = categoryFromRequest(request);
  if (!category.ok) {
    return Response.json(
      {
        error:
          "category must be one of: all, taccap-g1, xtac-umi-g1, taccap-g1-merged, folder, other.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const discovery = await discoverLocalDatasets();
    let catalog;
    try {
      catalog = await readRawHfCatalog(discovery.root, ORGANIZATION);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const empty: TacverseDatasetStatisticsResponse = {
        organization: ORGANIZATION,
        refreshedAt: null,
        categoryFilter: category.value,
        hubTotal: 0,
        categoryTotal: 0,
        categoryCounts: EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
        datasets: [],
      };
      return Response.json(empty, {
        headers: { "cache-control": "no-store" },
      });
    }

    const catalogEntries = (
      Array.isArray(catalog.datasets) ? catalog.datasets : []
    ).filter(
      (entry): entry is HfCatalogEntry & { repoId: string } =>
        canonicalTacverseRepoId(stringOrNull(entry.repoId) ?? "") !== null,
    );
    const categoryCounts = countTacverseHubCategories(
      catalogEntries.map(categoryInput),
    );
    const categoryEntries = catalogEntries.filter((entry) =>
      matchesTacverseHubCategory(categoryInput(entry), category.value),
    );
    const folders = folderRepoIds(catalogEntries);
    const localByRepo = localDatasetsByRepo(discovery.datasets, folders);
    const localByPath = new Map(
      discovery.datasets.map((dataset) => [dataset.relativePath, dataset]),
    );
    const directNames = await directLocalRepoNames(discovery.root);
    const datasets = categoryEntries.map((entry) =>
      rowFromCatalog(
        entry,
        localByRepo,
        localByPath,
        directNames.has(entry.repoId.slice(`${ORGANIZATION}/`.length)),
      ),
    );
    const payload: TacverseDatasetStatisticsResponse = {
      organization: ORGANIZATION,
      refreshedAt: stringOrNull(catalog.refreshedAt),
      categoryFilter: category.value,
      hubTotal: catalogEntries.length,
      categoryTotal: categoryEntries.length,
      categoryCounts,
      datasets,
      catalogFailures: Array.isArray(catalog.failures)
        ? (catalog.failures as Array<{ repoId?: string; error?: string }>)
        : [],
    };
    return Response.json(payload, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load TacVerse dataset statistics.",
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

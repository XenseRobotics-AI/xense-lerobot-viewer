import fs from "node:fs/promises";
import path from "node:path";
import { readRawHfCatalog, type HfCatalogEntry } from "@/lib/hf-catalog-cache";
import { readRawModelScopeCatalog } from "@/lib/modelscope-catalog-cache";
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
  canonicalHubDatasetPath,
  canonicalTacverseRepoId,
  classifyTacverseHubRepository,
  countTacverseHubCategories,
  EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
  hubRepoIdForLocalDatasetPath,
  isTacverseHubCategorySelection,
  parseTacverseHubCategorySelection,
  matchesTacverseHubCategory,
  type TacverseHubCategorySelection,
  type TacverseHubClassificationInput,
} from "@/utils/workbenchHubCategory";
import type {
  TacverseDatasetStatisticsResponse,
  TacverseDatasetStatisticsRow,
  TacverseDatasetStatisticsSource,
  TacverseDatasetStatisticsSourceSelection,
  TacverseIssuesStatus,
  TacverseLocalStatus,
  TacverseMetricsState,
} from "@/utils/tacverseDatasetStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORGANIZATION = "TacVerse" as const;
const CATALOG_SOURCES: readonly TacverseDatasetStatisticsSource[] = [
  "huggingface",
  "modelscope",
];

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
    pathValue !== ".." &&
    !["data", "videos", "meta"].includes(pathValue)
    ? pathValue
    : null;
}

function hubUrl(
  source: TacverseDatasetStatisticsSource,
  repoId: string,
  childPath: string | null = null,
  remoteRepoId: string | null = null,
): string {
  const encodedRepo = (remoteRepoId ?? repoId)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const base =
    source === "modelscope"
      ? `https://modelscope.cn/datasets/${encodedRepo}`
      : `https://huggingface.co/datasets/${encodedRepo}`;
  if (!childPath) return base;
  const encodedPath = childPath.split("/").map(encodeURIComponent).join("/");
  const branch = source === "modelscope" ? "master" : "main";
  return `${base}/tree/${branch}/${encodedPath}`;
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
  datasetRepoIds: ReadonlySet<string>,
): Map<string, LocalDatasetSummary> {
  const output = new Map<string, LocalDatasetSummary>();
  for (const dataset of datasets) {
    const repoId = hubRepoIdForLocalDatasetPath(
      dataset.relativePath,
      ORGANIZATION,
      folders,
      datasetRepoIds,
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

function rowFromCatalog(
  entry: HfCatalogEntry & { repoId: string },
  source: TacverseDatasetStatisticsSource,
  localByRepo: ReadonlyMap<string, LocalDatasetSummary>,
  localByPath: ReadonlyMap<string, LocalDatasetSummary>,
  directCopyExists: boolean,
): TacverseDatasetStatisticsRow {
  const classification = classifyTacverseHubRepository(categoryInput(entry));
  const remoteRepoId =
    source === "modelscope"
      ? (stringOrNull(entry.hubRepoId) ?? entry.repoId)
      : entry.repoId;
  const remotePath =
    source === "modelscope" ? stringOrNull(entry.hubPath) : null;
  const base = {
    hubRepoId: remoteRepoId,
    hubPath: remotePath,
    hubUrl: hubUrl(source, entry.repoId, remotePath, remoteRepoId),
    name: entry.repoId.slice(`${ORGANIZATION}/`.length),
    createdAt: stringOrNull(entry.createdAt),
    lastModified: stringOrNull(entry.lastModified),
    downloads: finiteNonNegative(entry.downloads),
  };

  if (classification.category === "folder") {
    const children = (
      Array.isArray(entry.children) ? entry.children : []
    ).flatMap((child) => {
      const childPath = safeChildPath(child.path) ?? safeChildPath(child.name);
      if (!childPath) return [];
      const status = localStatus(
        localByPath.get(`${entry.repoId}/${childPath}`),
        false,
      );
      return [
        {
          source,
          rowType: "child" as const,
          repoId: `${entry.repoId}/${childPath}`,
          hubRepoId: base.hubRepoId,
          hubPath: childPath,
          hubUrl: hubUrl(
            source,
            entry.repoId,
            childPath,
            stringOrNull(entry.hubRepoId),
          ),
          name: childPath,
          robotType: null,
          robotTypes: [],
          episodes: null,
          frames: null,
          hours: null,
          metricsState: "unavailable" as const,
          categoryWarning: null,
          localStatus: status,
          issuesStatus:
            status === "downloaded" ? ("warn" as const) : ("fail" as const),
          createdAt: stringOrNull(entry.createdAt),
          lastModified: stringOrNull(entry.lastModified),
          downloads: null,
          children: [],
        },
      ];
    });
    const status = localStatus(localByRepo.get(entry.repoId), directCopyExists);
    return {
      source,
      rowType: "folder",
      repoId: entry.repoId,
      ...base,
      robotType: null,
      robotTypes: [],
      episodes: null,
      frames: null,
      hours: null,
      metricsState: "unavailable",
      categoryWarning: null,
      localStatus: status,
      issuesStatus: status === "downloaded" ? "warn" : "fail",
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
    source,
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
): { ok: true; value: TacverseHubCategorySelection } | { ok: false } {
  const value = new URL(request.url).searchParams.get("category");
  return isTacverseHubCategorySelection(value)
    ? { ok: true, value: parseTacverseHubCategorySelection(value) }
    : { ok: false };
}

function sourceFromRequest(
  request: Request,
):
  | { ok: true; value: TacverseDatasetStatisticsSourceSelection }
  | { ok: false } {
  const value = request.url
    ? new URL(request.url).searchParams.get("source")
    : null;
  if (!value || value === "huggingface" || value === "hf") {
    return { ok: true, value: "huggingface" };
  }
  if (value === "modelscope" || value === "ms") {
    return { ok: true, value: "modelscope" };
  }
  if (value === "both") return { ok: true, value: "both" };
  return { ok: false };
}

async function readCatalog(
  root: string,
  source: TacverseDatasetStatisticsSource,
) {
  try {
    return source === "modelscope"
      ? await readRawModelScopeCatalog(root, ORGANIZATION)
      : await readRawHfCatalog(root, ORGANIZATION);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function selectedCatalogSources(
  selection: TacverseDatasetStatisticsSourceSelection,
): readonly TacverseDatasetStatisticsSource[] {
  return selection === "both" ? CATALOG_SOURCES : [selection];
}

function latestTimestamp(
  values: readonly (string | null | undefined)[],
): string | null {
  return (
    values
      .filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  );
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
  const source = sourceFromRequest(request);
  if (!source.ok) {
    return Response.json(
      {
        error: "source must be one of: huggingface, modelscope, both.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const discovery = await discoverLocalDatasets();
    const catalogs = (
      await Promise.all(
        selectedCatalogSources(source.value).map(async (catalogSource) => ({
          source: catalogSource,
          catalog: await readCatalog(discovery.root, catalogSource),
        })),
      )
    ).filter(
      (
        item,
      ): item is {
        source: TacverseDatasetStatisticsSource;
        catalog: NonNullable<typeof item.catalog>;
      } => item.catalog !== null,
    );

    if (catalogs.length === 0) {
      const empty: TacverseDatasetStatisticsResponse = {
        organization: ORGANIZATION,
        source: source.value,
        refreshedAt: null,
        refreshedAtBySource: Object.fromEntries(
          selectedCatalogSources(source.value).map((catalogSource) => [
            catalogSource,
            null,
          ]),
        ),
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

    const catalogEntries = catalogs.map(
      ({ source: catalogSource, catalog }) => ({
        source: catalogSource,
        entries: (Array.isArray(catalog.datasets)
          ? catalog.datasets
          : []
        ).flatMap((entry) => {
          const rawRepoId = stringOrNull(entry.repoId) ?? "";
          const repoId =
            catalogSource === "modelscope"
              ? canonicalHubDatasetPath(rawRepoId, ORGANIZATION)
              : canonicalTacverseRepoId(rawRepoId);
          return repoId ? [{ ...entry, repoId }] : [];
        }),
      }),
    );
    const categoryCounts = { ...EMPTY_TACVERSE_HUB_CATEGORY_COUNTS };
    for (const { entries } of catalogEntries) {
      const counts = countTacverseHubCategories(entries.map(categoryInput));
      for (const key of Object.keys(categoryCounts) as Array<
        keyof typeof categoryCounts
      >) {
        categoryCounts[key] += counts[key];
      }
    }
    const categoryEntries = catalogEntries.flatMap(
      ({ source: catalogSource, entries }) =>
        entries
          .filter((entry) =>
            matchesTacverseHubCategory(categoryInput(entry), category.value),
          )
          .map((entry) => ({ source: catalogSource, entry })),
    );
    const folders = new Set(
      catalogEntries.flatMap(({ entries }) => [...folderRepoIds(entries)]),
    );
    const datasetRepoIds = new Set(
      catalogEntries.flatMap(({ entries }) =>
        entries.map((entry) => entry.repoId),
      ),
    );
    const localByRepo = localDatasetsByRepo(
      discovery.datasets,
      folders,
      datasetRepoIds,
    );
    const localByPath = new Map(
      discovery.datasets.map((dataset) => [dataset.relativePath, dataset]),
    );
    const directNames = await directLocalRepoNames(discovery.root);
    const datasets = categoryEntries.map(({ source: catalogSource, entry }) =>
      rowFromCatalog(
        entry,
        catalogSource,
        localByRepo,
        localByPath,
        directNames.has(entry.repoId.slice(`${ORGANIZATION}/`.length)),
      ),
    );
    const refreshedAtBySource = Object.fromEntries(
      catalogs.map(({ source: catalogSource, catalog }) => [
        catalogSource,
        stringOrNull(catalog.refreshedAt),
      ]),
    ) as Partial<Record<TacverseDatasetStatisticsSource, string | null>>;
    const failures = catalogs.flatMap(({ source: catalogSource, catalog }) =>
      (Array.isArray(catalog.failures) ? catalog.failures : []).map(
        (failure) => ({ ...failure, source: catalogSource }),
      ),
    );
    const payload: TacverseDatasetStatisticsResponse = {
      organization: ORGANIZATION,
      source: source.value,
      refreshedAt: latestTimestamp(Object.values(refreshedAtBySource)),
      refreshedAtBySource,
      categoryFilter: category.value,
      hubTotal: catalogEntries.reduce(
        (total, { entries }) => total + entries.length,
        0,
      ),
      categoryTotal: categoryEntries.length,
      categoryCounts,
      datasets,
      catalogFailures: failures,
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

import path from "node:path";
import { readCorpusHistory } from "@/lib/corpus-history-store";
import { readDatasetTasks } from "@/lib/dataset-quality-loader";
import { readRawHfCatalog, type HfCatalogEntry } from "@/lib/hf-catalog-cache";
import {
  readModelScopeDeviceEvidence,
  readRawModelScopeCatalog,
} from "@/lib/modelscope-catalog-cache";
import {
  discoverLocalDatasets,
  hasLocalDatasetInfoField,
} from "@/lib/local-datasets-discovery";
import { EMPTY_TAGS } from "@/lib/dataset-tags";
import { EMPTY_FACETS, type DatasetFacets } from "@/lib/dataset-facets";
import { readWorkbenchConfiguration } from "@/lib/workbench-configuration-store";
import {
  defaultWorkbenchRewardRules,
  readWorkbenchRewardRules,
} from "@/lib/workbench-reward-store";
import { readWorkbenchTacFlowScoreLedger } from "@/lib/workbench-score-ledger";
import type { WorkbenchDatasetScore } from "@/types/workbench-score.types";
import { type DateEvidence } from "@/lib/dataset-facets";
import { WORKBENCH_UPLOADER_NAMES } from "@/utils/workbenchUploaderNames";
import {
  canonicalHubDatasetPath,
  canonicalHubRepoId,
  classifyTacverseHubRepository,
  countTacverseHubCategories,
  EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
  hubRepoIdForLocalDatasetPath,
  isTacverseHubCategorySelection,
  parseTacverseHubCategorySelection,
  matchesTacverseHubCategory,
  type TacverseHubCategoryCounts,
  type TacverseHubCategorySelection,
  type TacverseHubClassificationInput,
} from "@/utils/workbenchHubCategory";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import { computeCorpusStats } from "@/utils/corpusStats";
import {
  computeDailyDelta,
  dayKey,
  snapshotFromSources,
} from "@/utils/corpusHistory";
import {
  getDatasetPrefix,
  groupDatasetsByPrefix,
} from "@/utils/datasetGrouping";
import {
  workbenchDatasetSuffixDay,
  workbenchDatasetSourceKey,
  workbenchDatasetSourceLabel,
  type WorkbenchDailyAddition,
  type WorkbenchDatasetSourceKey,
} from "@/utils/workbenchRollup";
import type {
  TacverseDatasetStatisticsSource,
  TacverseDatasetStatisticsSourceSelection,
} from "@/utils/tacverseDatasetStatistics";
import {
  filterWorkbenchStatisticsDatasets,
  type WorkbenchStatisticsFilterSummary,
} from "@/utils/workbenchStatisticsFilter";
import {
  isWorkbenchReplayDatasetPath,
  workbenchReplayDatasetRank,
} from "@/utils/workbenchReplayDatasets";
import {
  legacyPersonnelConfigFromConfiguration,
  workbenchMappingsFromConfiguration,
} from "@/utils/workbenchConfiguration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkbenchDatasetMetadata = {
  lastModified: string | null;
  uploader: string | null;
  uploaderDisplayName: string | null;
  durationHours: number | null;
  hubStorageBytes: number | null;
};

type WorkbenchDatasetSummary = Awaited<
  ReturnType<typeof discoverLocalDatasets>
>["datasets"][number] & {
  tasks?: Awaited<ReturnType<typeof readDatasetTasks>>;
  hf?: WorkbenchDatasetMetadata;
  lastModified?: string | null;
  uploader?: string | null;
  uploaderDisplayName?: string | null;
  durationHours?: number | null;
  hubStorageBytes?: number | null;
  dailyAdditions?: WorkbenchDailyAddition[];
  tacflowScore?: WorkbenchDatasetScore;
  source?: WorkbenchDatasetSourceKey;
  sourceLabel?: string;
  captureSpan?: { from: string; to: string } | null;
  dateEvidence?: DateEvidence;
  capturedFrom?: string | null;
  capturedTo?: string | null;
  /** True when this row is backed by Hub metadata but not a local download. */
  remoteOnly?: boolean;
};

export type WorkbenchStatisticsResponseFilter =
  WorkbenchStatisticsFilterSummary;

type LocalDataset = Awaited<
  ReturnType<typeof discoverLocalDatasets>
>["datasets"][number];

function metadataFromCatalogEntry(
  entry: HfCatalogEntry | undefined,
): WorkbenchDatasetMetadata {
  const uploader = typeof entry?.uploader === "string" ? entry.uploader : null;
  return {
    lastModified:
      typeof entry?.lastModified === "string" ? entry.lastModified : null,
    uploader,
    uploaderDisplayName:
      typeof entry?.uploaderDisplayName === "string"
        ? entry.uploaderDisplayName
        : uploader
          ? (WORKBENCH_UPLOADER_NAMES[uploader] ?? null)
          : null,
    durationHours:
      typeof entry?.durationHours === "number" &&
      Number.isFinite(entry.durationHours)
        ? entry.durationHours
        : null,
    hubStorageBytes:
      typeof entry?.storageBytes === "number" &&
      Number.isFinite(entry.storageBytes) &&
      entry.storageBytes >= 0
        ? entry.storageBytes
        : null,
  };
}

function catalogTime(entry: HfCatalogEntry | undefined): number {
  const value = entry?.lastModified;
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function latestDataUpdatedAt(
  datasets: readonly WorkbenchDatasetSummary[],
): string | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const dataset of datasets) {
    const parsed = Date.parse(dataset.lastModified ?? "");
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function isTacCapReplayDatasetPath(relativePath: string): boolean {
  return isWorkbenchReplayDatasetPath(relativePath);
}

function isWorkbenchReplayDatasetReady(
  dataset: Pick<WorkbenchDatasetSummary, "integrity">,
): boolean {
  return (
    dataset.integrity.status === "ok" &&
    dataset.integrity.hasData &&
    dataset.integrity.hasVideos
  );
}

function compareWorkbenchReplayDatasets(
  left: Pick<WorkbenchDatasetSummary, "relativePath" | "integrity">,
  right: Pick<WorkbenchDatasetSummary, "relativePath" | "integrity">,
): number {
  return (
    Number(isWorkbenchReplayDatasetReady(right)) -
      Number(isWorkbenchReplayDatasetReady(left)) ||
    workbenchReplayDatasetRank(left.relativePath) -
      workbenchReplayDatasetRank(right.relativePath) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function selectWorkbenchReplayDataset<
  T extends Pick<WorkbenchDatasetSummary, "relativePath" | "integrity">,
>(datasets: readonly T[]): T | null {
  return (
    datasets
      .filter((dataset) => isTacCapReplayDatasetPath(dataset.relativePath))
      .sort(compareWorkbenchReplayDatasets)[0] ?? null
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The Workbench scans local datasets, so local info.json is the authoritative
 * source for recorded totals. The Hub catalog can lag while a dataset is
 * still being uploaded; use it only when local metadata is unavailable.
 */
function localNumberOrRemote(
  dataset: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number],
  field: "total_episodes" | "total_frames" | "total_tasks" | "fps",
  remoteValue: unknown,
  localSource: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number] = dataset,
): number | null {
  const localFieldExists = hasLocalDatasetInfoField(localSource, field);
  const local = localFieldExists ? asNumber(dataset[field]) : null;
  if (local !== null) return local;
  return asNumber(remoteValue);
}

function nonNegativeCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function roundHours(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function datasetHours(
  dataset: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number],
  remote: HfCatalogEntry | undefined,
  localSource: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number] = dataset,
): number {
  const localFrames = localNumberOrRemote(
    dataset,
    "total_frames",
    null,
    localSource,
  );
  const localFps = localNumberOrRemote(dataset, "fps", null, localSource);
  if (
    localFrames !== null &&
    localFrames > 0 &&
    localFps !== null &&
    localFps > 0
  ) {
    return localFrames / localFps / 3600;
  }
  const durationHours = asNumber(remote?.durationHours);
  if (durationHours !== null && durationHours >= 0) return durationHours;
  const frames = localNumberOrRemote(
    dataset,
    "total_frames",
    remote?.totalFrames,
    localSource,
  );
  const fps = localNumberOrRemote(dataset, "fps", remote?.fps, localSource);
  return frames !== null && frames > 0 && fps !== null && fps > 0
    ? frames / fps / 3600
    : 0;
}

function dailyAdditionsForDataset(
  dataset: LocalDataset & { remoteOnly?: boolean },
  remote: HfCatalogEntry | undefined,
  localSource: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number] = dataset,
): WorkbenchDailyAddition[] {
  const suffixDay = workbenchDatasetSuffixDay(
    dataset.relativePath,
    remote?.lastModified,
  );
  // A date suffix is enough to assign a real capture day, but a metadata-only
  // directory without payload must not create production-day additions. A
  // remote-only ModelScope row is the exception: its payload totals come from
  // the repository's meta/info.json and are valid for statistics.
  if (!suffixDay || (!dataset.integrity.hasData && !dataset.remoteOnly)) {
    return [];
  }
  return [
    {
      day: suffixDay,
      episodes: nonNegativeCount(
        localNumberOrRemote(
          dataset,
          "total_episodes",
          remote?.totalEpisodes,
          localSource,
        ),
      ),
      frames: nonNegativeCount(
        localNumberOrRemote(
          dataset,
          "total_frames",
          remote?.totalFrames,
          localSource,
        ),
      ),
      hours: roundHours(datasetHours(dataset, remote, localSource)),
    },
  ];
}

function applyCatalogMetadata(
  dataset: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number],
  remote: HfCatalogEntry | undefined,
  dailyAdditions: WorkbenchDailyAddition[] = [],
  localSource: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number] = dataset,
): WorkbenchDatasetSummary {
  const metadata = metadataFromCatalogEntry(remote);
  const source = workbenchDatasetSourceKey(dataset.relativePath);
  const capturedFrom = dataset.facets.capturedFrom;
  const capturedTo = dataset.facets.capturedTo;
  return {
    ...dataset,
    source,
    sourceLabel: workbenchDatasetSourceLabel(source),
    captureSpan:
      capturedFrom && capturedTo
        ? { from: capturedFrom, to: capturedTo }
        : null,
    dateEvidence: dataset.facets.dateEvidence,
    capturedFrom,
    capturedTo,
    codebase_version: dataset.codebase_version,
    robot_type: dataset.robot_type ?? remote?.robotType ?? null,
    total_episodes:
      localNumberOrRemote(
        dataset,
        "total_episodes",
        remote?.totalEpisodes,
        localSource,
      ) ?? 0,
    total_frames:
      localNumberOrRemote(
        dataset,
        "total_frames",
        remote?.totalFrames,
        localSource,
      ) ?? 0,
    total_tasks:
      localNumberOrRemote(
        dataset,
        "total_tasks",
        remote?.totalTasks,
        localSource,
      ) ?? 0,
    fps: localNumberOrRemote(dataset, "fps", remote?.fps, localSource) ?? 0,
    durationHours: datasetHours(dataset, remote, localSource),
    hubStorageBytes: metadata.hubStorageBytes,
    tasks: dataset.tasks,
    hf: metadata,
    lastModified: metadata.lastModified,
    uploader: metadata.uploader,
    uploaderDisplayName: metadata.uploaderDisplayName,
    dailyAdditions,
  };
}

type WorkbenchHubScope = {
  entries: Map<string, { entry: HfCatalogEntry; rank: number }>;
  modelScopeEntries: Map<string, { entry: HfCatalogEntry; rank: number }>;
  refreshedAt: string | null;
  refreshedAtBySource: Partial<
    Record<TacverseDatasetStatisticsSource, string | null>
  >;
  hubTotal: number;
  categoryTotal: number;
  categoryCounts: TacverseHubCategoryCounts;
  folderRepoIds: Set<string>;
};

function hubCategoryInput(
  entry: HfCatalogEntry & { repoId: string },
): TacverseHubClassificationInput {
  return {
    repoId: entry.repoId,
    robotType: typeof entry.robotType === "string" ? entry.robotType : null,
    layout: typeof entry.layout === "string" ? entry.layout : null,
    children: Array.isArray(entry.children) ? entry.children : null,
  };
}

function mergeCatalogEntries(
  primary: HfCatalogEntry,
  fallback: HfCatalogEntry,
): HfCatalogEntry {
  const merged: HfCatalogEntry = { ...fallback, ...primary };
  const fallbackFields = [
    "createdAt",
    "lastModified",
    "downloads",
    "storageBytes",
    "totalEpisodes",
    "totalFrames",
    "totalTasks",
    "fps",
    "durationHours",
    "robotType",
    "collectorSerialNumber",
    "robotId",
    "leftGripperSn",
    "uploader",
    "uploaderDisplayName",
    "sha",
  ] as const;
  for (const field of fallbackFields) {
    if (merged[field] == null && fallback[field] != null) {
      Object.assign(merged, { [field]: fallback[field] });
    }
  }
  if (
    primary.metadataState === "error" &&
    fallback.metadataState &&
    fallback.metadataState !== "error"
  ) {
    merged.metadataState = fallback.metadataState;
    if (!primary.metadataError) delete merged.metadataError;
  }
  return merged;
}

async function readCatalogByRepo(
  root: string,
  organization: string,
  category: TacverseHubCategorySelection,
  sourceSelection: TacverseDatasetStatisticsSourceSelection,
): Promise<WorkbenchHubScope> {
  const sources: readonly TacverseDatasetStatisticsSource[] =
    sourceSelection === "both"
      ? ["huggingface", "modelscope"]
      : [sourceSelection];
  const catalogs = await Promise.all(
    sources.map(async (source) => {
      try {
        const catalog =
          source === "modelscope"
            ? await readRawModelScopeCatalog(root, organization)
            : await readRawHfCatalog(root, organization);
        return { source, catalog };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return { source, catalog: null };
        }
        throw error;
      }
    }),
  );
  const loadedCatalogs = catalogs.filter(
    (
      item,
    ): item is {
      source: TacverseDatasetStatisticsSource;
      catalog: {
        datasets?: HfCatalogEntry[];
        refreshedAt?: string | null;
      };
    } => item.catalog !== null,
  );
  const categoryCounts = { ...EMPTY_TACVERSE_HUB_CATEGORY_COUNTS };
  const folderRepoIds = new Set<string>();
  const preferredEntries = new Map<
    string,
    { entry: HfCatalogEntry; rank: number }
  >();
  const modelScopeEntries = new Map<
    string,
    { entry: HfCatalogEntry; rank: number }
  >();
  const selectedRepoIds = new Set<string>();
  let hubTotal = 0;
  let categoryTotal = 0;

  // HF is deliberately processed first so `both` keeps its metadata whenever
  // the same repository exists in both catalogs.
  for (const { source, catalog } of loadedCatalogs) {
    const entries = (
      Array.isArray(catalog.datasets) ? catalog.datasets : []
    ).flatMap((entry) => {
      const rawRepoId = String(entry.repoId ?? "");
      const repoId =
        source === "modelscope"
          ? canonicalHubDatasetPath(rawRepoId, organization)
          : canonicalHubRepoId(rawRepoId, organization);
      return repoId ? [{ ...entry, repoId }] : [];
    });
    const counts = countTacverseHubCategories(entries.map(hubCategoryInput));
    for (const key of Object.keys(categoryCounts) as Array<
      keyof typeof categoryCounts
    >) {
      categoryCounts[key] += counts[key];
    }
    hubTotal += entries.length;
    const selectedEntries = entries.filter((entry) =>
      matchesTacverseHubCategory(hubCategoryInput(entry), category),
    );
    categoryTotal += selectedEntries.length;
    for (const entry of entries) {
      if (
        classifyTacverseHubRepository(hubCategoryInput(entry)).category ===
        "folder"
      ) {
        folderRepoIds.add(entry.repoId);
      }
      if (!preferredEntries.has(entry.repoId)) {
        preferredEntries.set(entry.repoId, {
          entry,
          rank: preferredEntries.size,
        });
      } else {
        const preferred = preferredEntries.get(entry.repoId);
        if (preferred) {
          preferred.entry = mergeCatalogEntries(preferred.entry, entry);
        }
      }
    }
    for (const entry of selectedEntries) selectedRepoIds.add(entry.repoId);
    if (source === "modelscope") {
      for (const entry of selectedEntries) {
        const preferred = preferredEntries.get(entry.repoId);
        if (preferred) modelScopeEntries.set(entry.repoId, preferred);
      }
    }
  }

  return {
    entries: new Map(
      [...selectedRepoIds]
        .map((repoId) => {
          const preferred = preferredEntries.get(repoId);
          return preferred ? [repoId, preferred] : null;
        })
        .filter(
          (item): item is [string, { entry: HfCatalogEntry; rank: number }] =>
            item !== null,
        ),
    ),
    modelScopeEntries,
    refreshedAt: latestCatalogTimestamp(
      loadedCatalogs.map(({ catalog }) =>
        typeof catalog.refreshedAt === "string" ? catalog.refreshedAt : null,
      ),
    ),
    refreshedAtBySource: Object.fromEntries(
      sources.map((source) => [
        source,
        loadedCatalogs.find((item) => item.source === source)?.catalog
          .refreshedAt ?? null,
      ]),
    ) as Partial<Record<TacverseDatasetStatisticsSource, string | null>>,
    hubTotal,
    categoryTotal,
    categoryCounts,
    folderRepoIds,
  };
}

function remoteDatasetFacets(relativePath: string): DatasetFacets {
  const leaf =
    relativePath
      .split(/[\\/]+/u)
      .filter(Boolean)
      .at(-1) ?? "";
  const explicit = /-(\d{2})(\d{2})(\d{2})$/u.exec(leaf);
  const monthDay = /-(\d{2})(\d{2})$/u.exec(leaf);
  const match = explicit ?? monthDay;
  if (!match) return { ...EMPTY_FACETS };
  const year = explicit ? 2000 + Number(match[1]) : 2026;
  const month = Number(explicit ? match[2] : match[1]);
  const day = Number(explicit ? match[3] : match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ...EMPTY_FACETS };
  }
  const captureDay = date.toISOString().slice(0, 10);
  return {
    ...EMPTY_FACETS,
    capturedFrom: captureDay,
    capturedTo: captureDay,
    dateEvidence: "name",
  };
}

function remoteOnlyDataset(
  entry: HfCatalogEntry,
): LocalDataset & { remoteOnly: true } {
  const relativePath = String(entry.repoId ?? "");
  const totalEpisodes = asNumber(entry.totalEpisodes) ?? 0;
  const totalFrames = asNumber(entry.totalFrames) ?? 0;
  const totalTasks = asNumber(entry.totalTasks) ?? 0;
  const fps = asNumber(entry.fps) ?? 0;
  const facets = remoteDatasetFacets(relativePath);
  return {
    relativePath,
    encodedPath: encodeLocalDatasetPath(relativePath),
    codebase_version: "remote-meta",
    robot_type: typeof entry.robotType === "string" ? entry.robotType : null,
    collectorSerialNumber:
      typeof entry.collectorSerialNumber === "string"
        ? entry.collectorSerialNumber
        : null,
    robotId: typeof entry.robotId === "string" ? entry.robotId : null,
    leftGripperSn:
      typeof entry.leftGripperSn === "string" ? entry.leftGripperSn : null,
    total_episodes: totalEpisodes,
    total_frames: totalFrames,
    total_tasks: totalTasks,
    fps,
    sizeBytes: 0,
    thumbnailVideoUrl: null,
    integrity: {
      hasData: false,
      hasVideos: false,
      hasEpisodes: totalEpisodes > 0,
      status: "incomplete",
    },
    tags: { ...EMPTY_TAGS },
    facets,
    remoteOnly: true,
  };
}

function latestCatalogTimestamp(
  values: readonly (string | null)[],
): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  );
}

function localDatasetRank(dataset: LocalDataset): number {
  if (dataset.integrity.status === "ok") return 0;
  if (dataset.integrity.status === "empty") return 1;
  return 2;
}

function dedupeLocalDatasetsByRepo(
  datasets: readonly LocalDataset[],
  organization: string,
  folderRepoIds: ReadonlySet<string>,
  datasetRepoIds: ReadonlySet<string>,
): LocalDataset[] {
  const byRepo = new Map<string, LocalDataset>();
  for (const dataset of datasets) {
    const repoId = hubRepoIdForLocalDatasetPath(
      dataset.relativePath,
      organization,
      folderRepoIds,
      datasetRepoIds,
    );
    if (!repoId) continue;
    const current = byRepo.get(repoId);
    if (
      !current ||
      localDatasetRank(dataset) < localDatasetRank(current) ||
      (localDatasetRank(dataset) === localDatasetRank(current) &&
        dataset.relativePath.localeCompare(current.relativePath) < 0)
    ) {
      byRepo.set(repoId, dataset);
    }
  }
  return [...byRepo.values()];
}

function catalogEntryForLocalDataset(
  catalog: Map<string, { entry: HfCatalogEntry; rank: number }>,
  organization: string,
  relativePath: string,
  folderRepoIds: ReadonlySet<string>,
  datasetRepoIds: ReadonlySet<string>,
): { entry: HfCatalogEntry; rank: number } | undefined {
  const repoId = hubRepoIdForLocalDatasetPath(
    relativePath,
    organization,
    folderRepoIds,
    datasetRepoIds,
  );
  if (!repoId) return undefined;
  const matched = catalog.get(repoId);
  // Folder repositories are structural entries for Dataset statistics only.
  return matched?.entry.layout === "folder" ? undefined : matched;
}

/**
 * Read-only corpus summary used exclusively by the viewer's Workbench tab.
 * Keeping it separate from the homepage and the shared local-dataset route
 * prevents the moved UI from changing either surface's existing contract.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const organization = searchParams.get("org")?.trim();
    if (!organization) {
      return Response.json(
        { error: "Workbench statistics requires a dataset organization." },
        { status: 400 },
      );
    }
    const requestedCategory = searchParams.get("category");
    if (!isTacverseHubCategorySelection(requestedCategory)) {
      return Response.json(
        {
          error:
            "category must be a comma-separated selection of: taccap-g1, xtac-umi-g1, taccap-g1-merged, folder, other; or all.",
        },
        { status: 400 },
      );
    }
    const categoryFilter = parseTacverseHubCategorySelection(requestedCategory);
    const requestedSource = searchParams.get("source");
    const source: TacverseDatasetStatisticsSourceSelection | null =
      !requestedSource ||
      requestedSource === "huggingface" ||
      requestedSource === "hf"
        ? "huggingface"
        : requestedSource === "modelscope" || requestedSource === "ms"
          ? "modelscope"
          : requestedSource === "both"
            ? "both"
            : null;
    if (!source) {
      return Response.json(
        {
          error: "source must be one of: huggingface, modelscope, both.",
        },
        { status: 400 },
      );
    }

    const discovery = await discoverLocalDatasets();
    const hubScope = await readCatalogByRepo(
      discovery.root,
      organization,
      categoryFilter,
      source,
    );
    const catalogRepoIds = new Set(hubScope.entries.keys());
    const organizationDatasets = discovery.datasets.filter(
      (dataset) => getDatasetPrefix(dataset.relativePath) === organization,
    );
    const matchedDatasets = organizationDatasets.filter((dataset) =>
      Boolean(
        catalogEntryForLocalDataset(
          hubScope.entries,
          organization,
          dataset.relativePath,
          hubScope.folderRepoIds,
          catalogRepoIds,
        ),
      ),
    );
    const hubScopedDatasets =
      source === "both"
        ? dedupeLocalDatasetsByRepo(
            matchedDatasets,
            organization,
            hubScope.folderRepoIds,
            catalogRepoIds,
          )
        : matchedDatasets;
    const localRepoIds = new Set(
      hubScopedDatasets
        .map((dataset) =>
          hubRepoIdForLocalDatasetPath(
            dataset.relativePath,
            organization,
            hubScope.folderRepoIds,
            catalogRepoIds,
          ),
        )
        .filter((repoId): repoId is string => repoId !== null),
    );
    const modelScopeOnlyDatasets =
      source === "huggingface"
        ? []
        : [...hubScope.modelScopeEntries.entries()]
            .filter(([repoId]) => !localRepoIds.has(repoId))
            .map(([, value]) => remoteOnlyDataset(value.entry));
    const scopedDatasets = [...hubScopedDatasets, ...modelScopeOnlyDatasets];
    const filteredDatasets = filterWorkbenchStatisticsDatasets(scopedDatasets);
    const datasets = filteredDatasets.included;
    const configuration = await readWorkbenchConfiguration(
      organization,
      discovery.root,
      [
        ...organizationDatasets,
        ...(await readModelScopeDeviceEvidence(discovery.root, organization)),
      ],
    );
    const derivedMappings = workbenchMappingsFromConfiguration(
      configuration.config,
    );
    const workstationMappings = {
      org: organization,
      mappings: derivedMappings.mappings,
      legacyMappings: derivedMappings.legacyMappings,
      source:
        configuration.source === "stored"
          ? "stored"
          : (configuration.legacySource ?? "defaults"),
      updatedAt: configuration.updatedAt,
    };
    const rewardRules = await readWorkbenchRewardRules(
      organization,
      discovery.root,
    );
    const personnelConfig = legacyPersonnelConfigFromConfiguration(
      organization,
      configuration.config,
      configuration.updatedAt,
    );
    let scoreEntries = new Map<string, WorkbenchDatasetScore>();
    try {
      const ledger = await readWorkbenchTacFlowScoreLedger(
        organization,
        discovery.root,
      );
      scoreEntries = new Map(
        ledger.entries.map((entry) => [entry.datasetPath, entry]),
      );
    } catch {
      // A corrupt or absent score ledger must not hide Workbench statistics.
    }
    const catalog = hubScope.entries;
    const workbenchDatasets: WorkbenchDatasetSummary[] = await Promise.all(
      datasets.map(async (dataset) => {
        const remote = catalogEntryForLocalDataset(
          catalog,
          organization,
          dataset.relativePath,
          hubScope.folderRepoIds,
          catalogRepoIds,
        )?.entry;
        const withTasks = {
          ...dataset,
          tasks: await readDatasetTasks(
            path.join(discovery.root, ...dataset.relativePath.split("/")),
          ),
        };
        return applyCatalogMetadata(
          withTasks,
          remote,
          dailyAdditionsForDataset(withTasks, remote, dataset),
          dataset,
        );
      }),
    );
    for (const dataset of workbenchDatasets) {
      const score = scoreEntries.get(dataset.relativePath);
      if (score) dataset.tacflowScore = score;
    }
    workbenchDatasets.sort((left, right) => {
      const leftCatalog = catalogEntryForLocalDataset(
        catalog,
        organization,
        left.relativePath,
        hubScope.folderRepoIds,
        catalogRepoIds,
      );
      const rightCatalog = catalogEntryForLocalDataset(
        catalog,
        organization,
        right.relativePath,
        hubScope.folderRepoIds,
        catalogRepoIds,
      );
      if (leftCatalog && rightCatalog) {
        return (
          catalogTime(rightCatalog.entry) - catalogTime(leftCatalog.entry) ||
          leftCatalog.rank - rightCatalog.rank ||
          left.relativePath.localeCompare(right.relativePath)
        );
      }
      if (leftCatalog) return -1;
      if (rightCatalog) return 1;
      return left.relativePath.localeCompare(right.relativePath);
    });
    const replayCandidate = selectWorkbenchReplayDataset(organizationDatasets);
    let displayReplayDataset: WorkbenchDatasetSummary | null =
      selectWorkbenchReplayDataset(workbenchDatasets);
    if (!displayReplayDataset && replayCandidate) {
      const remote = catalogEntryForLocalDataset(
        catalog,
        organization,
        replayCandidate.relativePath,
        hubScope.folderRepoIds,
        catalogRepoIds,
      )?.entry;
      const withTasks = {
        ...replayCandidate,
        tasks: await readDatasetTasks(
          path.join(discovery.root, ...replayCandidate.relativePath.split("/")),
        ),
      };
      displayReplayDataset = applyCatalogMetadata(
        withTasks,
        remote,
        dailyAdditionsForDataset(withTasks, remote, replayCandidate),
        replayCandidate,
      );
    }
    const errors = discovery.errors.filter((entry) =>
      entry.path.split(/[\\/]/).filter(Boolean).includes(organization),
    );
    const stats = computeCorpusStats(groupDatasetsByPrefix(workbenchDatasets));
    const now = new Date();
    const today = snapshotFromSources(stats.segments, now.toISOString());
    const history = await readCorpusHistory(discovery.root || undefined);
    const scopedHistory = {
      ...history,
      days: Object.fromEntries(
        Object.entries(history.days).map(([key, day]) => [
          key,
          {
            ...day,
            sources: Object.fromEntries(
              Object.entries(day.sources).filter(
                ([source]) => source === organization,
              ),
            ),
          },
        ]),
      ),
    };
    const delta = computeDailyDelta(scopedHistory, today, dayKey(now));

    const locallyMatchedRepoIds = new Set<string>();
    for (const dataset of workbenchDatasets) {
      if (dataset.remoteOnly) continue;
      const repoId = hubRepoIdForLocalDatasetPath(
        dataset.relativePath,
        organization,
        hubScope.folderRepoIds,
        catalogRepoIds,
      );
      if (repoId) locallyMatchedRepoIds.add(repoId);
    }

    return Response.json({
      datasets: workbenchDatasets,
      source,
      categoryFilter,
      refreshedAt: hubScope.refreshedAt,
      refreshedAtBySource: hubScope.refreshedAtBySource,
      hubTotal: hubScope.hubTotal,
      categoryTotal: hubScope.categoryTotal,
      categoryCounts: hubScope.categoryCounts,
      localMatchedTotal: locallyMatchedRepoIds.size,
      remoteStatisticsTotal: workbenchDatasets.filter(
        (dataset) => dataset.remoteOnly,
      ).length,
      displayReplayDataset,
      dataUpdatedAt: latestDataUpdatedAt(workbenchDatasets),
      statisticsFilter: filteredDatasets.summary,
      errors,
      delta,
      workstationMappings: {
        ...workstationMappings,
        defaults: workstationMappings.mappings,
        legacyDefaults: workstationMappings.legacyMappings,
      },
      configuration,
      rewardRules,
      rewardRuleDefaults: defaultWorkbenchRewardRules(organization),
      personnelConfig,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load Workbench dataset statistics.",
      },
      { status: 500 },
    );
  }
}

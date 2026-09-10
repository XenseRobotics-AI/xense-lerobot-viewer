import path from "node:path";
import { readCorpusHistory } from "@/lib/corpus-history-store";
import { readDatasetTasks } from "@/lib/dataset-quality-loader";
import { readRawHfCatalog, type HfCatalogEntry } from "@/lib/hf-catalog-cache";
import { discoverLocalDatasets } from "@/lib/local-datasets-discovery";
import {
  defaultWorkbenchWorkstationMappings,
  readWorkbenchWorkstationMappings,
} from "@/lib/workbench-config-store";
import {
  defaultWorkbenchRewardRules,
  readWorkbenchRewardRules,
} from "@/lib/workbench-reward-store";
import { readWorkbenchPersonnelConfig } from "@/lib/workbench-personnel-store";
import { readWorkbenchTacFlowScoreLedger } from "@/lib/workbench-score-ledger";
import type { WorkbenchDatasetScore } from "@/types/workbench-score.types";
import { type DateEvidence } from "@/lib/dataset-facets";
import { WORKBENCH_UPLOADER_NAMES } from "@/utils/workbenchUploaderNames";
import {
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
  getWorkbenchDatasetIdentity,
  type WorkbenchDailyAddition,
  type WorkbenchDatasetSourceKey,
} from "@/utils/workbenchRollup";
import {
  filterWorkbenchStatisticsDatasets,
  type WorkbenchStatisticsFilterSummary,
} from "@/utils/workbenchStatisticsFilter";
import {
  isWorkbenchReplayDatasetPath,
  workbenchReplayDatasetRank,
} from "@/utils/workbenchReplayDatasets";

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
};

export type WorkbenchStatisticsResponseFilter =
  WorkbenchStatisticsFilterSummary;

type NormalizedWorkbenchMappings = {
  mappings: Record<string, string>;
  legacyMappings: Record<string, string>;
};

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
  localValue: unknown,
  remoteValue: unknown,
): number | null {
  const local = asNumber(localValue);
  if (local !== null) return local;
  return asNumber(remoteValue) ?? local;
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
): number {
  const localFrames = asNumber(dataset.total_frames);
  const localFps = asNumber(dataset.fps);
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
  const frames = localNumberOrRemote(dataset.total_frames, remote?.totalFrames);
  const fps = localNumberOrRemote(dataset.fps, remote?.fps);
  return frames !== null && frames > 0 && fps !== null && fps > 0
    ? frames / fps / 3600
    : 0;
}

function dailyAdditionsForDataset(
  dataset: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number],
  remote: HfCatalogEntry | undefined,
): WorkbenchDailyAddition[] {
  const suffixDay = workbenchDatasetSuffixDay(
    dataset.relativePath,
    remote?.lastModified,
  );
  if (!suffixDay) return [];
  if (!getWorkbenchDatasetIdentity(dataset)) return [];
  return [
    {
      day: suffixDay,
      episodes: nonNegativeCount(
        localNumberOrRemote(dataset.total_episodes, remote?.totalEpisodes),
      ),
      frames: nonNegativeCount(
        localNumberOrRemote(dataset.total_frames, remote?.totalFrames),
      ),
      hours: roundHours(datasetHours(dataset, remote)),
    },
  ];
}

function applyCatalogMetadata(
  dataset: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number],
  remote: HfCatalogEntry | undefined,
  dailyAdditions: WorkbenchDailyAddition[] = [],
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
      localNumberOrRemote(dataset.total_episodes, remote?.totalEpisodes) ?? 0,
    total_frames:
      localNumberOrRemote(dataset.total_frames, remote?.totalFrames) ?? 0,
    total_tasks:
      localNumberOrRemote(dataset.total_tasks, remote?.totalTasks) ?? 0,
    fps: localNumberOrRemote(dataset.fps, remote?.fps) ?? 0,
    durationHours: datasetHours(dataset, remote),
    hubStorageBytes: metadata.hubStorageBytes,
    tasks: dataset.tasks,
    hf: metadata,
    lastModified: metadata.lastModified,
    uploader: metadata.uploader,
    uploaderDisplayName: metadata.uploaderDisplayName,
    dailyAdditions,
  };
}

function normalizeWorkbenchMappingsForResponse(
  rawMappings: Record<string, string>,
  datasets: readonly WorkbenchDatasetSummary[],
): NormalizedWorkbenchMappings {
  const collectorSerials = new Set(
    datasets
      .map((dataset) => dataset.collectorSerialNumber?.trim())
      .filter(Boolean) as string[],
  );
  const robotIds = new Set(
    datasets
      .map((dataset) => dataset.robotId?.trim())
      .filter(Boolean) as string[],
  );
  const leftSnToIdentity = new Map<string, string>();
  for (const dataset of datasets) {
    const leftSn = dataset.leftGripperSn?.trim();
    const identity = getWorkbenchDatasetIdentity(dataset);
    if (leftSn && identity) {
      leftSnToIdentity.set(leftSn, identity);
    }
  }

  const normalized = new Map<string, string>();
  const legacy = new Map<string, string>();
  for (const [key, value] of Object.entries(rawMappings)) {
    const identity =
      collectorSerials.has(key) || robotIds.has(key)
        ? key
        : (leftSnToIdentity.get(key) ?? null);
    if (identity) {
      normalized.set(identity, value);
      if (identity !== key || !collectorSerials.has(key)) {
        legacy.set(key, value);
      }
      continue;
    }
    normalized.set(key, value);
    legacy.set(key, value);
  }

  return {
    mappings: Object.fromEntries(normalized.entries()),
    legacyMappings: Object.fromEntries(legacy.entries()),
  };
}

type WorkbenchHubScope = {
  entries: Map<string, { entry: HfCatalogEntry; rank: number }>;
  refreshedAt: string | null;
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

async function readCatalogByRepo(
  root: string,
  organization: string,
  category: TacverseHubCategorySelection,
): Promise<WorkbenchHubScope> {
  try {
    const catalog = await readRawHfCatalog(root, organization);
    const rawEntries = Array.isArray(catalog.datasets) ? catalog.datasets : [];
    const entries = rawEntries.flatMap((entry) => {
      const repoId = canonicalHubRepoId(
        String(entry.repoId ?? ""),
        organization,
      );
      return repoId ? [{ ...entry, repoId }] : [];
    });
    const categoryCounts = countTacverseHubCategories(
      entries.map(hubCategoryInput),
    );
    const folderRepoIds = new Set(
      entries
        .filter(
          (entry) =>
            classifyTacverseHubRepository(hubCategoryInput(entry)).category ===
            "folder",
        )
        .map((entry) => entry.repoId),
    );
    const selectedEntries = entries.filter((entry) =>
      matchesTacverseHubCategory(hubCategoryInput(entry), category),
    );
    return {
      entries: new Map(
        selectedEntries.map((entry, rank) => [entry.repoId, { entry, rank }]),
      ),
      refreshedAt:
        typeof catalog.refreshedAt === "string" ? catalog.refreshedAt : null,
      hubTotal: entries.length,
      categoryTotal: selectedEntries.length,
      categoryCounts,
      folderRepoIds,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        entries: new Map(),
        refreshedAt: null,
        hubTotal: 0,
        categoryTotal: 0,
        categoryCounts: EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
        folderRepoIds: new Set(),
      };
    }
    throw error;
  }
}

function catalogEntryForLocalDataset(
  catalog: Map<string, { entry: HfCatalogEntry; rank: number }>,
  organization: string,
  relativePath: string,
  folderRepoIds: ReadonlySet<string>,
): { entry: HfCatalogEntry; rank: number } | undefined {
  const repoId = hubRepoIdForLocalDatasetPath(
    relativePath,
    organization,
    folderRepoIds,
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

    const discovery = await discoverLocalDatasets();
    const hubScope = await readCatalogByRepo(
      discovery.root,
      organization,
      categoryFilter,
    );
    const organizationDatasets = discovery.datasets.filter(
      (dataset) => getDatasetPrefix(dataset.relativePath) === organization,
    );
    const hubScopedDatasets = organizationDatasets.filter((dataset) =>
      Boolean(
        catalogEntryForLocalDataset(
          hubScope.entries,
          organization,
          dataset.relativePath,
          hubScope.folderRepoIds,
        ),
      ),
    );
    const filteredDatasets =
      filterWorkbenchStatisticsDatasets(hubScopedDatasets);
    const datasets = filteredDatasets.included;
    const workstationMappings = await readWorkbenchWorkstationMappings(
      organization,
      discovery.root,
    );
    const rewardRules = await readWorkbenchRewardRules(
      organization,
      discovery.root,
    );
    const personnelConfig = await readWorkbenchPersonnelConfig(organization);
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
          dailyAdditionsForDataset(withTasks, remote),
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
      );
      const rightCatalog = catalogEntryForLocalDataset(
        catalog,
        organization,
        right.relativePath,
        hubScope.folderRepoIds,
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
        dailyAdditionsForDataset(withTasks, remote),
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
      const repoId = hubRepoIdForLocalDatasetPath(
        dataset.relativePath,
        organization,
        hubScope.folderRepoIds,
      );
      if (repoId) locallyMatchedRepoIds.add(repoId);
    }

    const normalizedStoredMappings = normalizeWorkbenchMappingsForResponse(
      workstationMappings.mappings,
      workbenchDatasets,
    );
    const normalizedDefaultMappings = normalizeWorkbenchMappingsForResponse(
      defaultWorkbenchWorkstationMappings(organization),
      workbenchDatasets,
    );
    return Response.json({
      datasets: workbenchDatasets,
      categoryFilter,
      refreshedAt: hubScope.refreshedAt,
      hubTotal: hubScope.hubTotal,
      categoryTotal: hubScope.categoryTotal,
      categoryCounts: hubScope.categoryCounts,
      localMatchedTotal: locallyMatchedRepoIds.size,
      displayReplayDataset,
      dataUpdatedAt: latestDataUpdatedAt(workbenchDatasets),
      statisticsFilter: filteredDatasets.summary,
      errors,
      delta,
      workstationMappings: {
        ...workstationMappings,
        mappings: normalizedStoredMappings.mappings,
        legacyMappings: normalizedStoredMappings.legacyMappings,
        defaults: normalizedDefaultMappings.mappings,
        legacyDefaults: normalizedDefaultMappings.legacyMappings,
      },
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

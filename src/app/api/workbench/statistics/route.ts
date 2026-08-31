import path from "node:path";
import { readCorpusHistory } from "@/lib/corpus-history-store";
import { readDatasetTasks } from "@/lib/dataset-quality-loader";
import {
  readHfCatalog,
  readHfChangeHistory,
  type HfCatalogEntry,
} from "@/lib/hf-catalog-cache";
import { discoverLocalDatasets } from "@/lib/local-datasets-discovery";
import {
  defaultWorkbenchWorkstationMappings,
  readWorkbenchWorkstationMappings,
} from "@/lib/workbench-config-store";
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
import type { WorkbenchDailyAddition } from "@/utils/workbenchRollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkbenchDatasetMetadata = {
  lastModified: string | null;
  uploader: string | null;
  uploaderDisplayName: string | null;
  durationHours: number | null;
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
  dailyAdditions?: WorkbenchDailyAddition[];
};

function metadataFromCatalogEntry(
  entry: HfCatalogEntry | undefined,
): WorkbenchDatasetMetadata {
  return {
    lastModified:
      typeof entry?.lastModified === "string" ? entry.lastModified : null,
    uploader: typeof entry?.uploader === "string" ? entry.uploader : null,
    uploaderDisplayName:
      typeof entry?.uploaderDisplayName === "string"
        ? entry.uploaderDisplayName
        : null,
    durationHours:
      typeof entry?.durationHours === "number" &&
      Number.isFinite(entry.durationHours)
        ? entry.durationHours
        : null,
  };
}

function catalogTime(entry: HfCatalogEntry | undefined): number {
  const value = entry?.lastModified;
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const durationHours = asNumber(remote?.durationHours);
  if (durationHours !== null && durationHours >= 0) return durationHours;
  const frames = asNumber(remote?.totalFrames) ?? dataset.total_frames;
  const fps = asNumber(remote?.fps) ?? dataset.fps;
  return frames > 0 && fps > 0 ? frames / fps / 3600 : 0;
}

function suffixYear(lastModified: string | null | undefined): number {
  const parsed = Date.parse(lastModified ?? "");
  if (Number.isFinite(parsed)) return new Date(parsed).getUTCFullYear();
  return new Date().getUTCFullYear();
}

function datasetSuffixDay(
  relativePath: string,
  lastModified: string | null | undefined,
): string | null {
  const leaf = relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
  const match = /-(\d{2})(\d{2})$/u.exec(leaf);
  if (!match) return null;
  const year = suffixYear(lastModified);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate.toISOString().slice(0, 10);
}

function dailyAdditionsForDataset(
  dataset: Awaited<
    ReturnType<typeof discoverLocalDatasets>
  >["datasets"][number],
  remote: HfCatalogEntry | undefined,
  changeHistoryAdditions: WorkbenchDailyAddition[] = [],
): WorkbenchDailyAddition[] {
  const suffixDay = datasetSuffixDay(
    dataset.relativePath,
    remote?.lastModified,
  );
  if (!suffixDay) return changeHistoryAdditions;
  if (!dataset.leftGripperSn) return [];
  return [
    {
      day: suffixDay,
      episodes: nonNegativeCount(
        asNumber(remote?.totalEpisodes) ?? dataset.total_episodes,
      ),
      frames: nonNegativeCount(
        asNumber(remote?.totalFrames) ?? dataset.total_frames,
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
  return {
    ...dataset,
    codebase_version: dataset.codebase_version,
    robot_type:
      typeof remote?.robotType === "string"
        ? remote.robotType
        : dataset.robot_type,
    total_episodes: asNumber(remote?.totalEpisodes) ?? dataset.total_episodes,
    total_frames: asNumber(remote?.totalFrames) ?? dataset.total_frames,
    total_tasks: asNumber(remote?.totalTasks) ?? dataset.total_tasks,
    fps: asNumber(remote?.fps) ?? dataset.fps,
    durationHours: asNumber(remote?.durationHours),
    tasks: dataset.tasks,
    hf: metadata,
    lastModified: metadata.lastModified,
    uploader: metadata.uploader,
    uploaderDisplayName: metadata.uploaderDisplayName,
    dailyAdditions,
  };
}

async function readCatalogByRepo(
  root: string,
  organization: string,
): Promise<Map<string, { entry: HfCatalogEntry; rank: number }>> {
  try {
    const catalog = await readHfCatalog(root, organization);
    return new Map(
      (catalog.datasets ?? [])
        .filter((entry): entry is HfCatalogEntry & { repoId: string } =>
          Boolean(entry.repoId),
        )
        .map((entry, rank) => [entry.repoId, { entry, rank }]),
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
    throw error;
  }
}

/**
 * Read-only corpus summary used exclusively by the viewer's Workbench tab.
 * Keeping it separate from the homepage and the shared local-dataset route
 * prevents the moved UI from changing either surface's existing contract.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const organization = new URL(request.url).searchParams.get("org")?.trim();
    if (!organization) {
      return Response.json(
        { error: "Workbench statistics requires a dataset organization." },
        { status: 400 },
      );
    }

    const discovery = await discoverLocalDatasets();
    const datasets = discovery.datasets.filter(
      (dataset) => getDatasetPrefix(dataset.relativePath) === organization,
    );
    const workstationMappings = await readWorkbenchWorkstationMappings(
      organization,
      discovery.root,
    );
    const catalog = await readCatalogByRepo(discovery.root, organization);
    const changeHistory = await readHfChangeHistory(
      discovery.root,
      organization,
    );
    const workbenchDatasets: WorkbenchDatasetSummary[] = await Promise.all(
      datasets.map(async (dataset) => {
        const remote = catalog.get(dataset.relativePath)?.entry;
        const withTasks = {
          ...dataset,
          tasks: await readDatasetTasks(
            path.join(discovery.root, ...dataset.relativePath.split("/")),
          ),
        };
        return applyCatalogMetadata(
          withTasks,
          remote,
          dailyAdditionsForDataset(
            withTasks,
            remote,
            changeHistory.get(dataset.relativePath) ?? [],
          ),
        );
      }),
    );
    workbenchDatasets.sort((left, right) => {
      const leftCatalog = catalog.get(left.relativePath);
      const rightCatalog = catalog.get(right.relativePath);
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

    return Response.json({
      datasets: workbenchDatasets,
      errors,
      delta,
      workstationMappings: {
        ...workstationMappings,
        defaults: defaultWorkbenchWorkstationMappings(organization),
      },
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

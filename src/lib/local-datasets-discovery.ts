import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LOCAL_DATASET_ROOT_SUFFIX,
  encodeLocalDatasetPath,
} from "@/utils/datasetRoute";
import { formatStringWithVars } from "@/utils/parquetUtils";
import {
  type DatasetTags,
  EMPTY_TAGS,
  normalizeTags,
} from "@/lib/dataset-tags";
import { pickThumbnailVideoKey } from "@/lib/thumbnail-camera";
import {
  readLocations,
  resolveBrowsePath,
} from "@/lib/dataset-locations-store";
import type { DatasetFacets } from "@/lib/dataset-facets";
import { computeFacets } from "@/lib/dataset-facets-server";
import {
  createDatasetSizeResolver,
  type DatasetSizeResolver,
} from "@/lib/dataset-size-cache";

export type { DatasetTags } from "@/lib/dataset-tags";

const MAX_SCAN_DEPTH = 3;
const IGNORE_DIRS = new Set([
  "calibration",
  ".cache",
  ".git",
  "node_modules",
  "__pycache__",
]);

type FeatureInfo = {
  dtype: string;
  shape?: number[];
  names?: unknown;
};

type LocalDatasetInfoJson = {
  codebase_version?: string;
  robot_type?: string | null;
  total_episodes?: number;
  total_frames?: number;
  fps?: number;
  chunks_size?: number;
  data_path?: string;
  video_path?: string;
  features?: Record<string, FeatureInfo>;
};

export type LocalDatasetSummary = {
  /** Path relative to the browsed directory — what the homepage groups on. */
  relativePath: string;
  /**
   * Route segment: base64url of the relative path when browsing the default
   * root, of the **absolute** path when browsing anywhere else.
   * `resolveServerLocalDatasetPath` accepts either, so the file routes serve
   * both without change.
   */
  encodedPath: string;
  codebase_version: string;
  robot_type: string | null;
  total_episodes: number;
  total_frames: number;
  fps: number;
  /** Bytes on disk for the whole dataset directory. See `directorySizeBytes`. */
  sizeBytes: number;
  thumbnailVideoUrl: string | null;
  integrity: DatasetIntegrity;
  tags: DatasetTags;
  /**
   * Derived browsing facets — bucket, capture dates, shape anomaly. Computed
   * here rather than on the detail page so the homepage can filter the list
   * without opening 542 datasets a second time. See `dataset-facets.ts`.
   */
  facets: DatasetFacets;
};

/**
 * A conversion that stopped part-way: `meta/.checkpoint.json` written and no
 * `meta/info.json` beside it.
 *
 * The three states an output directory can be in are the converter's contract,
 * not a guess — see `xense-dataset-convert/hdf52lerobot/checkpoint.py`:
 * `info.json` present is finished, a checkpoint without one is interrupted and
 * resumable, neither is nothing usable. A checkpoint *beside* an `info.json` is
 * leftover from a finished run and is not this.
 *
 * Deliberately **not** a `LocalDatasetSummary`. There is no `codebase_version`,
 * no episode count, no robot type and no thumbnail to put in one, so folding it
 * in would mean making those nullable — which changes what every finished
 * dataset's card renders from. It rides in its own list instead, so the grid,
 * the corpus tape and the daily snapshot cannot see it at all.
 *
 * It is surfaced because the alternative is invisible: discovery keys on
 * `meta/info.json`, so an interrupted run is not a dataset, shows nowhere, and
 * holds its bytes silently. One on this machine held 9.2 GB that way.
 */
export type InterruptedConversion = {
  /** Path relative to the browsed directory, named like a dataset's. */
  relativePath: string;
  /** Bytes the half-written directory is holding — the reason to show it. */
  sizeBytes: number;
  /**
   * Episodes the interrupted run had already written, read from the checkpoint.
   * Null when the file cannot be read or carries a version this does not know —
   * the same cases in which the converter starts over instead of resuming.
   */
  episodesConverted: number | null;
  /** Local ISO day of the checkpoint's last write; null if it cannot be stat'd. */
  updatedDay: string | null;
};

export type LocalDatasetsResponse = {
  /** The default root, `LOCAL_DATASET_ROOT`. Anchors the stores. */
  root: string;
  /** The directory actually scanned — the root, or a switched-to location. */
  browsePath: string;
  /** Alternative directories the switcher offers, in the order added. */
  locations: string[];
  datasets: LocalDatasetSummary[];
  /**
   * Directories that are a conversion in progress rather than a dataset. Kept
   * out of `datasets` on purpose; see `InterruptedConversion`.
   */
  interrupted: InterruptedConversion[];
  errors: { path: string; message: string }[];
};

async function readDatasetInfo(
  datasetDir: string,
): Promise<LocalDatasetInfoJson | null> {
  const infoPath = path.join(datasetDir, "meta", "info.json");
  try {
    const raw = await fs.readFile(infoPath, "utf-8");
    return JSON.parse(raw) as LocalDatasetInfoJson;
  } catch {
    return null;
  }
}

/** The checkpoint a stopped conversion leaves behind, relative to a dataset. */
const CHECKPOINT_FILE = ["meta", ".checkpoint.json"] as const;
/** The only version `hdf52lerobot/checkpoint.py` will resume from. */
const CHECKPOINT_VERSION = 1;

/**
 * The day as the machine's clock reads it, not UTC.
 *
 * An mtime is an instant, so unlike a `recorded_at` string off disk there is no
 * "as written" form to preserve; the day someone means by "when did this stop"
 * is their own. `isoDay` in `dataset-facets-server.ts` slices a string for the
 * opposite reason — there the timezone is already in the data.
 */
function localDay(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/**
 * Probe one directory for an interrupted conversion, or null if it is not one.
 *
 * Mirrors `Checkpoint.load`: a checkpoint next to an `info.json` is stale and
 * does not count. `info.json` is tested for **existence** rather than parsed —
 * a corrupt one is a broken dataset, which is the grid's story to tell, not an
 * interrupted conversion.
 */
async function readCheckpoint(
  datasetDir: string,
): Promise<Pick<
  InterruptedConversion,
  "episodesConverted" | "updatedDay"
> | null> {
  const file = path.join(datasetDir, ...CHECKPOINT_FILE);
  let mtime: Date;
  try {
    mtime = (await fs.stat(file)).mtime;
  } catch {
    return null; // no checkpoint: an ordinary directory on the way down
  }
  try {
    await fs.access(path.join(datasetDir, "meta", "info.json"));
    return null; // finished; the checkpoint is leftover
  } catch {
    // absent — genuinely interrupted
  }

  let episodesConverted: number | null = null;
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as {
      version?: unknown;
      converted?: unknown;
    };
    if (raw?.version === CHECKPOINT_VERSION && Array.isArray(raw.converted)) {
      episodesConverted = raw.converted.length;
    }
  } catch {
    // Truncated or unparseable. The directory still exists and still costs
    // disk, so it is still worth showing — just without a count.
  }

  return { episodesConverted, updatedDay: localDay(mtime) };
}

async function readDatasetTags(datasetDir: string): Promise<DatasetTags> {
  const tagsPath = path.join(datasetDir, "meta", "xense_tags.json");
  try {
    const raw = await fs.readFile(tagsPath, "utf-8");
    return normalizeTags(JSON.parse(raw));
  } catch {
    return { ...EMPTY_TAGS };
  }
}

async function isDirectoryWithContent(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return false;
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Bytes held by a dataset directory, walked recursively.
 *
 * Counts **everything** under the directory, including the `.cache/huggingface`
 * bookkeeping a Hub sync leaves behind — the question this answers is "what is
 * this dataset costing me on disk", and that cache is part of the answer even
 * though discovery ignores it when looking for datasets.
 *
 * Symlinks are skipped rather than followed: a `videos/` symlink points at bytes
 * owned by somewhere else, and following one would either double-count them or
 * attribute another dataset's storage to this one. Apparent size is summed, not
 * allocated blocks, so a sparse file reads larger here than in `du`.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // unreadable subtree contributes nothing rather than failing the scan
  }

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return directorySizeBytes(full);
      if (!entry.isFile()) return 0; // symlink, socket, fifo…
      try {
        return (await fs.lstat(full)).size;
      } catch {
        return 0; // vanished mid-scan (an export rewriting a parquet, say)
      }
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export type DatasetIntegrity = {
  hasData: boolean;
  hasVideos: boolean;
  hasEpisodes: boolean;
  status: "ok" | "empty" | "incomplete";
};

async function probeIntegrity(
  datasetDir: string,
  info: LocalDatasetInfoJson,
): Promise<DatasetIntegrity> {
  const [hasData, hasVideos] = await Promise.all([
    isDirectoryWithContent(path.join(datasetDir, "data")),
    isDirectoryWithContent(path.join(datasetDir, "videos")),
  ]);
  const hasEpisodes = (info.total_episodes ?? 0) > 0;

  let status: DatasetIntegrity["status"];
  if (!hasEpisodes) {
    status = "empty";
  } else if (!hasData || !hasVideos) {
    status = "incomplete";
  } else {
    status = "ok";
  }
  return { hasData, hasVideos, hasEpisodes, status };
}

function pickThumbnailVideoPath(info: LocalDatasetInfoJson): string | null {
  if (!info.video_path || !info.features) return null;

  const videoKeys = Object.entries(info.features)
    .filter(([, value]) => value?.dtype === "video")
    .map(([key]) => key);
  const videoKey = pickThumbnailVideoKey(videoKeys);
  if (!videoKey) return null;

  return formatStringWithVars(info.video_path, {
    video_key: videoKey,
    episode_chunk: "0".padStart(3, "0"),
    episode_index: "0".padStart(6, "0"),
    chunk_index: "0".padStart(3, "0"),
    file_index: "0".padStart(3, "0"),
  });
}

/**
 * How a directory is named in the listing: its path under the browsed
 * directory. The browsed directory can itself be the thing being listed
 * (someone switched straight to `/archive/TacVerse/TacVerse-RDT`), and then it
 * has no relative path, so it is named after itself — but only where routes
 * are absolute, since a relative route of `""` addresses nothing.
 */
function relativeName(
  rootDir: string,
  currentDir: string,
  useAbsoluteRoutes: boolean,
): string {
  return (
    path.relative(rootDir, currentDir).split(path.sep).join("/") ||
    (useAbsoluteRoutes ? path.basename(currentDir) : "")
  );
}

async function walkForDatasets(
  rootDir: string,
  currentDir: string,
  depth: number,
  found: LocalDatasetSummary[],
  interrupted: InterruptedConversion[],
  errors: { path: string; message: string }[],
  sizes: DatasetSizeResolver,
  useAbsoluteRoutes = false,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    errors.push({
      path: currentDir,
      message: err instanceof Error ? err.message : "Failed to read directory",
    });
    return;
  }

  const info = await readDatasetInfo(currentDir);
  if (info && typeof info.codebase_version === "string") {
    const relativePath = relativeName(rootDir, currentDir, useAbsoluteRoutes);
    if (relativePath) {
      const encodedPath = encodeLocalDatasetPath(
        useAbsoluteRoutes ? currentDir : relativePath,
      );
      const [integrity, tags, sizeBytes, facets] = await Promise.all([
        probeIntegrity(currentDir, info),
        readDatasetTags(currentDir),
        sizes.sizeOf(currentDir),
        computeFacets(
          currentDir,
          relativePath,
          info.features,
          info.robot_type ?? null,
        ),
      ]);
      const thumbnailPath =
        integrity.status === "ok" ? pickThumbnailVideoPath(info) : null;
      const thumbnailVideoUrl = thumbnailPath
        ? `/api/local-datasets/${encodedPath}/${thumbnailPath}`
        : null;

      found.push({
        relativePath,
        encodedPath,
        codebase_version: info.codebase_version,
        robot_type: info.robot_type ?? null,
        total_episodes: info.total_episodes ?? 0,
        total_frames: info.total_frames ?? 0,
        fps: info.fps ?? 0,
        sizeBytes,
        thumbnailVideoUrl,
        integrity,
        tags,
        facets,
      });
      return;
    }
    // Root itself looks like a dataset (no valid URL for it) — skip recording
    // but keep descending so nested datasets under sibling directories are found.
  }

  // Not a dataset. It may still be a conversion that stopped part-way, which is
  // worth saying out loud rather than walking past: nothing else in the app can
  // see one. Stop descending either way — what is under it is `data/`,
  // `videos/` and `meta/`, never a nested dataset.
  const checkpoint = await readCheckpoint(currentDir);
  if (checkpoint) {
    const relativePath = relativeName(rootDir, currentDir, useAbsoluteRoutes);
    if (relativePath) {
      interrupted.push({
        relativePath,
        // Through the same cache as a dataset: an abandoned directory is
        // fingerprint-stable and gets counted once, while one being written
        // right now re-walks — which is what it would have cost anyway.
        sizeBytes: await sizes.sizeOf(currentDir),
        ...checkpoint,
      });
      return;
    }
  }

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !IGNORE_DIRS.has(entry.name),
      )
      .map((entry) =>
        walkForDatasets(
          rootDir,
          path.join(currentDir, entry.name),
          depth + 1,
          found,
          interrupted,
          errors,
          sizes,
          useAbsoluteRoutes,
        ),
      ),
  );
}

export function resolveLocalDatasetRoot(): string {
  const homeDir = process.env.HOME?.trim();
  const configuredRoot =
    process.env.LOCAL_DATASET_ROOT?.trim() ||
    process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT?.trim() ||
    (homeDir ? `${homeDir}${DEFAULT_LOCAL_DATASET_ROOT_SUFFIX}` : "");
  if (!configuredRoot) {
    throw new Error(
      "Unable to resolve local dataset root. Set LOCAL_DATASET_ROOT or HOME.",
    );
  }
  return path.resolve(configuredRoot);
}

/**
 * Scan one directory for datasets: the default root, or the location named by
 * `requestedBrowsePath` when it is one the switcher knows (see
 * `resolveBrowsePath` — an unknown value falls back to the root rather than
 * scanning wherever it points).
 */
export async function discoverLocalDatasets(
  requestedBrowsePath?: string,
): Promise<LocalDatasetsResponse> {
  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (err) {
    return {
      root: "",
      browsePath: "",
      locations: [],
      datasets: [],
      interrupted: [],
      errors: [
        {
          path: "",
          message:
            err instanceof Error
              ? err.message
              : "Failed to resolve local dataset root",
        },
      ],
    };
  }

  const [locations, browsePath] = await Promise.all([
    readLocations(root),
    resolveBrowsePath(root, requestedBrowsePath),
  ]);
  const paths = locations.map((entry) => entry.path);
  const isRoot = browsePath === root;

  try {
    await fs.access(browsePath);
  } catch {
    return {
      root,
      browsePath,
      locations: paths,
      datasets: [],
      interrupted: [],
      errors: [
        {
          path: browsePath,
          message: isRoot
            ? `Local dataset root does not exist: ${browsePath}`
            : `Dataset location does not exist: ${browsePath}`,
        },
      ],
    };
  }

  const datasets: LocalDatasetSummary[] = [];
  const interrupted: InterruptedConversion[] = [];
  const errors: { path: string; message: string }[] = [];
  // Sizes come from the store when the dataset has not moved since it was last
  // counted; see `dataset-size-cache.ts` for why that matters on a big archive.
  const sizes = await createDatasetSizeResolver(root, directorySizeBytes);
  await walkForDatasets(
    browsePath,
    browsePath,
    0,
    datasets,
    interrupted,
    errors,
    sizes,
    !isRoot,
  );
  await sizes.flush();
  datasets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  // Largest first: the question these answer is what they are costing, and the
  // list is short enough that nothing else needs ranking.
  interrupted.sort(
    (a, b) =>
      b.sizeBytes - a.sizeBytes || a.relativePath.localeCompare(b.relativePath),
  );

  return { root, browsePath, locations: paths, datasets, interrupted, errors };
}

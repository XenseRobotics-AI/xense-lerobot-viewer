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

export type LocalDatasetsResponse = {
  /** The default root, `LOCAL_DATASET_ROOT`. Anchors the stores. */
  root: string;
  /** The directory actually scanned — the root, or a switched-to location. */
  browsePath: string;
  /** Alternative directories the switcher offers, in the order added. */
  locations: string[];
  datasets: LocalDatasetSummary[];
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

async function walkForDatasets(
  rootDir: string,
  currentDir: string,
  depth: number,
  found: LocalDatasetSummary[],
  errors: { path: string; message: string }[],
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
    // The browsed directory can itself be a dataset (someone switched straight
    // to `/archive/TacVerse/TacVerse-RDT`); it has no relative path, so it is
    // named after itself.
    const relativePath =
      path.relative(rootDir, currentDir).split(path.sep).join("/") ||
      (useAbsoluteRoutes ? path.basename(currentDir) : "");
    if (relativePath) {
      const encodedPath = encodeLocalDatasetPath(
        useAbsoluteRoutes ? currentDir : relativePath,
      );
      const [integrity, tags, sizeBytes, facets] = await Promise.all([
        probeIntegrity(currentDir, info),
        readDatasetTags(currentDir),
        directorySizeBytes(currentDir),
        computeFacets(currentDir, relativePath, info.features),
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
          errors,
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
  const errors: { path: string; message: string }[] = [];
  await walkForDatasets(browsePath, browsePath, 0, datasets, errors, !isRoot);
  datasets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { root, browsePath, locations: paths, datasets, errors };
}

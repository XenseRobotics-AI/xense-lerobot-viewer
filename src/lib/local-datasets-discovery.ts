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
import type { DatasetQualityTask } from "@/utils/datasetQualityChecks";

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
  total_tasks?: number;
  fps?: number;
  chunks_size?: number;
  data_path?: string;
  video_path?: string;
  features?: Record<string, FeatureInfo>;
};

type LocalDatasetHardwareUnit = {
  side?: unknown;
  gripper_sn?: unknown;
  [key: string]: unknown;
};

type LocalDatasetHardwareEpoch = {
  units?: LocalDatasetHardwareUnit[];
  [key: string]: unknown;
};

type LocalDatasetHardwareJson = {
  units?: LocalDatasetHardwareUnit[];
  epochs?: LocalDatasetHardwareEpoch[];
  [key: string]: unknown;
};

export type LocalDatasetSummary = {
  relativePath: string;
  encodedPath: string;
  codebase_version: string;
  robot_type: string | null;
  leftGripperSn: string | null;
  total_episodes: number;
  total_frames: number;
  total_tasks?: number;
  fps: number;
  /** Bytes on disk for the whole dataset directory. See `directorySizeBytes`. */
  sizeBytes: number;
  thumbnailVideoUrl: string | null;
  integrity: DatasetIntegrity;
  tags: DatasetTags;
  /** Prompt rows loaded by the Workbench-only statistics route. */
  tasks?: DatasetQualityTask[];
};

export type LocalDatasetsResponse = {
  root: string;
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

function extractLeftGripperSn(units: unknown): string | null {
  if (!Array.isArray(units)) return null;
  for (const unit of units) {
    if (!unit || typeof unit !== "object") continue;
    const record = unit as LocalDatasetHardwareUnit;
    if (record.side !== "left") continue;
    if (typeof record.gripper_sn !== "string") continue;
    const value = record.gripper_sn.trim();
    if (value) return value;
  }
  return null;
}

export function readDatasetHardwareValue(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const parsed = input as LocalDatasetHardwareJson;
  const topLevel = extractLeftGripperSn(parsed.units);
  if (topLevel) return topLevel;

  const epochs = Array.isArray(parsed.epochs) ? parsed.epochs : [];
  for (let index = epochs.length - 1; index >= 0; index -= 1) {
    const epoch = epochs[index];
    if (!epoch || typeof epoch !== "object") continue;
    const value = extractLeftGripperSn(
      (epoch as LocalDatasetHardwareEpoch).units,
    );
    if (value) return value;
  }
  return null;
}

async function readDatasetHardware(datasetDir: string): Promise<string | null> {
  const hardwarePath = path.join(datasetDir, "meta", "hardware.json");
  try {
    const raw = await fs.readFile(hardwarePath, "utf-8");
    return readDatasetHardwareValue(JSON.parse(raw));
  } catch {
    return null;
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
    const relativePath = path
      .relative(rootDir, currentDir)
      .split(path.sep)
      .join("/");
    if (relativePath) {
      const encodedPath = encodeLocalDatasetPath(relativePath);
      const [integrity, tags, leftGripperSn, sizeBytes] = await Promise.all([
        probeIntegrity(currentDir, info),
        readDatasetTags(currentDir),
        readDatasetHardware(currentDir),
        directorySizeBytes(currentDir),
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
        leftGripperSn,
        total_episodes: info.total_episodes ?? 0,
        total_frames: info.total_frames ?? 0,
        total_tasks: info.total_tasks ?? 0,
        fps: info.fps ?? 0,
        sizeBytes,
        thumbnailVideoUrl,
        integrity,
        tags,
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

export async function discoverLocalDatasets(): Promise<LocalDatasetsResponse> {
  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (err) {
    return {
      root: "",
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

  try {
    await fs.access(root);
  } catch {
    return {
      root,
      datasets: [],
      errors: [
        {
          path: root,
          message: `Local dataset root does not exist: ${root}`,
        },
      ],
    };
  }

  const datasets: LocalDatasetSummary[] = [];
  const errors: { path: string; message: string }[] = [];
  await walkForDatasets(root, root, 0, datasets, errors);
  datasets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { root, datasets, errors };
}

import fs from "node:fs/promises";
import path from "node:path";
import { isInsideRoot, resolveInsideDataset } from "@/lib/local-dataset-paths";
import {
  buildV2EpisodeDataPath,
  openParquet,
  readParquetRowsRaw,
} from "@/lib/parquet-server";
import { buildV3DataPath } from "@/utils/stringFormatting";
import type { DoctorEpisodeRange } from "@/types/doctor.types";
import {
  isRecord,
  numberValue,
  stringValue,
  throwIfDoctorAborted,
  type DoctorDatasetInfo,
  type DoctorEpisodeData,
  type DoctorEpisodeMeta,
  type DoctorInventory,
  type DoctorRawRow,
  type LoadedDoctorDataset,
} from "./model";

const MAX_INVENTORY_ENTRIES = 100_000;
const MAX_JSON_BYTES = 50 * 1024 * 1024;

export interface LoadDoctorDatasetOptions {
  maxEpisodes: number | null;
  episodeRange?: DoctorEpisodeRange | null;
  signal?: AbortSignal;
  onProgress?: (progress: DoctorLoadProgress) => void;
}

export interface DoctorLoadProgress {
  fraction: number;
  message: string;
}

function reportLoadProgress(
  options: LoadDoctorDatasetOptions,
  fraction: number,
  message: string,
): void {
  options.onProgress?.({
    fraction: Math.max(0, Math.min(1, fraction)),
    message,
  });
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonValue(absolutePath: string): Promise<unknown> {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_JSON_BYTES) {
    throw new Error(`file exceeds ${MAX_JSON_BYTES / 1024 / 1024} MiB limit`);
  }
  return JSON.parse(await fs.readFile(absolutePath, "utf8")) as unknown;
}

async function readJsonObject(absolutePath: string): Promise<DoctorRawRow> {
  const value = await readJsonValue(absolutePath);
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

async function readJsonLines(
  absolutePath: string,
  signal?: AbortSignal,
): Promise<DoctorRawRow[]> {
  throwIfDoctorAborted(signal);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_JSON_BYTES) {
    throw new Error(`file exceeds ${MAX_JSON_BYTES / 1024 / 1024} MiB limit`);
  }
  throwIfDoctorAborted(signal);
  const text = await fs.readFile(absolutePath, { encoding: "utf8", signal });
  throwIfDoctorAborted(signal);
  const rows: DoctorRawRow[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(
        `line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (isRecord(parsed)) rows.push(parsed);
  }
  return rows;
}

async function listFilesUnder(
  root: string,
  relativeDirectory: string,
  suffix?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfDoctorAborted(signal);
  const start = resolveInsideDataset(root, relativeDirectory);
  if (!start) return [];

  try {
    if (!(await fs.stat(start)).isDirectory()) return [];
  } catch {
    return [];
  }

  const files: string[] = [];
  const pending = [start];
  while (pending.length > 0) {
    throwIfDoctorAborted(signal);
    const directory = pending.pop();
    if (!directory) break;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        const relative = path
          .relative(root, absolutePath)
          .split(path.sep)
          .join("/");
        if (!suffix || relative.toLowerCase().endsWith(suffix.toLowerCase())) {
          files.push(relative);
        }
      }
    }
  }
  throwIfDoctorAborted(signal);
  return files.sort((left, right) => left.localeCompare(right));
}

async function buildInventory(
  root: string,
  signal?: AbortSignal,
): Promise<DoctorInventory> {
  const entries: DoctorInventory["entries"] = [];
  let totalSize = 0;
  let truncated = false;
  const pending = [root];

  while (pending.length > 0) {
    throwIfDoctorAborted(signal);
    const directory = pending.pop();
    if (!directory) break;
    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      throwIfDoctorAborted(signal);
      if (entries.length >= MAX_INVENTORY_ENTRIES) {
        truncated = true;
        return { entries, totalSize, truncated };
      }
      const absolutePath = path.join(directory, child.name);
      const relPath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch {
        continue;
      }
      const symlink = stat.isSymbolicLink();
      if (stat.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!stat.isFile() && !symlink) continue;

      let size = Number(stat.size);
      let mtimeMs = stat.mtimeMs;
      if (symlink) {
        try {
          const target = await fs.stat(absolutePath);
          size = target.isFile() ? Number(target.size) : 0;
          mtimeMs = target.mtimeMs;
        } catch {
          size = 0;
        }
      }
      let readable = true;
      try {
        await fs.access(absolutePath, fs.constants.R_OK);
      } catch {
        readable = false;
      }
      entries.push({ relPath, size, mtimeMs, readable, symlink });
      totalSize += size;
    }
  }

  entries.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return { entries, totalSize, truncated };
}

async function detectFormatVersion(
  root: string,
  raw: DoctorRawRow,
): Promise<"v2" | "v3" | null> {
  const codebaseVersion = stringValue(raw.codebase_version);
  if (codebaseVersion?.startsWith("v3")) return "v3";
  if (codebaseVersion?.startsWith("v2")) return "v2";
  if (await pathExists(path.join(root, "meta", "episodes"))) return "v3";
  if (await pathExists(path.join(root, "meta", "episodes.jsonl"))) return "v2";
  const dataFiles = await listFilesUnder(root, "data", ".parquet");
  if (dataFiles.some((file) => /\/file-\d+\.parquet$/i.test(file))) return "v3";
  if (dataFiles.some((file) => /\/episode_\d+\.parquet$/i.test(file)))
    return "v2";
  return null;
}

async function loadInfo(root: string): Promise<{
  info: DoctorDatasetInfo | null;
  error: string | null;
}> {
  const infoPath = path.join(root, "meta", "info.json");
  try {
    const raw = await readJsonObject(infoPath);
    const rawFeatures = isRecord(raw.features) ? raw.features : {};
    const features = Object.fromEntries(
      Object.entries(rawFeatures).filter(
        (entry): entry is [string, DoctorRawRow] => isRecord(entry[1]),
      ),
    );
    return {
      info: {
        raw,
        codebaseVersion: stringValue(raw.codebase_version),
        formatVersion: await detectFormatVersion(root, raw),
        fps: numberValue(raw.fps, null),
        totalEpisodes: numberValue(raw.total_episodes, null),
        totalFrames: numberValue(raw.total_frames, null),
        totalTasks: numberValue(raw.total_tasks, null),
        chunksSize: Math.max(1, numberValue(raw.chunks_size, 1000) ?? 1000),
        features,
        dataPath: stringValue(raw.data_path),
        videoPath: stringValue(raw.video_path),
        splits: isRecord(raw.splits) ? raw.splits : {},
        robotType: stringValue(raw.robot_type),
      },
      error: null,
    };
  } catch (error) {
    return {
      info: null,
      error: `info.json could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readParquetFile(
  root: string,
  relPath: string,
  signal?: AbortSignal,
  columns: string[] = [],
): Promise<DoctorRawRow[]> {
  throwIfDoctorAborted(signal);
  const absolutePath = resolveInsideDataset(root, relPath);
  if (!absolutePath) throw new Error(`Unsafe parquet path: ${relPath}`);
  const [stat, realRoot, realFile] = await Promise.all([
    fs.stat(absolutePath),
    fs.realpath(root),
    fs.realpath(absolutePath),
  ]);
  if (!stat.isFile() || !isInsideRoot(realRoot, realFile)) {
    throw new Error(`Parquet path escapes dataset: ${relPath}`);
  }
  throwIfDoctorAborted(signal);
  const handle = await openParquet(
    absolutePath,
    relPath,
    Number(stat.size),
    stat.mtimeMs,
  );
  throwIfDoctorAborted(signal);
  // Match PyArrow's pq.read_table() behavior used by the Python Doctor: read
  // each parquet file once. LeRobot v3 commonly writes a ~100 MB data file as
  // one row group, so splitting this into logical 50k-row reads would decode
  // that same row group repeatedly.
  const rows = await readParquetRowsRaw(
    handle,
    0,
    handle.info.numRows,
    columns,
  );
  throwIfDoctorAborted(signal);
  return rows;
}

async function readParquetRange(
  root: string,
  relPath: string,
  fromIndex: number,
  toIndex: number,
  indicesAreDatasetGlobal: boolean,
  signal?: AbortSignal,
  columns: string[] = [],
): Promise<DoctorRawRow[]> {
  throwIfDoctorAborted(signal);
  const absolutePath = resolveInsideDataset(root, relPath);
  if (!absolutePath) throw new Error(`Unsafe parquet path: ${relPath}`);
  const [stat, realRoot, realFile] = await Promise.all([
    fs.stat(absolutePath),
    fs.realpath(root),
    fs.realpath(absolutePath),
  ]);
  if (!stat.isFile() || !isInsideRoot(realRoot, realFile)) {
    throw new Error(`Parquet path escapes dataset: ${relPath}`);
  }
  throwIfDoctorAborted(signal);
  const handle = await openParquet(
    absolutePath,
    relPath,
    Number(stat.size),
    stat.mtimeMs,
  );
  throwIfDoctorAborted(signal);
  let fileStartIndex = 0;
  if (indicesAreDatasetGlobal && handle.info.numRows > 0) {
    const firstRow = await readParquetRowsRaw(handle, 0, 1, ["index"]);
    fileStartIndex = Math.trunc(numberValue(firstRow[0]?.index, 0) ?? 0);
  }
  throwIfDoctorAborted(signal);
  const localFrom = fromIndex - fileStartIndex;
  const localTo = toIndex - fileStartIndex;
  const start = Math.max(
    0,
    Math.min(handle.info.numRows, Math.trunc(localFrom)),
  );
  const end = Math.max(
    start,
    Math.min(handle.info.numRows, Math.trunc(localTo)),
  );
  const rows = await readParquetRowsRaw(handle, start, end - start, columns);
  throwIfDoctorAborted(signal);
  return rows;
}

function episodeMetaFromRow(
  row: DoctorRawRow,
  fallbackIndex: number,
): DoctorEpisodeMeta {
  const namedEpisodeIndex = numberValue(row.episode_index, null);
  const numericEpisodeIndex = numberValue(row["0"], null);
  const episodeIndex =
    namedEpisodeIndex ?? numericEpisodeIndex ?? fallbackIndex;
  const namedLength = numberValue(row.length, null);
  const numericLength = numberValue(row["9"], null);
  return {
    episodeIndex: Math.trunc(episodeIndex),
    length: Math.max(
      0,
      Math.trunc(
        namedLength ?? numericLength ?? numberValue(row.num_frames, 0) ?? 0,
      ),
    ),
    raw: row,
  };
}

export function selectDoctorEpisodeMeta(
  episodes: DoctorEpisodeMeta[],
  maxEpisodes: number | null,
  episodeRange: DoctorEpisodeRange | null,
): DoctorEpisodeMeta[] {
  if (episodeRange) {
    return episodes.filter(
      (episode) =>
        episode.episodeIndex >= episodeRange.start &&
        episode.episodeIndex <= episodeRange.end,
    );
  }
  return maxEpisodes === null ? episodes : episodes.slice(0, maxEpisodes);
}

async function loadEpisodeMeta(
  root: string,
  info: DoctorDatasetInfo,
  formatVersion: "v2" | "v3" | null,
  maxEpisodes: number | null,
  episodeRange: DoctorEpisodeRange | null,
  signal?: AbortSignal,
): Promise<{
  all: DoctorEpisodeMeta[];
  selected: DoctorEpisodeMeta[];
  total: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let rows: DoctorRawRow[] = [];
  let total = 0;
  const parquetFiles = await listFilesUnder(
    root,
    "meta/episodes",
    ".parquet",
    signal,
  );
  if (parquetFiles.length > 0) {
    for (const relPath of parquetFiles) {
      throwIfDoctorAborted(signal);
      try {
        // Episode metadata is small compared with data/video shards and is
        // needed in full for dataset-wide video/path checks. The maxEpisodes
        // bound applies to frame data below, not to this lightweight index.
        rows.push(
          ...(await readParquetFile(
            root,
            relPath,
            signal,
            episodeMetadataColumns(info),
          )),
        );
      } catch (error) {
        throwIfDoctorAborted(signal);
        warnings.push(
          `Could not read episode metadata ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else if (
    formatVersion === "v2" ||
    (await pathExists(path.join(root, "meta", "episodes.jsonl")))
  ) {
    try {
      rows = await readJsonLines(
        path.join(root, "meta", "episodes.jsonl"),
        signal,
      );
      total = rows.length;
    } catch (error) {
      throwIfDoctorAborted(signal);
      warnings.push(
        `Could not read meta/episodes.jsonl: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const all = rows
    .map(episodeMetaFromRow)
    .sort((left, right) => left.episodeIndex - right.episodeIndex);
  return {
    all,
    // Keep the complete lightweight index for dataset-wide checks, while
    // limiting frame-data loading to the requested episode scope.
    selected: selectDoctorEpisodeMeta(all, maxEpisodes, episodeRange),
    total: total || all.length,
    warnings,
  };
}

function episodeMetadataColumns(info: DoctorDatasetInfo): string[] {
  const columns = new Set([
    "episode_index",
    "length",
    "num_frames",
    "data/chunk_index",
    "data/file_index",
    "dataset_from_index",
    "dataset_to_index",
  ]);
  for (const [featureName, feature] of Object.entries(info.features)) {
    if (feature.dtype !== "video") continue;
    columns.add(`videos/${featureName}/chunk_index`);
    columns.add(`videos/${featureName}/file_index`);
    columns.add(`videos/${featureName}/from_timestamp`);
    columns.add(`videos/${featureName}/to_timestamp`);
  }
  return [...columns];
}

function appendRowToEpisode(
  episodes: Map<number, DoctorEpisodeData>,
  episodeIndex: number,
  row: DoctorRawRow,
): void {
  let episode = episodes.get(episodeIndex);
  if (!episode) {
    episode = { episodeIndex, columns: {}, length: 0 };
    episodes.set(episodeIndex, episode);
  }
  for (const [name, value] of Object.entries(row)) {
    (episode.columns[name] ??= []).push(value);
  }
  episode.length += 1;
}

function dataPathFromMeta(meta: DoctorEpisodeMeta): string | null {
  const chunk = numberValue(
    meta.raw["data/chunk_index"],
    numberValue(meta.raw["1"], null),
  );
  const file = numberValue(
    meta.raw["data/file_index"],
    numberValue(meta.raw["2"], null),
  );
  return chunk === null || file === null
    ? null
    : buildV3DataPath(Math.trunc(chunk), Math.trunc(file));
}

function doctorDataColumns(info: DoctorDatasetInfo): string[] {
  const columns = new Set([
    "timestamp",
    "frame_index",
    "episode_index",
    "index",
    "task_index",
  ]);
  for (const [featureName, feature] of Object.entries(info.features)) {
    if (feature.dtype !== "video") columns.add(featureName);
  }
  return [...columns];
}

async function loadEpisodesFromMetadata(
  root: string,
  info: DoctorDatasetInfo,
  metas: DoctorEpisodeMeta[],
  signal?: AbortSignal,
  onFileProgress?: (completed: number, total: number, message: string) => void,
): Promise<{ episodes: DoctorEpisodeData[]; warnings: string[] }> {
  interface LocatedEpisode {
    meta: DoctorEpisodeMeta;
    relPath: string;
    fromIndex: number;
    toIndex: number;
    indicesAreDatasetGlobal: boolean;
  }

  const locationsByFile = new Map<string, LocatedEpisode[]>();
  const warnings: string[] = [];
  for (const meta of metas) {
    throwIfDoctorAborted(signal);
    const relPath =
      info.formatVersion === "v2"
        ? buildV2EpisodeDataPath(
            {
              codebase_version: info.codebaseVersion ?? undefined,
              data_path: info.dataPath ?? undefined,
              chunks_size: info.chunksSize,
            },
            meta.episodeIndex,
          )
        : dataPathFromMeta(meta);
    if (!relPath) {
      warnings.push(
        `Episode ${meta.episodeIndex}: data parquet path could not be resolved from metadata`,
      );
      continue;
    }
    const fromIndex =
      info.formatVersion === "v2"
        ? 0
        : Math.max(
            0,
            Math.trunc(
              numberValue(
                meta.raw.dataset_from_index,
                numberValue(meta.raw["3"], 0),
              ) ?? 0,
            ),
          );
    const fallbackEnd = fromIndex + Math.max(0, meta.length);
    const toIndex =
      info.formatVersion === "v2"
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            fromIndex,
            Math.trunc(
              numberValue(
                meta.raw.dataset_to_index,
                numberValue(meta.raw["4"], fallbackEnd),
              ) ?? fallbackEnd,
            ),
          );
    const locations = locationsByFile.get(relPath) ?? [];
    locations.push({
      meta,
      relPath,
      fromIndex,
      toIndex,
      indicesAreDatasetGlobal: info.formatVersion === "v3",
    });
    locationsByFile.set(relPath, locations);
  }

  const episodes = new Map<number, DoctorEpisodeData>();
  const fileLocations = [...locationsByFile.entries()];
  for (const [fileIndex, [relPath, locations]] of fileLocations.entries()) {
    throwIfDoctorAborted(signal);
    onFileProgress?.(
      fileIndex,
      fileLocations.length,
      `Loading data parquet ${fileIndex + 1}/${fileLocations.length}: ${relPath}`,
    );
    let rangeStart = Number.POSITIVE_INFINITY;
    let rangeEnd = 0;
    for (const location of locations) {
      rangeStart = Math.min(rangeStart, location.fromIndex);
      rangeEnd = Math.max(rangeEnd, location.toIndex);
    }
    try {
      // A shared v3 data parquet is decoded once for all requested episodes in
      // that file. This is the TypeScript equivalent of the Python loader's
      // pq.read_table(pf) + episode_index grouping, while retaining the smaller
      // metadata-bounded output range when the mapping is valid.
      const rows = await readParquetRange(
        root,
        relPath,
        Number.isFinite(rangeStart) ? rangeStart : 0,
        rangeEnd,
        locations[0]?.indicesAreDatasetGlobal ?? false,
        signal,
        doctorDataColumns(info),
      );
      const requested = new Set(
        locations.map((location) => location.meta.episodeIndex),
      );
      const soleEpisode = locations.length === 1 ? locations[0].meta : null;
      for (const row of rows) {
        const rawEpisodeIndex = numberValue(row.episode_index, null);
        const episodeIndex =
          rawEpisodeIndex === null
            ? soleEpisode?.episodeIndex
            : Math.trunc(rawEpisodeIndex);
        if (episodeIndex === undefined || !requested.has(episodeIndex))
          continue;
        appendRowToEpisode(episodes, episodeIndex, row);
      }
      for (const location of locations) {
        if (!episodes.has(location.meta.episodeIndex)) {
          warnings.push(
            `Episode ${location.meta.episodeIndex}: metadata range did not resolve rows in ${relPath}`,
          );
        }
      }
    } catch (error) {
      throwIfDoctorAborted(signal);
      warnings.push(
        `${relPath}: could not load episodes [${locations
          .slice(0, 10)
          .map((location) => location.meta.episodeIndex)
          .join(
            ", ",
          )}${locations.length > 10 ? ", ..." : ""}]: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    onFileProgress?.(
      fileIndex + 1,
      fileLocations.length,
      `Loaded data parquet ${fileIndex + 1}/${fileLocations.length}`,
    );
  }
  return {
    episodes: [...episodes.values()].sort(
      (left, right) => left.episodeIndex - right.episodeIndex,
    ),
    warnings,
  };
}

function hasAllEpisodeData(
  episodes: DoctorEpisodeData[],
  metadata: DoctorEpisodeMeta[],
): boolean {
  const loaded = new Set(episodes.map((episode) => episode.episodeIndex));
  return metadata.every((episode) => loaded.has(episode.episodeIndex));
}

async function loadEpisodesByScanning(
  root: string,
  maxEpisodes: number | null,
  episodeRange: DoctorEpisodeRange | null,
  signal?: AbortSignal,
  onFileProgress?: (completed: number, total: number, message: string) => void,
): Promise<{ episodes: DoctorEpisodeData[]; warnings: string[] }> {
  const warnings: string[] = [];
  const grouped = new Map<number, DoctorEpisodeData>();
  const parquetFiles = await listFilesUnder(root, "data", ".parquet", signal);
  for (const [fileIndex, relPath] of parquetFiles.entries()) {
    throwIfDoctorAborted(signal);
    onFileProgress?.(
      fileIndex,
      parquetFiles.length,
      `Scanning data parquet ${fileIndex + 1}/${parquetFiles.length}: ${relPath}`,
    );
    let rows: DoctorRawRow[];
    try {
      rows = await readParquetFile(root, relPath, signal);
    } catch (error) {
      throwIfDoctorAborted(signal);
      warnings.push(
        `Could not read data parquet ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const row of rows) {
      const episodeIndex = numberValue(row.episode_index, null);
      if (episodeIndex === null) continue;
      const index = Math.trunc(episodeIndex);
      if (
        episodeRange &&
        (index < episodeRange.start || index > episodeRange.end)
      ) {
        continue;
      }
      if (
        !episodeRange &&
        !grouped.has(index) &&
        maxEpisodes !== null &&
        grouped.size >= maxEpisodes
      ) {
        continue;
      }
      appendRowToEpisode(grouped, index, row);
    }
    onFileProgress?.(
      fileIndex + 1,
      parquetFiles.length,
      `Scanned data parquet ${fileIndex + 1}/${parquetFiles.length}`,
    );
    if (!episodeRange && maxEpisodes !== null && grouped.size >= maxEpisodes) {
      break;
    }
  }
  const sorted = [...grouped.values()].sort(
    (left, right) => left.episodeIndex - right.episodeIndex,
  );
  const selected =
    episodeRange || maxEpisodes === null
      ? sorted
      : sorted.slice(0, maxEpisodes);
  return {
    episodes: selected,
    warnings,
  };
}

async function loadTasks(root: string): Promise<{
  tasks: DoctorRawRow[] | null;
  error: string | null;
}> {
  const parquetPath = "meta/tasks.parquet";
  if (await pathExists(path.join(root, parquetPath))) {
    try {
      return { tasks: await readParquetFile(root, parquetPath), error: null };
    } catch (error) {
      return {
        tasks: null,
        error: `tasks.parquet could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const jsonlPath = path.join(root, "meta", "tasks.jsonl");
  if (await pathExists(jsonlPath)) {
    try {
      return { tasks: await readJsonLines(jsonlPath), error: null };
    } catch (error) {
      return {
        tasks: null,
        error: `tasks.jsonl could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const jsonPath = path.join(root, "meta", "tasks.json");
  if (await pathExists(jsonPath)) {
    try {
      const value = await readJsonValue(jsonPath);
      if (Array.isArray(value)) {
        return { tasks: value.filter(isRecord), error: null };
      }
      if (isRecord(value)) {
        const rows = Object.entries(value).every(
          ([, item]) => typeof item === "string",
        )
          ? Object.entries(value).map(([taskIndex, task]) => ({
              task_index: /^\d+$/.test(taskIndex)
                ? Number(taskIndex)
                : taskIndex,
              task,
            }))
          : [value];
        return { tasks: rows, error: null };
      }
      return { tasks: null, error: "tasks.json must be an object or array" };
    } catch (error) {
      return {
        tasks: null,
        error: `tasks.json could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { tasks: null, error: null };
}

async function loadStats(root: string): Promise<{
  stats: DoctorRawRow | null;
  error: string | null;
}> {
  const statsPath = path.join(root, "meta", "stats.json");
  if (!(await pathExists(statsPath))) return { stats: null, error: null };
  try {
    return { stats: await readJsonObject(statsPath), error: null };
  } catch (error) {
    return {
      stats: null,
      error: `stats.json could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadDoctorDataset(
  root: string,
  options: LoadDoctorDatasetOptions,
): Promise<LoadedDoctorDataset> {
  throwIfDoctorAborted(options.signal);
  reportLoadProgress(options, 0, "Reading dataset info and scanning files…");
  const [{ info, error: infoError }, inventory] = await Promise.all([
    loadInfo(root),
    buildInventory(root, options.signal),
  ]);
  throwIfDoctorAborted(options.signal);
  reportLoadProgress(
    options,
    0.15,
    "Loading episode, task, and statistics metadata…",
  );

  if (!info) {
    reportLoadProgress(options, 1, "Dataset metadata could not be loaded");
    return {
      root,
      displayPath: root,
      info: null,
      infoError,
      episodesMeta: [],
      sampledEpisodesMeta: [],
      totalEpisodeMetaEntries: 0,
      episodesData: [],
      tasks: null,
      tasksError: null,
      stats: null,
      statsError: null,
      inventory,
      maxEpisodesApplied: options.maxEpisodes,
      episodeRangeApplied: options.episodeRange ?? null,
      loadWarnings: [],
    };
  }

  const [metaResult, tasksResult, statsResult] = await Promise.all([
    loadEpisodeMeta(
      root,
      info,
      info.formatVersion,
      options.maxEpisodes,
      options.episodeRange ?? null,
      options.signal,
    ),
    loadTasks(root),
    loadStats(root),
  ]);
  throwIfDoctorAborted(options.signal);
  reportLoadProgress(
    options,
    0.3,
    `Loading frame data for ${metaResult.selected.length.toLocaleString()} episodes…`,
  );
  let dataResult = await loadEpisodesFromMetadata(
    root,
    info,
    metaResult.selected,
    options.signal,
    (completed, total, message) =>
      reportLoadProgress(
        options,
        0.3 + (total > 0 ? (completed / total) * 0.45 : 0.45),
        message,
      ),
  );
  throwIfDoctorAborted(options.signal);
  if (!hasAllEpisodeData(dataResult.episodes, metaResult.selected)) {
    const metadataWarnings = dataResult.warnings;
    reportLoadProgress(
      options,
      0.75,
      "Episode metadata mappings were incomplete; scanning data parquets…",
    );
    const scannedResult = await loadEpisodesByScanning(
      root,
      options.maxEpisodes,
      options.episodeRange ?? null,
      options.signal,
      (completed, total, message) =>
        reportLoadProgress(
          options,
          0.75 + (total > 0 ? (completed / total) * 0.23 : 0.23),
          message,
        ),
    );
    // Prefer the scan when metadata points at stale/wrong shards, matching the
    // original Doctor loader's episode-index based behavior. Keep metadata
    // range warnings only when the scan cannot recover any data.
    if (
      scannedResult.episodes.length > dataResult.episodes.length ||
      dataResult.episodes.length === 0
    ) {
      dataResult = scannedResult;
    } else {
      dataResult.warnings = [...metadataWarnings, ...scannedResult.warnings];
    }
  }

  throwIfDoctorAborted(options.signal);
  reportLoadProgress(
    options,
    1,
    `Loaded ${dataResult.episodes.length.toLocaleString()} episodes`,
  );

  return {
    root,
    displayPath: root,
    info,
    infoError,
    episodesMeta: metaResult.all,
    sampledEpisodesMeta: metaResult.selected,
    totalEpisodeMetaEntries: metaResult.total,
    episodesData: dataResult.episodes,
    tasks: tasksResult.tasks,
    tasksError: tasksResult.error,
    stats: statsResult.stats,
    statsError: statsResult.error,
    inventory,
    maxEpisodesApplied: options.maxEpisodes,
    episodeRangeApplied: options.episodeRange ?? null,
    loadWarnings: [...metaResult.warnings, ...dataResult.warnings],
  };
}

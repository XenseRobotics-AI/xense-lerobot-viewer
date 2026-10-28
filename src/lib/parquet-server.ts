/**
 * Server-side parquet reading for the Parquet browser tab.
 *
 * The browser never downloads these files. lerobot v3 packs many episodes into
 * one shared data parquet (100 MB by default, and often a single row group), so
 * paging client-side would re-download and re-decode the whole group for every
 * page. Here we read straight off disk with hyparquet's Node entry and ship
 * only the requested page as JSON.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
  type AsyncBuffer,
  type FileMetaData,
  type SchemaElement,
  type SchemaTree,
} from "hyparquet/src/node.js";
import { resolveInsideDataset } from "@/lib/local-dataset-paths";
import {
  buildV3DataPath,
  formatEpisodeChunk,
  formatEpisodeIndex,
} from "@/utils/stringFormatting";
import {
  matchesFixedV3EpisodeMetadataProbing,
  sortV3EpisodeMetadataShards,
} from "@/utils/v3ShardPaths";
import { formatStringWithVars } from "@/utils/parquetUtils";
import { bigIntToNumber } from "@/utils/typeGuards";
import { toJsonSafe } from "@/utils/parquetBrowser";
import type {
  EpisodeLocator,
  ParquetColumnInfo,
  ParquetFileInfo,
} from "@/types/parquet-browser.types";

/** Open files kept warm. Small: each entry pins a file handle-ish buffer + footer. */
const MAX_CACHED_FILES = 8;
/** Safety rails for the episode-metadata walk (v3 chunk/file directories). */
const MAX_EPISODE_CHUNKS = 64;
const MAX_FILES_PER_CHUNK = 4096;
const MAX_EPISODE_INDEX_CACHE_ENTRIES = 32;
const warnedNonstandardShardRoots = new Set<string>();

export interface ParquetHandle {
  file: AsyncBuffer;
  metadata: FileMetaData;
  info: ParquetFileInfo;
}

const handleCache = new Map<string, Promise<ParquetHandle>>();
const episodeIndexCache = new Map<
  string,
  { fingerprint: string; indices: number[] }
>();

function describePrimitive(element: SchemaElement): string {
  const logical = element.logical_type;
  if (logical) {
    switch (logical.type) {
      case "STRING":
        return "string";
      case "ENUM":
        return "enum";
      case "UUID":
        return "uuid";
      case "JSON":
        return "json";
      case "BSON":
        return "bson";
      case "DATE":
        return "date";
      case "FLOAT16":
        return "float16";
      case "DECIMAL":
        return `decimal(${logical.precision},${logical.scale})`;
      case "TIME":
        return `time[${logical.unit.toLowerCase()}]`;
      case "TIMESTAMP":
        return `timestamp[${logical.unit.toLowerCase()}]`;
      case "INTEGER":
        return `${logical.isSigned ? "" : "u"}int${logical.bitWidth}`;
      default:
        break;
    }
  }

  if (element.converted_type === "UTF8") return "string";

  switch (element.type) {
    case "BOOLEAN":
      return "bool";
    case "INT32":
      return "int32";
    case "INT64":
      return "int64";
    case "INT96":
      return "int96";
    case "FLOAT":
      return "float";
    case "DOUBLE":
      return "double";
    case "BYTE_ARRAY":
      return "binary";
    case "FIXED_LEN_BYTE_ARRAY":
      return `binary[${element.type_length ?? "?"}]`;
    default:
      return "unknown";
  }
}

/** Render a schema node as a compact type string, e.g. `list<float>`. */
function describeSchemaType(node: SchemaTree): string {
  const element = node.element;
  if (node.children.length === 0) return describePrimitive(element);

  const kind = element.logical_type?.type ?? element.converted_type;

  if (kind === "LIST") {
    // LIST wraps a repeated `list` group whose single child is `element`.
    const inner = node.children[0]?.children[0] ?? node.children[0];
    return `list<${inner ? describeSchemaType(inner) : "?"}>`;
  }

  if (kind === "MAP" || kind === "MAP_KEY_VALUE") {
    const keyValue = node.children[0];
    const key = keyValue?.children[0];
    const value = keyValue?.children[1];
    return `map<${key ? describeSchemaType(key) : "?"}, ${value ? describeSchemaType(value) : "?"}>`;
  }

  const fields = node.children.map((child) => child.element.name);
  const shown = fields.slice(0, 4).join(", ");
  return `struct<${shown}${fields.length > 4 ? ", …" : ""}>`;
}

function buildFileInfo(
  relPath: string,
  size: number,
  metadata: FileMetaData,
): ParquetFileInfo {
  const tree = parquetSchema(metadata);
  const columns: ParquetColumnInfo[] = tree.children.map((child) => ({
    name: child.element.name,
    type: describeSchemaType(child),
    optional: child.element.repetition_type !== "REQUIRED",
  }));

  const codecs = new Set(
    (metadata.row_groups[0]?.columns ?? [])
      .map((column) => column.meta_data?.codec)
      .filter((codec) => Boolean(codec)),
  );

  return {
    relPath,
    size,
    numRows: bigIntToNumber(metadata.num_rows, 0),
    numRowGroups: metadata.row_groups.length,
    createdBy: metadata.created_by ?? null,
    compression: codecs.size > 0 ? [...codecs].join(", ") : null,
    columns,
  };
}

/**
 * Open a parquet file and parse its footer, reusing a warm handle when the file
 * hasn't changed. Keyed on mtime + size so an export that rewrites the parquet
 * (`scripts/export_subtasks.py`) invalidates the entry.
 */
export function openParquet(
  absolutePath: string,
  relPath: string,
  size: number,
  mtimeMs: number,
): Promise<ParquetHandle> {
  const key = `${absolutePath}:${mtimeMs}:${size}`;
  const cached = handleCache.get(key);
  if (cached) {
    // Refresh LRU position.
    handleCache.delete(key);
    handleCache.set(key, cached);
    return cached;
  }

  const pending = (async () => {
    const file = await asyncBufferFromFile(absolutePath);
    const metadata = await parquetMetadataAsync(file);
    return { file, metadata, info: buildFileInfo(relPath, size, metadata) };
  })();

  handleCache.set(key, pending);
  pending.catch(() => handleCache.delete(key));

  while (handleCache.size > MAX_CACHED_FILES) {
    const oldest = handleCache.keys().next();
    if (oldest.done) break;
    handleCache.delete(oldest.value);
  }

  return pending;
}

/**
 * Read one page of rows. `columns` is a projection — hyparquet silently ignores
 * names the file doesn't have, and dropping unread columns is the main lever on
 * decode time for wide files.
 */
export async function readParquetPage(
  handle: ParquetHandle,
  offset: number,
  limit: number,
  columns: string[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const rows = (await parquetReadObjects({
    file: handle.file,
    metadata: handle.metadata,
    columns: columns.length > 0 ? columns : undefined,
    rowStart: offset,
    rowEnd: offset + limit,
  })) as Record<string, unknown>[];

  const safeRows = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = toJsonSafe(value);
    }
    return out;
  });

  // Report the columns actually present, in schema order.
  const present = new Set(safeRows.length > 0 ? Object.keys(safeRows[0]) : []);
  const known = handle.info.columns.map((column) => column.name);
  const resolved =
    safeRows.length > 0
      ? known.filter((name) => present.has(name))
      : columns.length > 0
        ? known.filter((name) => columns.includes(name))
        : known;

  return { columns: resolved, rows: safeRows };
}

/**
 * Read raw parquet values for server-side analysis.
 *
 * The table browser deliberately converts values to JSON-safe previews and
 * truncates very large arrays. Doctor needs the original vectors for numeric
 * checks, so it uses this internal server API instead. Nothing returned here
 * is sent to the browser directly.
 */
export async function readParquetRowsRaw(
  handle: ParquetHandle,
  offset = 0,
  limit = handle.info.numRows,
  columns: string[] = [],
): Promise<Record<string, unknown>[]> {
  const start = Math.max(0, Math.floor(offset));
  const end = Math.min(
    handle.info.numRows,
    start + Math.max(0, Math.floor(limit)),
  );
  if (end <= start) return [];

  return (await parquetReadObjects({
    file: handle.file,
    metadata: handle.metadata,
    columns: columns.length > 0 ? columns : undefined,
    rowStart: start,
    rowEnd: end,
  })) as Record<string, unknown>[];
}

async function statFileOrNull(
  absolutePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    return { size: Number(stat.size), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Enumerate existing v3 metadata shards, including gaps and non-zero starts. */
export async function listV3EpisodeMetadataFiles(
  datasetRoot: string,
): Promise<string[]> {
  const episodesRoot = resolveInsideDataset(datasetRoot, "meta", "episodes");
  if (!episodesRoot) return [];

  let chunkEntries: import("node:fs").Dirent[];
  try {
    chunkEntries = await fs.readdir(episodesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const chunkNames = chunkEntries
    .filter((entry) => entry.isDirectory() && /^chunk-\d+$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftIndex = Number(left.match(/\d+$/)?.[0] ?? -1);
      const rightIndex = Number(right.match(/\d+$/)?.[0] ?? -1);
      return leftIndex - rightIndex || left.localeCompare(right);
    })
    .slice(0, MAX_EPISODE_CHUNKS);

  const paths: string[] = [];
  for (const chunkName of chunkNames) {
    let fileEntries: import("node:fs").Dirent[];
    try {
      fileEntries = await fs.readdir(path.join(episodesRoot, chunkName), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    const fileNames = fileEntries
      .filter(
        (entry) => entry.isFile() && /^file-\d+\.parquet$/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((left, right) => {
        const leftIndex = Number(left.match(/\d+/)?.[0] ?? -1);
        const rightIndex = Number(right.match(/\d+/)?.[0] ?? -1);
        return leftIndex - rightIndex || left.localeCompare(right);
      })
      .slice(0, MAX_FILES_PER_CHUNK);

    for (const fileName of fileNames) {
      paths.push(`meta/episodes/${chunkName}/${fileName}`);
    }
  }

  return sortV3EpisodeMetadataShards(paths);
}

export async function listV3EpisodeIndices(
  datasetRoot: string,
): Promise<number[]> {
  const paths = await listV3EpisodeMetadataFiles(datasetRoot);
  const files: {
    relPath: string;
    absolutePath: string;
    size: number;
    mtimeMs: number;
  }[] = [];

  for (const relPath of paths) {
    const absolutePath = resolveInsideDataset(datasetRoot, relPath);
    if (!absolutePath) continue;
    const stat = await statFileOrNull(absolutePath);
    if (stat) files.push({ relPath, absolutePath, ...stat });
  }

  const fingerprint = files
    .map(({ relPath, size, mtimeMs }) => `${relPath}:${size}:${mtimeMs}`)
    .join("|");
  const cached = episodeIndexCache.get(datasetRoot);
  if (cached?.fingerprint === fingerprint) {
    episodeIndexCache.delete(datasetRoot);
    episodeIndexCache.set(datasetRoot, cached);
    return [...cached.indices];
  }

  const indices = new Set<number>();
  for (const file of files) {
    try {
      const handle = await openParquet(
        file.absolutePath,
        file.relPath,
        file.size,
        file.mtimeMs,
      );
      const rows = (await parquetReadObjects({
        file: handle.file,
        metadata: handle.metadata,
        columns: ["episode_index"],
      })) as Record<string, unknown>[];
      for (const row of rows) {
        const index = bigIntToNumber(row["episode_index"], -1);
        if (Number.isSafeInteger(index) && index >= 0) indices.add(index);
      }
    } catch {
      // A damaged shard should not hide valid episodes in other shards.
    }
  }

  const sortedIndices = [...indices].sort((left, right) => left - right);
  episodeIndexCache.set(datasetRoot, { fingerprint, indices: sortedIndices });
  while (episodeIndexCache.size > MAX_EPISODE_INDEX_CACHE_ENTRIES) {
    const oldest = episodeIndexCache.keys().next();
    if (oldest.done) break;
    episodeIndexCache.delete(oldest.value);
  }
  return [...sortedIndices];
}

const LOCATOR_COLUMNS = [
  "episode_index",
  "data/chunk_index",
  "data/file_index",
  "dataset_from_index",
  "dataset_to_index",
];

/** Fallback when `meta/info.json` omits `data_path` (matches lerobot's default). */
const V2_DEFAULT_DATA_PATH =
  "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
const V2_DEFAULT_CHUNKS_SIZE = 1000;

export interface DatasetInfoLite {
  codebase_version?: string;
  data_path?: string;
  chunks_size?: number;
}

/**
 * Dataset-relative path of a v2.x episode's parquet, from the `data_path`
 * format string in `meta/info.json`. Pure, so the padding rules stay testable.
 */
export function buildV2EpisodeDataPath(
  info: DatasetInfoLite,
  episodeIndex: number,
): string {
  const chunksSize =
    typeof info.chunks_size === "number" && info.chunks_size > 0
      ? info.chunks_size
      : V2_DEFAULT_CHUNKS_SIZE;

  return formatStringWithVars(info.data_path || V2_DEFAULT_DATA_PATH, {
    // formatStringWithVars drops the `:03d` specifier, so pad here.
    episode_chunk: formatEpisodeChunk(Math.floor(episodeIndex / chunksSize)),
    episode_index: formatEpisodeIndex(episodeIndex),
  });
}

async function readDatasetInfo(
  datasetRoot: string,
): Promise<DatasetInfoLite | null> {
  const infoPath = resolveInsideDataset(datasetRoot, "meta/info.json");
  if (!infoPath) return null;
  try {
    return JSON.parse(await fs.readFile(infoPath, "utf8")) as DatasetInfoLite;
  } catch {
    return null;
  }
}

/**
 * v2.x locator. There is no episode-metadata tree to consult: each episode owns
 * a whole parquet whose path is a format string in `meta/info.json`, so the file
 * is computed rather than searched, and the row range is simply the whole file.
 */
async function locateEpisodeRowsV2(
  datasetRoot: string,
  episodeIndex: number,
  info: DatasetInfoLite,
): Promise<EpisodeLocator | null> {
  const relPath = buildV2EpisodeDataPath(info, episodeIndex);
  const absolutePath = resolveInsideDataset(datasetRoot, relPath);
  if (!absolutePath) return null;

  const stat = await statFileOrNull(absolutePath);
  if (!stat) return null;

  const handle = await openParquet(
    absolutePath,
    relPath,
    stat.size,
    stat.mtimeMs,
  );

  return {
    episodeIndex,
    relPath,
    fromIndex: 0,
    toIndex: handle.info.numRows,
  };
}

/**
 * Find which data parquet holds an episode and which row range it occupies.
 *
 * v3.0 walks `meta/episodes/chunk-{N}/file-{M}.parquet` in order — episode
 * metadata can span several chunks once the episode count exceeds
 * `chunks_size`, so this must not stop at chunk-000. v2.x has no such tree and
 * is computed from `info.data_path` instead. Null when the episode isn't found.
 */
export async function locateEpisodeRows(
  datasetRoot: string,
  episodeIndex: number,
): Promise<EpisodeLocator | null> {
  const info = await readDatasetInfo(datasetRoot);
  if (info?.codebase_version?.startsWith("v2")) {
    return locateEpisodeRowsV2(datasetRoot, episodeIndex, info);
  }

  const metadataPaths = await listV3EpisodeMetadataFiles(datasetRoot);
  if (
    !matchesFixedV3EpisodeMetadataProbing(metadataPaths) &&
    !warnedNonstandardShardRoots.has(datasetRoot)
  ) {
    warnedNonstandardShardRoots.add(datasetRoot);
    if (warnedNonstandardShardRoots.size > 100) {
      const oldest = warnedNonstandardShardRoots.values().next().value;
      if (oldest) warnedNonstandardShardRoots.delete(oldest);
    }
    const shownPaths = metadataPaths.slice(0, 8).join(", ");
    const suffix =
      metadataPaths.length > 8 ? ` (and ${metadataPaths.length - 8} more)` : "";
    console.warn(
      `[parquet] Found v3 episode metadata shards outside the fixed chunk-0/file-0 sequence for ${datasetRoot}: ${shownPaths}${suffix}`,
    );
  }

  for (const relPath of metadataPaths) {
    const absolutePath = resolveInsideDataset(datasetRoot, relPath);
    if (!absolutePath) continue;

    const stat = await statFileOrNull(absolutePath);
    if (!stat) continue;

    const handle = await openParquet(
      absolutePath,
      relPath,
      stat.size,
      stat.mtimeMs,
    );
    const rows = (await parquetReadObjects({
      file: handle.file,
      metadata: handle.metadata,
      columns: LOCATOR_COLUMNS,
    })) as Record<string, unknown>[];

    for (const row of rows) {
      if (bigIntToNumber(row["episode_index"], -1) !== episodeIndex) continue;
      return {
        episodeIndex,
        relPath: buildDataPathFromRow(row),
        fromIndex: bigIntToNumber(row["dataset_from_index"], 0),
        toIndex: bigIntToNumber(row["dataset_to_index"], 0),
      };
    }
  }

  return null;
}

function buildDataPathFromRow(row: Record<string, unknown>): string {
  return buildV3DataPath(
    bigIntToNumber(row["data/chunk_index"], 0),
    bigIntToNumber(row["data/file_index"], 0),
  );
}

import {
  asyncBufferFromUrl,
  cachedAsyncBuffer,
  parquetRead,
  parquetReadObjects,
  type AsyncBuffer,
} from "hyparquet";
import { parseLocalDatasetFileApiUrl } from "@/utils/datasetRoute";

export interface DatasetMetadata {
  codebase_version: string;
  robot_type: string;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  total_videos: number;
  total_chunks: number;
  chunks_size: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string;
  features: Record<
    string,
    {
      dtype: string;
      shape: number[];
      names: string[] | Record<string, unknown> | null;
      info?: Record<string, unknown>;
    }
  >;
}

export async function fetchJson<T>(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const localJson = await readServerLocalDatasetText(url);
  if (localJson !== null) {
    return JSON.parse(localJson) as T;
  }

  const controller =
    options.timeoutMs === undefined ? null : new AbortController();
  const timeoutId =
    controller && options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: controller?.signal,
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (!res.ok) {
    throw new Error(
      `Failed to fetch JSON ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

export function formatStringWithVars(
  format: string,
  vars: Record<string, string | number>,
): string {
  return format.replace(/{(\w+)(?::\d+d)?}/g, (_, key) => String(vars[key]));
}

// Fetch and parse the Parquet file
type ParquetFile = ArrayBuffer | AsyncBuffer;

const parquetFileCache = new Map<string, AsyncBuffer>();
async function serverLocalFileModules() {
  // NEXT_RUNTIME is replaced at build time. Keep filesystem imports inside
  // this branch so the client bundle never includes Node-only modules. The
  // undefined case supports callers outside Next, including the test runner.
  if (
    process.env.NEXT_RUNTIME === "nodejs" ||
    process.env.NEXT_RUNTIME === undefined
  ) {
    return Promise.all([
      import("@/lib/local-dataset-paths"),
      import("node:fs/promises"),
    ]);
  }
  return null;
}

export async function fetchParquetFile(url: string): Promise<ParquetFile> {
  const cached = parquetFileCache.get(url);
  if (cached) return cached;

  const file =
    (await openServerLocalDatasetParquet(url)) ??
    (await asyncBufferFromUrl({
      url,
      requestInit: { cache: "no-store" },
    }));
  const wrapped = cachedAsyncBuffer(file);
  parquetFileCache.set(url, wrapped);
  return wrapped;
}

async function readServerLocalDatasetText(url: string): Promise<string | null> {
  if (typeof window !== "undefined") return null;

  const localFile = parseLocalDatasetFileApiUrl(url);
  if (!localFile) return null;

  const modules = await serverLocalFileModules();
  if (!modules) return null;
  const [{ statDatasetFile }, fs] = modules;
  const file = await statDatasetFile(localFile.encodedPath, localFile.filePath);
  if (!file) return null;
  return fs.readFile(file.absolutePath, "utf8");
}

async function openServerLocalDatasetParquet(
  url: string,
): Promise<AsyncBuffer | null> {
  if (typeof window !== "undefined") return null;

  const localFile = parseLocalDatasetFileApiUrl(url);
  if (!localFile) return null;

  const modules = await serverLocalFileModules();
  if (!modules) return null;
  const [{ statDatasetFile }, fs] = modules;
  const file = await statDatasetFile(localFile.encodedPath, localFile.filePath);
  if (!file) return null;
  return {
    byteLength: file.size,
    async slice(start, end = file.size) {
      // AsyncBuffer follows ArrayBuffer.slice: end is exclusive, and footer
      // reads may use a negative start. Node streams use an inclusive end.
      const from = Math.min(
        file.size,
        Math.max(0, start < 0 ? file.size + start : start),
      );
      const to = Math.min(
        file.size,
        Math.max(0, end < 0 ? file.size + end : end),
      );
      const bytes = new Uint8Array(Math.max(0, to - from));
      if (bytes.length === 0) return bytes.buffer;
      const handle = await fs.open(file.absolutePath, "r");
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            from + offset,
          );
          if (bytesRead === 0)
            throw new Error("Unexpected end of local Parquet file.");
          offset += bytesRead;
        }
        return bytes.buffer;
      } finally {
        await handle.close();
      }
    },
  };
}

// Read specific columns from the Parquet file
export async function readParquetColumn(
  fileBuffer: ParquetFile,
  columns: string[],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    try {
      parquetRead({
        file: fileBuffer,
        columns: columns.length > 0 ? columns : undefined,
        rowStart: options?.rowStart,
        rowEnd: options?.rowEnd,
        onComplete: (data: unknown[][]) => {
          resolve(data);
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function readParquetAsObjects(
  fileBuffer: ParquetFile,
  columns: string[] = [],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({
    file: fileBuffer,
    columns: columns.length > 0 ? columns : undefined,
    rowStart: options?.rowStart,
    rowEnd: options?.rowEnd,
  }) as Promise<Record<string, unknown>[]>;
}

// Convert a 2D array to a CSV string
export function arrayToCSV(data: (number | string)[][]): string {
  return data.map((row) => row.join(",")).join("\n");
}

type ColumnInfo = { key: string; value: string[] };

export function getRows(currentFrameData: unknown[], columns: ColumnInfo[]) {
  if (!currentFrameData || currentFrameData.length === 0) {
    return [];
  }

  const rows: Array<Array<{ isNull: true } | unknown>> = [];
  const nRows = Math.max(...columns.map((column) => column.value.length));
  let rowIndex = 0;

  while (rowIndex < nRows) {
    const row: Array<{ isNull: true } | unknown> = [];
    // number of states may NOT match number of actions. In this case, we null-pad the 2D array
    const nullCell = { isNull: true };
    // row consists of [state value, action value]
    let idx = rowIndex;

    for (const column of columns) {
      const nColumn = column.value.length;
      row.push(rowIndex < nColumn ? currentFrameData[idx] : nullCell);
      idx += nColumn; // because currentFrameData = [state0, state1, ..., stateN, action0, action1, ..., actionN]
    }

    rowIndex += 1;
    rows.push(row);
  }

  return rows;
}

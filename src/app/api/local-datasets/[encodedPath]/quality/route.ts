import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  resolveDatasetRoot,
  resolveInsideDataset,
} from "@/lib/local-dataset-paths";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { openParquet, readParquetRowsRaw } from "@/lib/parquet-server";
import {
  DEFAULT_DATASET_QUALITY_CONFIG,
  runDatasetChecks,
  type DatasetQualityCheckResult,
  type DatasetQualityTask,
} from "@/utils/datasetQualityChecks";
import { bigIntToNumber } from "@/utils/typeGuards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TASK_ROWS = 10_000;

export interface DatasetQualityResponse {
  datasetName: string;
  tasks: DatasetQualityTask[];
  checks: DatasetQualityCheckResult[];
  aggregate: ReturnType<typeof runDatasetChecks>["aggregate"];
  config: typeof DEFAULT_DATASET_QUALITY_CONFIG;
}

function taskIndex(value: unknown, fallback: number): number {
  const parsed = bigIntToNumber(value, fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTaskRows(
  rows: Record<string, unknown>[],
): DatasetQualityTask[] {
  const tasks: DatasetQualityTask[] = [];
  const seen = new Set<string>();

  for (const [rowIndex, row] of rows.entries()) {
    const rawTask =
      row.__index_level_0__ ?? row.task ?? row.language_instruction;
    if (typeof rawTask !== "string" || rawTask.trim() === "") continue;
    const task = rawTask.trim();
    const index = taskIndex(row.task_index, rowIndex);
    const key = `${index}\u0000${task}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ index, task });
  }

  return tasks;
}

async function readJsonTasks(
  datasetRoot: string,
): Promise<DatasetQualityTask[]> {
  for (const filename of ["tasks.jsonl", "tasks.json"]) {
    const absolutePath = resolveInsideDataset(datasetRoot, "meta", filename);
    if (!absolutePath) continue;

    try {
      const text = await fs.readFile(absolutePath, "utf8");
      const values = filename.endsWith("jsonl")
        ? text
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [JSON.parse(text) as unknown];
      const rows = Array.isArray(values[0])
        ? (values[0] as Record<string, unknown>[])
        : (values as Record<string, unknown>[]);
      const normalized = normalizeTaskRows(rows);
      if (normalized.length > 0) return normalized;
    } catch {
      // Try the next supported metadata representation.
    }
  }
  return [];
}

async function readTasks(datasetRoot: string): Promise<DatasetQualityTask[]> {
  const parquetPath = resolveInsideDataset(
    datasetRoot,
    "meta",
    "tasks.parquet",
  );
  if (parquetPath) {
    try {
      const stat = await fs.stat(parquetPath);
      if (stat.isFile()) {
        const handle = await openParquet(
          parquetPath,
          "meta/tasks.parquet",
          Number(stat.size),
          stat.mtimeMs,
        );
        const rows = await readParquetRowsRaw(
          handle,
          0,
          Math.min(handle.info.numRows, MAX_TASK_ROWS),
          ["__index_level_0__", "task", "task_index", "language_instruction"],
        );
        const normalized = normalizeTaskRows(rows);
        if (normalized.length > 0) return normalized;
      }
    } catch {
      // Fall back to JSON metadata below.
    }
  }

  return readJsonTasks(datasetRoot);
}

async function readInfo(
  datasetRoot: string,
): Promise<Record<string, unknown> | null> {
  const infoPath = resolveInsideDataset(datasetRoot, "meta", "info.json");
  if (!infoPath) return null;
  try {
    return JSON.parse(await fs.readFile(infoPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function datasetDisplayName(datasetRoot: string): string {
  try {
    const relative = path
      .relative(path.resolve(resolveLocalDatasetRoot()), datasetRoot)
      .split(path.sep)
      .join("/");
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  } catch {
    // The configured root may not be available in an unusual test/runtime.
  }

  const dataset = path.basename(datasetRoot);
  const org = path.basename(path.dirname(datasetRoot));
  return org && org !== path.basename(datasetRoot)
    ? `${org}/${dataset}`
    : dataset;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetRoot = resolveDatasetRoot(encodedPath);
  if (!datasetRoot)
    return Response.json({ error: "Dataset not found" }, { status: 404 });

  const info = await readInfo(datasetRoot);
  if (!info)
    return Response.json(
      { error: "Dataset metadata is unavailable" },
      { status: 404 },
    );

  const tasks = await readTasks(datasetRoot);
  const dataset = {
    dataset_name: datasetDisplayName(datasetRoot),
    total_episodes:
      typeof info.total_episodes === "number" ? info.total_episodes : 0,
    duration_hours:
      typeof info.total_frames === "number" &&
      typeof info.fps === "number" &&
      info.fps > 0
        ? info.total_frames / info.fps / 3600
        : 0,
    tasks,
  };
  const result = runDatasetChecks(dataset, DEFAULT_DATASET_QUALITY_CONFIG);

  const payload: DatasetQualityResponse = {
    datasetName: dataset.dataset_name,
    tasks,
    checks: result.results,
    aggregate: result.aggregate,
    config: DEFAULT_DATASET_QUALITY_CONFIG,
  };

  return Response.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}

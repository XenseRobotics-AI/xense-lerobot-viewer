import fs from "node:fs/promises";
import { openParquet, readParquetRowsRaw } from "@/lib/parquet-server";
import { resolveInsideDataset } from "@/lib/local-dataset-paths";
import { bigIntToNumber } from "@/utils/typeGuards";
import type { DatasetQualityTask } from "@/utils/datasetQualityChecks";

const MAX_TASK_ROWS = 10_000;

function normalizeRows(rows: Record<string, unknown>[]): DatasetQualityTask[] {
  const tasks: DatasetQualityTask[] = [];
  const seen = new Set<string>();
  for (const [rowIndex, row] of rows.entries()) {
    const raw = row.__index_level_0__ ?? row.task ?? row.language_instruction;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const task = raw.trim();
    const parsed = bigIntToNumber(row.task_index, rowIndex);
    const index = Number.isFinite(parsed) ? parsed : rowIndex;
    const key = `${index}\u0000${task}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ index, task });
  }
  return tasks;
}

async function readJsonTasks(root: string): Promise<DatasetQualityTask[]> {
  for (const name of ["tasks.jsonl", "tasks.json"]) {
    const file = resolveInsideDataset(root, "meta", name);
    if (!file) continue;
    try {
      const text = await fs.readFile(file, "utf8");
      const values = name.endsWith("jsonl")
        ? text
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [JSON.parse(text)];
      const rows = Array.isArray(values[0]) ? values[0] : values;
      const tasks = normalizeRows(rows as Record<string, unknown>[]);
      if (tasks.length) return tasks;
    } catch {
      // Try the next representation.
    }
  }
  return [];
}

export async function readDatasetTasks(
  root: string,
): Promise<DatasetQualityTask[]> {
  const file = resolveInsideDataset(root, "meta", "tasks.parquet");
  if (file) {
    try {
      const stat = await fs.stat(file);
      const handle = await openParquet(
        file,
        "meta/tasks.parquet",
        stat.size,
        stat.mtimeMs,
      );
      const rows = await readParquetRowsRaw(
        handle,
        0,
        Math.min(handle.info.numRows, MAX_TASK_ROWS),
        ["__index_level_0__", "task", "task_index", "language_instruction"],
      );
      const tasks = normalizeRows(rows);
      if (tasks.length) return tasks;
    } catch {
      // Fall back to JSON metadata.
    }
  }
  return readJsonTasks(root);
}

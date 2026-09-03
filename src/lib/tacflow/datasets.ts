import { readFile } from "node:fs/promises";
import path from "node:path";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  isAbsoluteDatasetPath,
  normalizeRelativeLocalDatasetPath,
} from "@/utils/datasetRoute";
import { DEFAULT_TACFLOW_DATASET_RELATIVE_PATH } from "@/lib/tacflow/constants";

export { DEFAULT_TACFLOW_DATASET_RELATIVE_PATH } from "@/lib/tacflow/constants";

export const TACFLOW_ENGINE_ROOT = "/home/xense/src/TacFlow-Engine";
export const TACFLOW_TACTILE_ROOT = path.join(
  TACFLOW_ENGINE_ROOT,
  "third_party",
  "tacflow-tactile-detect",
);

const REPAIRED_DATASET_SUFFIX = "-repair-tactile-0902";

export type TacFlowDatasetSelection = {
  relativePath: string;
  sourceDataset: string;
  sourceName: string;
  sourceScanOutput: string;
  sourceScanDir: string;
  sourceReport: string;
  repairedDataset: string;
  recheckOutput: string;
  recheckDir: string;
  repairManifest: string;
  reportDir: string;
  doctorBeforeMarkdown: string;
  doctorBeforeJson: string;
  autoProcessJson: string;
};

function sanitizeOutputName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function normalizeRequestedDatasetPath(
  value: unknown,
): { ok: true; relativePath: string } | { ok: false; error: string } {
  if (value == null) {
    return { ok: true, relativePath: DEFAULT_TACFLOW_DATASET_RELATIVE_PATH };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "datasetPath must be a string." };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "datasetPath cannot be empty." };
  }
  if (isAbsoluteDatasetPath(trimmed)) {
    return {
      ok: false,
      error: "datasetPath must be relative to the local dataset root.",
    };
  }

  try {
    return {
      ok: true,
      relativePath: normalizeRelativeLocalDatasetPath(trimmed),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid datasetPath.",
    };
  }
}

function buildSelection(
  root: string,
  relativePath: string,
): TacFlowDatasetSelection {
  const sourceDataset = path.resolve(root, ...relativePath.split("/"));
  const sourceName = path.posix.basename(relativePath);
  const sourceScanOutput = sanitizeOutputName(sourceName) || "dataset";
  const sourceScanDir = path.join(TACFLOW_TACTILE_ROOT, sourceScanOutput);
  const sourceReport = path.join(sourceScanDir, "report.json");
  const repairedDataset = path.join(
    path.dirname(sourceDataset),
    `${sourceName}${REPAIRED_DATASET_SUFFIX}`,
  );
  const recheckOutput =
    sanitizeOutputName(`${sourceName}${REPAIRED_DATASET_SUFFIX}`) ||
    "dataset-repair-tactile";
  const recheckDir = path.join(TACFLOW_TACTILE_ROOT, recheckOutput);
  const repairManifest = path.join(
    repairedDataset,
    "meta",
    "tacflow",
    "tactile_repair_manifest.json",
  );
  const reportDir = path.join(sourceDataset, ".tacflow");

  return {
    relativePath,
    sourceDataset,
    sourceName,
    sourceScanOutput,
    sourceScanDir,
    sourceReport,
    repairedDataset,
    recheckOutput,
    recheckDir,
    repairManifest,
    reportDir,
    doctorBeforeMarkdown: path.join(reportDir, "doctor-before.md"),
    doctorBeforeJson: path.join(reportDir, "doctor-before.json"),
    autoProcessJson: path.join(reportDir, "auto-process.json"),
  };
}

export async function resolveTacFlowDataset(
  value: unknown,
): Promise<
  { ok: true; dataset: TacFlowDatasetSelection } | { ok: false; error: string }
> {
  const normalized = normalizeRequestedDatasetPath(value);
  if (!normalized.ok) return normalized;

  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unable to resolve local dataset root.",
    };
  }

  const rootPath = path.resolve(root);
  const dataset = buildSelection(rootPath, normalized.relativePath);
  if (!isInsideRoot(rootPath, dataset.sourceDataset)) {
    return {
      ok: false,
      error: "datasetPath must stay inside the local dataset root.",
    };
  }

  try {
    await readFile(
      path.join(dataset.sourceDataset, "meta", "info.json"),
      "utf8",
    );
  } catch {
    return {
      ok: false,
      error: `Unknown local dataset: ${dataset.relativePath}`,
    };
  }

  return { ok: true, dataset };
}

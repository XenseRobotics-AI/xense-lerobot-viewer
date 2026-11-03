/**
 * Locate and read TacFlow's ④ annotation report for a dataset (server side, read-only).
 *
 * TacFlow keeps audit next to the corpus, never inside a dataset: the registry is `<corpus>/.registry/`,
 * the dataset sits at `<corpus>/<bucket>/<name>`, and a dataset outside any bucket (a test or scratch
 * folder) has its registry beside it at `<parent>/.registry/`. So the registry is looked up in the
 * dataset's parent, then grandparent. Its per-dataset snapshot `datasets/<name>.json` names the latest
 * `annotate` report relative to the registry root; that path must stay inside the registry.
 *
 * Nothing here writes — annotations are edited (or re-run) in TacFlow, not in the viewer.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  AUTO_ANNOTATION_SCHEMA,
  normalizeEpisode,
  type AutoAnnotationResponse,
} from "@/types/auto-annotation.types";

const REGISTRY_DIRNAME = ".registry";
const ANNOTATE_STAGE = "annotate";

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The registry root holding this dataset's snapshot, or null. */
export async function findRegistryRoot(
  datasetDir: string,
): Promise<string | null> {
  const name = path.basename(datasetDir);
  const parent = path.dirname(datasetDir);
  for (const base of [parent, path.dirname(parent)]) {
    const root = path.join(base, REGISTRY_DIRNAME);
    try {
      await fs.access(path.join(root, "datasets", `${name}.json`));
      return root;
    } catch {
      // try the next level
    }
  }
  return null;
}

export type AutoAnnotationLookup =
  | { status: "ok"; body: AutoAnnotationResponse }
  | { status: "none"; reason: string };

/** The report's view of one episode, or why there is none. */
export async function loadAutoAnnotation(
  datasetDir: string,
  episode: number,
): Promise<AutoAnnotationLookup> {
  const registry = await findRegistryRoot(datasetDir);
  if (!registry)
    return {
      status: "none",
      reason: "no TacFlow registry next to this dataset",
    };
  const snapshot = await readJson(
    path.join(registry, "datasets", `${path.basename(datasetDir)}.json`),
  );
  const stages =
    isRecord(snapshot) && isRecord(snapshot.stages) ? snapshot.stages : {};
  const stage = isRecord(stages[ANNOTATE_STAGE])
    ? stages[ANNOTATE_STAGE]
    : null;
  if (!stage || typeof stage.report !== "string") {
    return {
      status: "none",
      reason: "this dataset has no annotate result in the registry",
    };
  }
  const reportPath = path.resolve(registry, stage.report);
  if (!reportPath.startsWith(path.resolve(registry) + path.sep)) {
    return {
      status: "none",
      reason: "the registry names a report outside the registry",
    };
  }
  const report = await readJson(reportPath);
  if (
    !isRecord(report) ||
    report.schema !== AUTO_ANNOTATION_SCHEMA ||
    !Array.isArray(report.episodes)
  ) {
    return {
      status: "none",
      reason: `the report is not ${AUTO_ANNOTATION_SCHEMA}`,
    };
  }
  const entry = report.episodes.find(
    (e: unknown) => isRecord(e) && e.episode_index === episode,
  );
  return {
    status: "ok",
    body: {
      dataset: String(report.dataset ?? path.basename(datasetDir)),
      models: Array.isArray(report.models) ? report.models.map(String) : [],
      annotated_at: typeof stage.at === "string" ? stage.at : null,
      episodes_total: Number(report.episodes_total ?? report.episodes.length),
      episodes_usable: Number(report.episodes_usable ?? 0),
      episode: entry === undefined ? null : normalizeEpisode(entry),
    },
  };
}

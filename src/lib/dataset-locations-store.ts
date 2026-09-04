/**
 * The dataset paths this machine can browse, and which one is being browsed.
 *
 * `LOCAL_DATASET_ROOT` fixes one directory at server start, so a dataset
 * written anywhere else — a conversion landing in `/archive/TacVerse`, an
 * archive drive — used to be unreachable without restarting with a different
 * environment. This module keeps a list of alternative directories at
 * `<root>/.xense-viewer/locations.json`, next to the corpus history, so the
 * homepage's path switcher can point the scan at one of them instead.
 *
 * The default root stays the anchor: the list, the corpus history and the
 * trash all live under it whichever path is being browsed. Only *discovery*
 * follows the selection.
 *
 * Every function takes the root explicitly rather than resolving it, which
 * keeps this module free of an import cycle with the discovery scanner.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDatasetPathInput } from "@/utils/datasetRoute";

const STORE_DIR = ".xense-viewer";
const STORE_FILE = "locations.json";
const FILE_VERSION = 1;
/** How deep `countDatasetsUnder` looks; mirrors the discovery scanner. */
const MAX_COUNT_DEPTH = 3;
const IGNORE_DIRS = new Set([
  "calibration",
  ".cache",
  ".git",
  "node_modules",
  "__pycache__",
]);

export type DatasetLocation = {
  /** Absolute, normalized directory. */
  path: string;
  addedAt: string;
};

type LocationsFile = {
  version: number;
  locations: DatasetLocation[];
};

export function locationsFilePath(root: string): string {
  return path.join(root, STORE_DIR, STORE_FILE);
}

/**
 * Turn what a person typed into an absolute path: trims, accepts `file://`,
 * expands a leading `~`, and resolves `.`/`..`. Relative paths are refused —
 * "relative to what" has no good answer on a server.
 */
export function normalizeLocationInput(value: string): string {
  let candidate = normalizeDatasetPathInput(value.trim());
  if (!candidate) {
    throw new Error("Path cannot be empty.");
  }
  if (candidate === "~" || candidate.startsWith("~/")) {
    const home = process.env.HOME?.trim();
    if (!home) throw new Error("Cannot expand '~': HOME is not set.");
    candidate = path.join(home, candidate.slice(1));
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error(`Path must be absolute: ${candidate}`);
  }
  return path.resolve(candidate);
}

async function isDataset(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, "meta", "info.json"));
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Datasets (directories carrying `meta/info.json`) under `dir`, itself included. */
export async function countDatasetsUnder(
  dir: string,
  depth = 0,
): Promise<number> {
  if (depth > MAX_COUNT_DEPTH) return 0;
  if (await isDataset(dir)) return 1;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const counts = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !IGNORE_DIRS.has(entry.name),
      )
      .map((entry) =>
        countDatasetsUnder(path.join(dir, entry.name), depth + 1),
      ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

export type LocationInspection = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** The directory itself is a dataset. */
  isDataset: boolean;
  /** Datasets reachable below it (the directory itself included). */
  datasetCount: number;
};

export async function inspectLocation(
  value: string,
): Promise<LocationInspection> {
  const target = normalizeLocationInput(value);
  let isDirectory = false;
  let exists = false;
  try {
    const stat = await fs.stat(target);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    exists = false;
  }
  return {
    path: target,
    exists,
    isDirectory,
    isDataset: isDirectory ? await isDataset(target) : false,
    datasetCount: isDirectory ? await countDatasetsUnder(target) : 0,
  };
}

export async function readLocations(root: string): Promise<DatasetLocation[]> {
  let raw: string;
  try {
    raw = await fs.readFile(locationsFilePath(root), "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // a corrupt file must not take the homepage down
  }
  const file = parsed as Partial<LocationsFile> | null;
  if (!file || !Array.isArray(file.locations)) return [];
  const seen = new Set<string>();
  const locations: DatasetLocation[] = [];
  for (const entry of file.locations) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = (entry as Partial<DatasetLocation>).path;
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    const normalized = path.resolve(candidate);
    if (seen.has(normalized) || normalized === path.resolve(root)) continue;
    seen.add(normalized);
    locations.push({
      path: normalized,
      addedAt:
        typeof (entry as Partial<DatasetLocation>).addedAt === "string"
          ? (entry as DatasetLocation).addedAt
          : "",
    });
  }
  return locations;
}

/** Writes `tmp` then renames, like the tags and history stores. */
export async function writeLocations(
  root: string,
  locations: DatasetLocation[],
): Promise<void> {
  const file = locationsFilePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload: LocationsFile = { version: FILE_VERSION, locations };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, file);
}

/**
 * Add a directory to the switcher's list. Refuses what cannot be browsed —
 * a missing path, a file, the default root (already the first entry). Adding
 * something already listed is a no-op rather than an error.
 */
export async function addLocation(
  root: string,
  value: string,
): Promise<{ locations: DatasetLocation[]; inspection: LocationInspection }> {
  const inspection = await inspectLocation(value);
  if (!inspection.exists) {
    throw new Error(`Directory does not exist: ${inspection.path}`);
  }
  if (!inspection.isDirectory) {
    throw new Error(`Not a directory: ${inspection.path}`);
  }
  if (inspection.path === path.resolve(root)) {
    throw new Error(`${inspection.path} is the default dataset root.`);
  }
  const current = await readLocations(root);
  if (current.some((entry) => entry.path === inspection.path)) {
    return { locations: current, inspection };
  }
  const locations = [
    ...current,
    { path: inspection.path, addedAt: new Date().toISOString() },
  ];
  await writeLocations(root, locations);
  return { locations, inspection };
}

export async function removeLocation(
  root: string,
  value: string,
): Promise<DatasetLocation[]> {
  const target = normalizeLocationInput(value);
  const current = await readLocations(root);
  const locations = current.filter((entry) => entry.path !== target);
  if (locations.length !== current.length) {
    await writeLocations(root, locations);
  }
  return locations;
}

/**
 * Which path this request browses: the one the cookie names, but only when it
 * is a listed location. Anything else — no cookie, a stale entry, a value
 * someone typed into their browser — falls back to the default root, so the
 * cookie can never point the scan at an arbitrary directory.
 */
export async function resolveBrowsePath(
  root: string,
  requested: string | undefined,
): Promise<string> {
  const value = requested?.trim();
  if (!value) return root;
  let target: string;
  try {
    target = normalizeLocationInput(value);
  } catch {
    return root;
  }
  if (target === path.resolve(root)) return root;
  const locations = await readLocations(root);
  return locations.some((entry) => entry.path === target) ? target : root;
}

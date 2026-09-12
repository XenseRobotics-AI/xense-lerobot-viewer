/**
 * Remembered `sizeBytes` per dataset, so scanning a large location is not a
 * fresh `lstat` of every file on it.
 *
 * `directorySizeBytes` walks the whole dataset directory, which is genuinely
 * cheap on the default root (~8 ms for 20 datasets / 4k files on an SSD) and
 * genuinely not on a big archive over slow storage. Measured on the dev box's
 * exFAT USB drive: `/media/.../TacVerse-opendata` is 162 datasets / 52k files
 * and the size walk alone is 9.2 s of a 9.6 s scan — 96% of it — while
 * `/media/.../TacVerse` (612 datasets / 175k files) takes 46 s with a warm
 * dentry cache and minutes cold. That is a homepage render, so the path
 * switcher looked like it had simply failed.
 *
 * So the walk is remembered, keyed on the absolute dataset directory and a
 * cheap fingerprint of it, in one file under the **default root** next to the
 * other stores (the root anchors the stores whichever path is being browsed).
 * Entries from every location live together, so switching back and forth does
 * not evict.
 *
 * A miss costs exactly what it cost before; a hit costs the fingerprint. Every
 * failure is swallowed — an unreadable or unwritable store degrades to the old
 * behaviour, never to a broken homepage.
 */

import fs from "node:fs/promises";
import path from "node:path";

const STORE_DIR = ".xense-viewer";
const STORE_FILE = "dataset-sizes.json";
const FILE_VERSION = 1;
/**
 * Entries kept, least-recently-seen evicted first. The corpus is ~800 datasets
 * across every location on this machine, so this is headroom rather than a
 * limit that bites; it exists so a directory that is renamed on every export
 * cannot grow the file without bound.
 */
const MAX_ENTRIES = 4000;

export type DatasetSizeEntry = {
  bytes: number;
  fingerprint: string;
  /** ISO day — only used to choose what to evict. */
  lastSeen: string;
};

type SizeCacheFile = {
  version: number;
  entries: Record<string, DatasetSizeEntry>;
};

export function datasetSizeCachePath(root: string): string {
  return path.join(root, STORE_DIR, STORE_FILE);
}

async function mtimeOf(target: string): Promise<string> {
  try {
    const stat = await fs.stat(target);
    return String(stat.mtimeMs);
  } catch {
    return "-"; // absent is a fingerprint too: adding `videos/` must invalidate
  }
}

/**
 * A cheap stand-in for "has anything under this dataset changed".
 *
 * Directory mtime only moves when a *direct* child is added, removed or
 * renamed, so the dataset directory alone is not enough — a sync or an
 * `export_subtasks.py` run writes inside `data/chunk-000/`, which moves that
 * directory's mtime and nothing above it. The fingerprint therefore covers the
 * dataset directory, `meta/`, `data/`, `videos/` **and the immediate children
 * of the latter two**, which is where lerobot puts its chunks. That is ~12
 * syscalls against the ~300 an `lstat` of every file costs.
 *
 * It is a heuristic, and the thing it can miss is a file rewritten in place
 * with no directory change at all. The cost of missing is a stale number in a
 * storage column, not a wrong dataset — so this is the right trade. Deleting
 * the file forces a full recount.
 */
export async function datasetSizeFingerprint(
  datasetDir: string,
): Promise<string> {
  const parts = [
    await mtimeOf(datasetDir),
    await mtimeOf(path.join(datasetDir, "meta")),
  ];
  for (const name of ["data", "videos"]) {
    const dir = path.join(datasetDir, name);
    parts.push(await mtimeOf(dir));
    let children: import("node:fs").Dirent[] = [];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs = children
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const sub of subdirs) {
      parts.push(`${sub}=${await mtimeOf(path.join(dir, sub))}`);
    }
  }
  return parts.join("|");
}

async function readEntries(
  root: string,
): Promise<Map<string, DatasetSizeEntry>> {
  const entries = new Map<string, DatasetSizeEntry>();
  let raw: string;
  try {
    raw = await fs.readFile(datasetSizeCachePath(root), "utf-8");
  } catch {
    return entries;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries; // a corrupt file must not take the homepage down
  }
  const file = parsed as Partial<SizeCacheFile> | null;
  if (!file || file.version !== FILE_VERSION || !file.entries) return entries;
  for (const [key, value] of Object.entries(file.entries)) {
    if (!value || typeof value !== "object") continue;
    const { bytes, fingerprint, lastSeen } = value as Partial<DatasetSizeEntry>;
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) continue;
    if (typeof fingerprint !== "string" || !fingerprint) continue;
    entries.set(key, {
      bytes,
      fingerprint,
      lastSeen: typeof lastSeen === "string" ? lastSeen : "",
    });
  }
  return entries;
}

/** Writes `tmp` then renames, like the locations and history stores. */
async function writeEntries(
  root: string,
  entries: Map<string, DatasetSizeEntry>,
): Promise<void> {
  const pruned = [...entries.entries()];
  if (pruned.length > MAX_ENTRIES) {
    pruned.sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
    pruned.length = MAX_ENTRIES;
  }
  const payload: SizeCacheFile = {
    version: FILE_VERSION,
    entries: Object.fromEntries(pruned),
  };
  const file = datasetSizeCachePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload) + "\n", "utf-8");
  await fs.rename(tmp, file);
}

export type DatasetSizeResolver = {
  /** Bytes for one dataset directory — from the store when it still matches. */
  sizeOf(datasetDir: string): Promise<number>;
  /** Persist what this scan learned. Never throws. */
  flush(): Promise<void>;
};

/**
 * A resolver for one scan. Falls back to walking on any store failure, so the
 * caller has nothing to handle: a read-only root just means no speed-up.
 */
export async function createDatasetSizeResolver(
  root: string,
  walk: (dir: string) => Promise<number>,
): Promise<DatasetSizeResolver> {
  const entries = await readEntries(root).catch(
    () => new Map<string, DatasetSizeEntry>(),
  );
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;

  return {
    async sizeOf(datasetDir) {
      const key = path.resolve(datasetDir);
      const fingerprint = await datasetSizeFingerprint(datasetDir);
      const cached = entries.get(key);
      if (cached && cached.fingerprint === fingerprint) {
        if (cached.lastSeen !== today) {
          cached.lastSeen = today;
          changed = true;
        }
        return cached.bytes;
      }
      const bytes = await walk(datasetDir);
      entries.set(key, { bytes, fingerprint, lastSeen: today });
      changed = true;
      return bytes;
    },
    async flush() {
      if (!changed) return;
      try {
        await writeEntries(root, entries);
      } catch {
        // A read-only root costs the speed-up, nothing else.
      }
    },
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import { WORKBENCH_UPLOADER_NAMES } from "@/utils/workbenchUploaderNames";

export type HfCatalogEntry = {
  repoId?: string;
  org?: string;
  name?: string;
  uploader?: string | null;
  uploaderDisplayName?: string | null;
  lastModified?: string | null;
  totalEpisodes?: number | null;
  totalFrames?: number | null;
  totalTasks?: number | null;
  fps?: number | null;
  durationHours?: number | null;
  robotType?: string | null;
  [key: string]: unknown;
};

export type HfCatalogDocument = {
  datasets?: HfCatalogEntry[];
  [key: string]: unknown;
};

export function hfCatalogCachePath(root: string, org: string): string {
  return path.join(root, ".xense-viewer", "hf-catalog", `${org}.json`);
}

async function readWorkbenchHistory(org: string): Promise<HfCatalogEntry[]> {
  const configured = process.env.TACVERSE_WORKBENCH_DATASET_LOG?.trim();
  const candidates = [
    configured,
    path.resolve(process.cwd(), "..", "tacverse-workbench", "dataset_log.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
        datasets?: Record<
          string,
          { uploader?: unknown; last_modified?: unknown }
        >;
      };
      return Object.entries(parsed.datasets ?? {})
        .filter(([repoId]) => repoId.startsWith(`${org}/`))
        .map(([repoId, metadata]) => ({
          repoId,
          org,
          name: repoId.slice(org.length + 1),
          uploader:
            typeof metadata.uploader === "string" ? metadata.uploader : null,
          lastModified:
            typeof metadata.last_modified === "string"
              ? metadata.last_modified
              : null,
        }));
    } catch {
      // Try the next configured/default Workbench history location.
    }
  }
  return [];
}

function withDisplayName(entry: HfCatalogEntry): HfCatalogEntry {
  const uploader =
    typeof entry.uploader === "string" && entry.uploader.trim()
      ? entry.uploader.trim()
      : null;
  return {
    ...entry,
    uploader,
    uploaderDisplayName:
      entry.uploaderDisplayName ||
      (uploader ? WORKBENCH_UPLOADER_NAMES[uploader] : null) ||
      null,
  };
}

function modifiedTime(entry: HfCatalogEntry): number {
  const value = entry.lastModified;
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export async function mergeWorkbenchHistory(
  catalog: HfCatalogDocument,
  org: string,
): Promise<HfCatalogDocument> {
  const current = Array.isArray(catalog.datasets) ? catalog.datasets : [];
  const byRepo = new Map<string, HfCatalogEntry>();
  for (const entry of await readWorkbenchHistory(org)) {
    if (entry.repoId) byRepo.set(entry.repoId, entry);
  }
  // Live HF metadata is authoritative for repositories present in both data
  // sources; the Workbench log only restores uploader/time for older entries
  // omitted by the current Hub listing.
  for (const entry of current) {
    if (!entry.repoId) continue;
    byRepo.set(entry.repoId, { ...byRepo.get(entry.repoId), ...entry });
  }
  return {
    ...catalog,
    datasets: [...byRepo.values()]
      .map(withDisplayName)
      .sort(
        (left, right) =>
          modifiedTime(right) - modifiedTime(left) ||
          String(left.repoId).localeCompare(String(right.repoId)),
      ),
  };
}

export async function readHfCatalog(
  root: string,
  org: string,
): Promise<HfCatalogDocument> {
  const raw = await fs.readFile(hfCatalogCachePath(root, org), "utf8");
  return mergeWorkbenchHistory(JSON.parse(raw) as HfCatalogDocument, org);
}

import fs from "node:fs/promises";
import path from "node:path";
import type { HfCatalogDocument, HfCatalogEntry } from "@/lib/hf-catalog-cache";
import { canonicalHubDatasetPath } from "@/utils/workbenchHubCategory";

/**
 * ModelScope exposes the same lightweight metadata fields that the
 * Hugging Face catalog uses. Keeping the on-disk shape compatible lets the
 * statistics route share its row-building and aggregation logic.
 */
export type ModelScopeCatalogEntry = HfCatalogEntry;
export type ModelScopeCatalogDocument = HfCatalogDocument;

export function modelscopeCatalogCachePath(root: string, org: string): string {
  return path.join(root, ".xense-viewer", "modelscope-catalog", `${org}.json`);
}

export async function readRawModelScopeCatalog(
  root: string,
  org: string,
): Promise<ModelScopeCatalogDocument> {
  const raw = await fs.readFile(modelscopeCatalogCachePath(root, org), "utf8");
  return JSON.parse(raw) as ModelScopeCatalogDocument;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ModelScopeDeviceEvidence = {
  relativePath: string;
  robotId: string | null;
  collectorSerialNumber: string | null;
  leftGripperSn: string | null;
};

/**
 * Convert cached ModelScope metadata into the device evidence consumed by the
 * Workbench configuration editor. This includes remote-only datasets.
 */
export function modelScopeDeviceEvidence(
  catalog: ModelScopeCatalogDocument,
  organization: string,
): ModelScopeDeviceEvidence[] {
  const byPath = new Map<string, ModelScopeDeviceEvidence>();
  for (const entry of Array.isArray(catalog.datasets) ? catalog.datasets : []) {
    const relativePath = canonicalHubDatasetPath(
      String(entry.repoId ?? ""),
      organization,
    );
    if (!relativePath) continue;
    const robotId = nonEmptyString(entry.robotId);
    const collectorSerialNumber = nonEmptyString(entry.collectorSerialNumber);
    const leftGripperSn = nonEmptyString(entry.leftGripperSn);
    if (!robotId && !collectorSerialNumber && !leftGripperSn) continue;
    const current = byPath.get(relativePath);
    byPath.set(relativePath, {
      relativePath,
      robotId: robotId ?? current?.robotId ?? null,
      collectorSerialNumber:
        collectorSerialNumber ?? current?.collectorSerialNumber ?? null,
      leftGripperSn: leftGripperSn ?? current?.leftGripperSn ?? null,
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

export async function readModelScopeDeviceEvidence(
  root: string,
  organization: string,
): Promise<ModelScopeDeviceEvidence[]> {
  try {
    return modelScopeDeviceEvidence(
      await readRawModelScopeCatalog(root, organization),
      organization,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

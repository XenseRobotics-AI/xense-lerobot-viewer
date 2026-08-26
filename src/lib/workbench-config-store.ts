import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import defaultWorkstationMappingsByOrg from "@/config/workbench-workstation-mappings.json";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";

const STORE_DIR = ".xense-viewer";
const WORKBENCH_DIR = "workbench";
const MAX_ORG_LENGTH = 128;
const MAX_KEY_LENGTH = 128;
const MAX_WORKSTATION_LENGTH = 64;

export type WorkbenchWorkstationMappingSource = "stored" | "defaults";

export type WorkbenchWorkstationMappings = {
  org: string;
  mappings: Record<string, string>;
  source: WorkbenchWorkstationMappingSource;
  updatedAt: string | null;
};

type WorkbenchMappingsFile = {
  org?: unknown;
  mappings?: unknown;
  updatedAt?: unknown;
};

function normalizeOrg(value: string): string {
  const org = value.trim();
  if (!org) throw new Error("A non-empty organization is required.");
  if (org.length > MAX_ORG_LENGTH) {
    throw new Error("Organization is too long.");
  }
  return org;
}

function mappingsPath(root: string, org: string): string {
  return path.join(
    root,
    STORE_DIR,
    WORKBENCH_DIR,
    `${encodeURIComponent(org)}.workstation-mappings.json`,
  );
}

export function normalizeWorkbenchWorkstationMappings(
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key || key.length > MAX_KEY_LENGTH) continue;
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (!value || value.length > MAX_WORKSTATION_LENGTH) continue;
    output[key] = value;
  }
  return output;
}

export function defaultWorkbenchWorkstationMappings(
  org: string,
): Record<string, string> {
  const normalizedOrg = normalizeOrg(org);
  const mappings = (defaultWorkstationMappingsByOrg as Record<string, unknown>)[
    normalizedOrg
  ];
  return normalizeWorkbenchWorkstationMappings(mappings);
}

export async function readWorkbenchWorkstationMappings(
  org: string,
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchWorkstationMappings> {
  const normalizedOrg = normalizeOrg(org);
  try {
    const parsed = JSON.parse(
      await fs.readFile(mappingsPath(root, normalizedOrg), "utf8"),
    ) as WorkbenchMappingsFile;
    return {
      org: normalizedOrg,
      mappings: normalizeWorkbenchWorkstationMappings(parsed.mappings),
      source: "stored",
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : null,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    return {
      org: normalizedOrg,
      mappings: defaultWorkbenchWorkstationMappings(normalizedOrg),
      source: "defaults",
      updatedAt: null,
    };
  }
}

export async function writeWorkbenchWorkstationMappings(
  org: string,
  mappings: Record<string, string>,
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchWorkstationMappings> {
  const normalizedOrg = normalizeOrg(org);
  const normalizedMappings = normalizeWorkbenchWorkstationMappings(mappings);
  const updatedAt = new Date().toISOString();
  const workbenchDir = path.join(root, STORE_DIR, WORKBENCH_DIR);
  await fs.mkdir(workbenchDir, { recursive: true });

  const destination = mappingsPath(root, normalizedOrg);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(
    {
      org: normalizedOrg,
      mappings: normalizedMappings,
      updatedAt,
    },
    null,
    2,
  )}\n`;

  try {
    await fs.writeFile(temporary, payload, "utf8");
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }

  return {
    org: normalizedOrg,
    mappings: normalizedMappings,
    source: "stored",
    updatedAt,
  };
}

export function workbenchWorkstationMappingsPath(
  org: string,
  root = resolveLocalDatasetRoot(),
): string {
  return mappingsPath(root, normalizeOrg(org));
}

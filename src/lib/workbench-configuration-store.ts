"server-only";

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { readWorkbenchWorkstationMappings } from "@/lib/workbench-config-store";
import { readWorkbenchPersonnelConfig } from "@/lib/workbench-personnel-store";
import type {
  WorkbenchConfigurationDiagnostic,
  WorkbenchConfigurationResponse,
  WorkbenchConfigurationV2,
} from "@/types/workbench-configuration.types";
import {
  WORKBENCH_DEVICE_TYPE_DESCRIPTORS,
  WorkbenchConfigurationValidationError,
  migrateLegacyWorkbenchConfiguration,
  observeWorkbenchDevices,
  resolveWorkbenchDatasetDevice,
  validateWorkbenchConfiguration,
} from "@/utils/workbenchConfiguration";

const STORE_DIR = ".xense-viewer";
const WORKBENCH_DIR = "workbench";
const CONFIG_SCHEMA = "xense.workbench.configuration/2";

export type WorkbenchDatasetDeviceEvidence = {
  robotId?: string | null;
  collectorSerialNumber?: string | null;
  leftGripperSn?: string | null;
  relativePath?: string;
};

type StoredWorkbenchConfiguration = {
  schema: typeof CONFIG_SCHEMA;
  org: string;
  updatedAt: string;
  config: WorkbenchConfigurationV2;
};

export class WorkbenchConfigurationConflictError extends Error {
  readonly code = "WORKBENCH_CONFIGURATION_CONFLICT";
  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super("Workbench configuration changed since this draft was loaded.");
  }
}

function normalizeOrg(value: string): string {
  const org = value.trim();
  if (!org || org.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(org)) {
    throw new Error("Workbench organization is invalid.");
  }
  return org;
}

export function workbenchConfigurationPath(
  org: string,
  root = resolveLocalDatasetRoot(),
): string {
  return path.join(
    root,
    STORE_DIR,
    WORKBENCH_DIR,
    `${encodeURIComponent(normalizeOrg(org))}.configuration.json`,
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        stableValue((value as Record<string, unknown>)[key]),
      ]),
  );
}

export function workbenchConfigurationRevision(
  config: WorkbenchConfigurationV2,
): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(stableValue(config)))
      .digest("hex")
  );
}

function normalizeRevision(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function datasetDiagnostics(
  datasets: readonly WorkbenchDatasetDeviceEvidence[],
  config: WorkbenchConfigurationV2,
): WorkbenchConfigurationDiagnostic[] {
  const diagnostics: WorkbenchConfigurationDiagnostic[] = [];
  const seen = new Set<string>();
  for (const dataset of datasets) {
    const resolution = resolveWorkbenchDatasetDevice(dataset, config);
    if (!resolution.conflict) continue;
    const signature = resolution.candidates
      .map((entry) =>
        [entry.source, entry.identifier, entry.workstationId].join(":"),
      )
      .join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    diagnostics.push({
      severity: "warning",
      code: "DEVICE_SOURCE_CONFLICT",
      message:
        "Dataset device sources resolve to different workstations; robot_id takes precedence: " +
        resolution.candidates
          .map(
            (entry) =>
              `${entry.source}=${entry.identifier} → ${entry.workstationId}`,
          )
          .join(", ") +
        ".",
      path: dataset.relativePath,
    });
  }
  return diagnostics;
}

function responseFor(
  config: WorkbenchConfigurationV2,
  source: WorkbenchConfigurationResponse["source"],
  updatedAt: string | null,
  datasets: readonly WorkbenchDatasetDeviceEvidence[],
  legacySource: "stored" | "defaults" | null,
): WorkbenchConfigurationResponse {
  const observedDevices = observeWorkbenchDevices(datasets, config);
  const validated = validateWorkbenchConfiguration(config, observedDevices);
  return {
    config: validated.config,
    revision: workbenchConfigurationRevision(validated.config),
    updatedAt,
    source,
    legacySource,
    deviceTypes: WORKBENCH_DEVICE_TYPE_DESCRIPTORS.map((entry) => ({
      ...entry,
      suggestedPrefixes: [...entry.suggestedPrefixes],
    })),
    observedDevices,
    diagnostics: [
      ...validated.diagnostics,
      ...datasetDiagnostics(datasets, validated.config),
    ],
  };
}

async function readStored(
  org: string,
  root: string,
): Promise<StoredWorkbenchConfiguration | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(workbenchConfigurationPath(org, root), "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Stored Workbench configuration must be an object.");
    }
    const record = parsed as Record<string, unknown>;
    if (record.schema !== CONFIG_SCHEMA || record.org !== normalizeOrg(org)) {
      throw new Error("Stored Workbench configuration schema is invalid.");
    }
    const updatedAt =
      typeof record.updatedAt === "string" &&
      Number.isFinite(Date.parse(record.updatedAt))
        ? new Date(record.updatedAt).toISOString()
        : null;
    if (!updatedAt) {
      throw new Error("Stored Workbench configuration timestamp is invalid.");
    }
    return {
      schema: CONFIG_SCHEMA,
      org: normalizeOrg(org),
      updatedAt,
      config: validateWorkbenchConfiguration(record.config).config,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function readWorkbenchConfiguration(
  org: string,
  root = resolveLocalDatasetRoot(),
  datasets: readonly WorkbenchDatasetDeviceEvidence[] = [],
): Promise<WorkbenchConfigurationResponse> {
  const normalizedOrg = normalizeOrg(org);
  const stored = await readStored(normalizedOrg, root);
  if (stored) {
    return responseFor(
      stored.config,
      "stored",
      stored.updatedAt,
      datasets,
      null,
    );
  }
  const [workstations, personnel] = await Promise.all([
    readWorkbenchWorkstationMappings(normalizedOrg, root),
    readWorkbenchPersonnelConfig(normalizedOrg),
  ]);
  const migrated = migrateLegacyWorkbenchConfiguration(
    workstations.mappings,
    personnel,
    datasets,
    normalizedOrg,
  );
  return responseFor(migrated, "migrated", null, datasets, workstations.source);
}

const writeQueues = new Map<string, Promise<void>>();

async function withWriteQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  writeQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (writeQueues.get(key) === queued) writeQueues.delete(key);
  }
}

export async function writeWorkbenchConfiguration(
  org: string,
  input: unknown,
  expectedRevision: string,
  root = resolveLocalDatasetRoot(),
  datasets: readonly WorkbenchDatasetDeviceEvidence[] = [],
  updatedAtOverride?: string,
): Promise<WorkbenchConfigurationResponse> {
  const normalizedOrg = normalizeOrg(org);
  const destination = workbenchConfigurationPath(normalizedOrg, root);
  return withWriteQueue(destination, async () => {
    const current = await readWorkbenchConfiguration(
      normalizedOrg,
      root,
      datasets,
    );
    if (
      !expectedRevision ||
      normalizeRevision(expectedRevision) !== current.revision
    ) {
      throw new WorkbenchConfigurationConflictError(
        normalizeRevision(expectedRevision),
        current.revision,
      );
    }
    const observed = observeWorkbenchDevices(datasets);
    const normalized = validateWorkbenchConfiguration(input, observed);
    const updatedAt =
      updatedAtOverride && Number.isFinite(Date.parse(updatedAtOverride))
        ? new Date(updatedAtOverride).toISOString()
        : new Date().toISOString();
    const document: StoredWorkbenchConfiguration = {
      schema: CONFIG_SCHEMA,
      org: normalizedOrg,
      updatedAt,
      config: normalized.config,
    };
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify(document, null, 2) + "\n",
        "utf8",
      );
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
    return responseFor(normalized.config, "stored", updatedAt, datasets, null);
  });
}

export { WorkbenchConfigurationValidationError };

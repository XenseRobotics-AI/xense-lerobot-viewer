"server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  normalizeWorkbenchWorkstationMappings,
  readWorkbenchWorkstationMappings,
  writeWorkbenchWorkstationMappings,
} from "@/lib/workbench-config-store";
import {
  WORKBENCH_PERSONNEL_CONFIG_PATH,
  readWorkbenchPersonnelConfig,
  validateWorkbenchPersonnelOrganizationConfig,
  writeWorkbenchPersonnelConfig,
} from "@/lib/workbench-personnel-store";
import {
  normalizeWorkbenchRewardRulesInput,
  readWorkbenchRewardRules,
  writeWorkbenchRewardRules,
} from "@/lib/workbench-reward-store";

export const WORKBENCH_SHARED_REPO_ID =
  "XR-Bot0/xense-lerobot-viewer-workbenck-log";
export const WORKBENCH_SHARED_REPO_URL =
  "https://huggingface.co/datasets/" + WORKBENCH_SHARED_REPO_ID;
export const WORKBENCH_SHARED_CONFIG_KINDS = [
  "workstation-mappings",
  "personnel-mapping",
  "reward-rules",
] as const;

const SHARED_SCHEMA = "xense.workbench.config/1";
const EVENT_SCHEMA = "xense.workbench.event/1";
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const STORE_DIR = ".xense-viewer";
const WORKBENCH_DIR = "workbench";
const SHARED_DIR = "shared-sync";
const OUTBOX_DIR = "outbox";
const SENT_DIR = "sent";
const METADATA_FILE = "metadata.json";
const MAX_PENDING_EVENTS = 250;
const MAX_DETAIL_STRING = 20_000;
const MAX_DETAIL_ARRAY = 500;
const MAX_DETAIL_KEYS = 100;
const MAX_DETAIL_DEPTH = 6;
const MAX_DETAIL_BUDGET = 500_000;

export type WorkbenchSharedConfigKind =
  (typeof WORKBENCH_SHARED_CONFIG_KINDS)[number];

export type WorkbenchSharedConfigDocument = {
  schema: typeof SHARED_SCHEMA;
  version: 1;
  kind: WorkbenchSharedConfigKind;
  org: string;
  updatedAt: string;
  data: Record<string, unknown>;
  privacy?: {
    redactedFields: string[];
  };
};

export type WorkbenchSharedEventSource = "workbench" | "tacflow";
export type WorkbenchSharedEventOutcome = "success" | "failed" | "cancelled";
export type WorkbenchSharedEventDetail =
  | string
  | number
  | boolean
  | null
  | WorkbenchSharedEventDetail[]
  | { [key: string]: WorkbenchSharedEventDetail };

export type WorkbenchSharedEvent = {
  schema: typeof EVENT_SCHEMA;
  version: 1;
  id: string;
  occurredAt: string;
  org: string;
  source: WorkbenchSharedEventSource;
  kind: string;
  outcome: WorkbenchSharedEventOutcome;
  details: Record<string, WorkbenchSharedEventDetail>;
};

export type WorkbenchSharedEventInput = {
  org: string;
  source: WorkbenchSharedEventSource;
  kind: string;
  outcome: WorkbenchSharedEventOutcome;
  details?: Record<string, unknown>;
  occurredAt?: string;
};

export type WorkbenchSharedConfigResolution = {
  kind: WorkbenchSharedConfigKind;
  winner: "local" | "remote" | "equal";
  conflict: boolean;
  document: WorkbenchSharedConfigDocument;
};

export type PendingWorkbenchSharedEvent = {
  event: WorkbenchSharedEvent;
  localPath: string;
  remotePath: string;
  content: string;
};

export type WorkbenchSharedSyncMetadata = {
  version: 1;
  repoId: string;
  lastSyncAt: string | null;
  lastCommit: string | null;
  lastCommitUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWorkbenchSharedOrg(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("A Workbench organization is required.");
  }
  const org = value.trim();
  if (!org || org.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(org)) {
    throw new Error("Workbench organization is invalid.");
  }
  return org;
}

function normalizeUpdatedAt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_UPDATED_AT;
  const timestamp = value.trim();
  return Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toISOString()
    : DEFAULT_UPDATED_AT;
}

function sharedRoot(root: string): string {
  return path.join(root, STORE_DIR, WORKBENCH_DIR, SHARED_DIR);
}

function metadataPath(root: string): string {
  return path.join(sharedRoot(root), METADATA_FILE);
}

export function workbenchSharedConfigPath(
  org: string,
  kind: WorkbenchSharedConfigKind,
): string {
  return "configs/" + normalizeWorkbenchSharedOrg(org) + "/" + kind + ".json";
}

function personnelData(
  people: readonly { id: string; displayName: string; email: string }[],
  schedules: Record<string, unknown>,
): Record<string, unknown> {
  return {
    people: people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      email: person.email,
    })),
    schedules,
  };
}

export async function readLocalWorkbenchSharedConfigs(
  org: string,
  root = resolveLocalDatasetRoot(),
): Promise<Record<WorkbenchSharedConfigKind, WorkbenchSharedConfigDocument>> {
  const normalizedOrg = normalizeWorkbenchSharedOrg(org);
  const [workstations, personnel, rewards] = await Promise.all([
    readWorkbenchWorkstationMappings(normalizedOrg, root),
    readWorkbenchPersonnelConfig(normalizedOrg),
    readWorkbenchRewardRules(normalizedOrg, root),
  ]);

  return {
    "workstation-mappings": {
      schema: SHARED_SCHEMA,
      version: 1,
      kind: "workstation-mappings",
      org: normalizedOrg,
      updatedAt: normalizeUpdatedAt(workstations.updatedAt),
      data: { mappings: workstations.mappings },
    },
    "personnel-mapping": {
      schema: SHARED_SCHEMA,
      version: 1,
      kind: "personnel-mapping",
      org: normalizedOrg,
      updatedAt: normalizeUpdatedAt(personnel.updatedAt),
      data: personnelData(personnel.people, personnel.schedules),
    },
    "reward-rules": {
      schema: SHARED_SCHEMA,
      version: 1,
      kind: "reward-rules",
      org: normalizedOrg,
      updatedAt: normalizeUpdatedAt(rewards.updatedAt),
      data: {
        enabled: rewards.enabled,
        dailyTargetHours: rewards.dailyTargetHours,
        levels: rewards.levels,
        qualityBonusByGrade: rewards.qualityBonusByGrade,
      },
    },
  };
}

export function parseWorkbenchSharedConfig(
  value: unknown,
  expectedKind: WorkbenchSharedConfigKind,
  expectedOrg: string,
): WorkbenchSharedConfigDocument {
  if (!isRecord(value))
    throw new Error("Shared configuration must be an object.");
  if (value.schema !== SHARED_SCHEMA || value.version !== 1) {
    throw new Error("Unsupported shared Workbench configuration schema.");
  }
  if (value.kind !== expectedKind) {
    throw new Error(
      "Shared Workbench configuration kind does not match its path.",
    );
  }
  const org = normalizeWorkbenchSharedOrg(value.org);
  if (org !== normalizeWorkbenchSharedOrg(expectedOrg)) {
    throw new Error(
      "Shared Workbench configuration organization does not match.",
    );
  }
  if (!isRecord(value.data)) {
    throw new Error("Shared Workbench configuration data must be an object.");
  }
  const updatedAt = normalizeUpdatedAt(value.updatedAt);
  let data: Record<string, unknown>;

  if (expectedKind === "workstation-mappings") {
    if (!isRecord(value.data.mappings)) {
      throw new Error("Shared workstation mappings are missing.");
    }
    data = {
      mappings: normalizeWorkbenchWorkstationMappings(value.data.mappings),
    };
  } else if (expectedKind === "personnel-mapping") {
    const normalized = validateWorkbenchPersonnelOrganizationConfig(
      value.data,
      updatedAt,
    );
    data = personnelData(normalized.people, normalized.schedules);
  } else {
    const normalized = normalizeWorkbenchRewardRulesInput({
      org,
      ...value.data,
    });
    data = {
      enabled: normalized.enabled,
      dailyTargetHours: normalized.dailyTargetHours,
      levels: normalized.levels,
      qualityBonusByGrade: normalized.qualityBonusByGrade,
    };
  }

  return {
    schema: SHARED_SCHEMA,
    version: 1,
    kind: expectedKind,
    org,
    updatedAt,
    data,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function serializeWorkbenchSharedValue(value: unknown): string {
  return JSON.stringify(stableValue(value), null, 2) + "\n";
}

export function digestWorkbenchSharedValue(value: unknown): string {
  return createHash("sha256")
    .update(serializeWorkbenchSharedValue(value))
    .digest("hex");
}

export function resolveWorkbenchSharedConfig(
  local: WorkbenchSharedConfigDocument,
  remote: WorkbenchSharedConfigDocument | null,
): WorkbenchSharedConfigResolution {
  if (!remote) {
    return {
      kind: local.kind,
      winner: "local",
      conflict: false,
      document: local,
    };
  }

  const localDigest = digestWorkbenchSharedValue(local);
  const remoteDigest = digestWorkbenchSharedValue(remote);
  if (localDigest === remoteDigest) {
    return {
      kind: local.kind,
      winner: "equal",
      conflict: false,
      document: local,
    };
  }

  const localTime = Date.parse(local.updatedAt);
  const remoteTime = Date.parse(remote.updatedAt);
  if (localTime !== remoteTime) {
    const localWins = localTime > remoteTime;
    return {
      kind: local.kind,
      winner: localWins ? "local" : "remote",
      conflict: false,
      document: localWins ? local : remote,
    };
  }

  const localWins = localDigest.localeCompare(remoteDigest) >= 0;
  return {
    kind: local.kind,
    winner: localWins ? "local" : "remote",
    conflict: true,
    document: localWins ? local : remote,
  };
}

export async function applyRemoteWorkbenchSharedConfig(
  document: WorkbenchSharedConfigDocument,
  root = resolveLocalDatasetRoot(),
): Promise<void> {
  const org = normalizeWorkbenchSharedOrg(document.org);
  if (document.kind === "workstation-mappings") {
    await writeWorkbenchWorkstationMappings(
      org,
      document.data.mappings as Record<string, string>,
      root,
      document.updatedAt,
    );
    return;
  }

  if (document.kind === "reward-rules") {
    await writeWorkbenchRewardRules(
      org,
      document.data,
      root,
      document.updatedAt,
    );
    return;
  }

  const normalized = validateWorkbenchPersonnelOrganizationConfig(
    document.data,
    document.updatedAt,
  );
  await writeWorkbenchPersonnelConfig(
    org,
    {
      people: normalized.people,
      schedules: normalized.schedules,
    },
    WORKBENCH_PERSONNEL_CONFIG_PATH,
    document.updatedAt,
  );
}

function redactCredentialText(value: string): string {
  return value
    .replace(/hf_[A-Za-z0-9]{10,}/gu, "[REDACTED]")
    .replace(
      /((?:token|password|secret|authorization|cookie)\s*[:=]\s*)\S+/giu,
      "$1[REDACTED]",
    );
}

function sanitizeDetail(
  value: unknown,
  depth = 0,
  budget = { remaining: MAX_DETAIL_BUDGET },
): WorkbenchSharedEventDetail | undefined {
  if (budget.remaining <= 0) return undefined;
  if (depth > MAX_DETAIL_DEPTH) return "[TRUNCATED]";
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    budget.remaining -= 32;
    return value;
  }
  if (typeof value === "string") {
    const text = redactCredentialText(value).slice(
      0,
      Math.min(MAX_DETAIL_STRING, budget.remaining),
    );
    budget.remaining -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const output: WorkbenchSharedEventDetail[] = [];
    for (const item of value.slice(0, MAX_DETAIL_ARRAY)) {
      const sanitized = sanitizeDetail(item, depth + 1, budget);
      if (sanitized !== undefined) output.push(sanitized);
      if (budget.remaining <= 0) break;
    }
    return output;
  }
  if (!isRecord(value)) return undefined;
  const output: Record<string, WorkbenchSharedEventDetail> = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_DETAIL_KEYS)) {
    if (
      !key ||
      key.length > 80 ||
      /token|password|secret|authorization|cookie/iu.test(key)
    ) {
      continue;
    }
    const sanitized = sanitizeDetail(nested, depth + 1, budget);
    if (sanitized !== undefined) output[key] = sanitized;
    if (budget.remaining <= 0) break;
  }
  return output;
}

function normalizedEventDetails(
  details: Record<string, unknown> | undefined,
): Record<string, WorkbenchSharedEventDetail> {
  const output: Record<string, WorkbenchSharedEventDetail> = {};
  const budget = { remaining: MAX_DETAIL_BUDGET };
  for (const [key, value] of Object.entries(details ?? {}).slice(
    0,
    MAX_DETAIL_KEYS,
  )) {
    if (
      !key ||
      key.length > 80 ||
      /token|password|secret|authorization|cookie/iu.test(key)
    ) {
      continue;
    }
    const sanitized = sanitizeDetail(value, 0, budget);
    if (sanitized !== undefined) output[key] = sanitized;
    if (budget.remaining <= 0) break;
  }
  return output;
}

function validEvent(value: unknown): value is WorkbenchSharedEvent {
  return (
    isRecord(value) &&
    value.schema === EVENT_SCHEMA &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.occurredAt === "string" &&
    typeof value.org === "string" &&
    (value.source === "workbench" || value.source === "tacflow") &&
    typeof value.kind === "string" &&
    (value.outcome === "success" ||
      value.outcome === "failed" ||
      value.outcome === "cancelled") &&
    isRecord(value.details)
  );
}

export async function recordWorkbenchSharedEvent(
  input: WorkbenchSharedEventInput,
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchSharedEvent> {
  const org = normalizeWorkbenchSharedOrg(input.org);
  const occurredAt = normalizeUpdatedAt(
    input.occurredAt ?? new Date().toISOString(),
  );
  const event: WorkbenchSharedEvent = {
    schema: EVENT_SCHEMA,
    version: 1,
    id: randomUUID(),
    occurredAt,
    org,
    source: input.source,
    kind: input.kind.trim().slice(0, 120) || "unknown",
    outcome: input.outcome,
    details: normalizedEventDetails(input.details),
  };
  const directory = path.join(sharedRoot(root), OUTBOX_DIR);
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, event.id + ".json");
  const temporary =
    destination +
    "." +
    process.pid +
    "." +
    randomBytes(6).toString("hex") +
    ".tmp";
  try {
    await fs.writeFile(temporary, serializeWorkbenchSharedValue(event), "utf8");
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return event;
}

export function workbenchSharedEventRemotePath(
  event: Pick<WorkbenchSharedEvent, "id" | "occurredAt">,
): string {
  const day = normalizeUpdatedAt(event.occurredAt).slice(0, 10);
  const [year, month, date] = day.split("-");
  return "events/" + year + "/" + month + "/" + date + "/" + event.id + ".json";
}

export async function listPendingWorkbenchSharedEvents(
  root = resolveLocalDatasetRoot(),
): Promise<PendingWorkbenchSharedEvent[]> {
  const directory = path.join(sharedRoot(root), OUTBOX_DIR);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const pending: PendingWorkbenchSharedEvent[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    if (pending.length >= MAX_PENDING_EVENTS) break;
    const localPath = path.join(directory, name);
    try {
      const event = JSON.parse(await fs.readFile(localPath, "utf8")) as unknown;
      if (!validEvent(event)) continue;
      const normalizedEvent: WorkbenchSharedEvent = {
        ...event,
        org: normalizeWorkbenchSharedOrg(event.org),
        occurredAt: normalizeUpdatedAt(event.occurredAt),
        details: normalizedEventDetails(event.details),
      };
      pending.push({
        event: normalizedEvent,
        localPath,
        remotePath: workbenchSharedEventRemotePath(normalizedEvent),
        content: serializeWorkbenchSharedValue(normalizedEvent),
      });
    } catch {
      // Invalid outbox files remain local for inspection and are never uploaded.
    }
  }
  return pending;
}

export async function markWorkbenchSharedEventsSent(
  events: readonly PendingWorkbenchSharedEvent[],
  root = resolveLocalDatasetRoot(),
): Promise<void> {
  for (const item of events) {
    const day = item.event.occurredAt.slice(0, 10);
    const destinationDir = path.join(sharedRoot(root), SENT_DIR, day);
    await fs.mkdir(destinationDir, { recursive: true });
    await fs
      .rename(
        item.localPath,
        path.join(destinationDir, path.basename(item.localPath)),
      )
      .catch(() => undefined);
  }
}

export async function readWorkbenchSharedSyncMetadata(
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchSharedSyncMetadata> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(metadataPath(root), "utf8"),
    ) as Partial<WorkbenchSharedSyncMetadata>;
    return {
      version: 1,
      repoId: WORKBENCH_SHARED_REPO_ID,
      lastSyncAt:
        typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
      lastCommit:
        typeof parsed.lastCommit === "string" ? parsed.lastCommit : null,
      lastCommitUrl:
        typeof parsed.lastCommitUrl === "string" ? parsed.lastCommitUrl : null,
    };
  } catch {
    return {
      version: 1,
      repoId: WORKBENCH_SHARED_REPO_ID,
      lastSyncAt: null,
      lastCommit: null,
      lastCommitUrl: null,
    };
  }
}

export async function writeWorkbenchSharedSyncMetadata(
  input: Omit<WorkbenchSharedSyncMetadata, "version" | "repoId">,
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchSharedSyncMetadata> {
  const metadata: WorkbenchSharedSyncMetadata = {
    version: 1,
    repoId: WORKBENCH_SHARED_REPO_ID,
    ...input,
  };
  const directory = sharedRoot(root);
  await fs.mkdir(directory, { recursive: true });
  const destination = metadataPath(root);
  const temporary = destination + "." + process.pid + ".tmp";
  try {
    await fs.writeFile(
      temporary,
      serializeWorkbenchSharedValue(metadata),
      "utf8",
    );
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return metadata;
}

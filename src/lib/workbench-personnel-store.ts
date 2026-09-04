import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkbenchPerson,
  WorkbenchPersonnelConfig,
  WorkbenchPersonnelOrganizationConfig,
  WorkbenchPersonnelScheduleAssignment,
  WorkbenchPersonnelSchedules,
} from "@/types/workbench-personnel.types";

const PERSONNEL_CONFIG_VERSION = 1;
const MAX_ORG_LENGTH = 128;
const MAX_PERSON_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_WORKSTATION_LENGTH = 64;

type WorkbenchPersonnelConfigFile = {
  version: number;
  organizations: Record<string, WorkbenchPersonnelOrganizationConfig>;
};

export class WorkbenchPersonnelStoreError extends Error {
  readonly code = "PERSONNEL_CONFIG_NOT_WRITABLE";
}

export const WORKBENCH_PERSONNEL_CONFIG_PATH = path.join(
  process.cwd(),
  "src",
  "config",
  "workbench-personnel-schedules.json",
);

function normalizeOrg(value: string): string {
  const org = value.trim();
  if (!org) throw new Error("A non-empty organization is required.");
  if (org.length > MAX_ORG_LENGTH) throw new Error("Organization is too long.");
  return org;
}

function assertPlainObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function normalizedRequiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}

export function isWorkbenchPersonnelDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.toISOString().slice(0, 10) === value;
}

function normalizeEmail(value: unknown, displayName: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new Error(`Email for ${displayName} must be a string.`);
  }
  const email = value.trim();
  if (!email) return "";
  if (
    email.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new Error(`Email for ${displayName} is invalid.`);
  }
  return email;
}

function normalizePeople(input: unknown): WorkbenchPerson[] {
  if (!Array.isArray(input))
    throw new Error("Personnel people must be an array.");
  const ids = new Set<string>();
  const names = new Set<string>();
  return input.map((value, index) => {
    assertPlainObject(value, `Person ${index + 1} must be an object.`);
    const id = normalizedRequiredString(
      value.id,
      `Person ${index + 1} ID`,
      MAX_PERSON_ID_LENGTH,
    );
    const displayName = normalizedRequiredString(
      value.displayName,
      `Person ${index + 1} display name`,
      MAX_DISPLAY_NAME_LENGTH,
    );
    if (ids.has(id)) throw new Error(`Duplicate personnel ID: ${id}.`);
    if (names.has(displayName)) {
      throw new Error(`Duplicate personnel display name: ${displayName}.`);
    }
    ids.add(id);
    names.add(displayName);
    return { id, displayName, email: normalizeEmail(value.email, displayName) };
  });
}

function normalizeAssignment(
  value: unknown,
  day: string,
  index: number,
  personIds: ReadonlySet<string>,
): WorkbenchPersonnelScheduleAssignment {
  assertPlainObject(
    value,
    `Schedule ${day} assignment ${index + 1} must be an object.`,
  );
  const workstation = normalizedRequiredString(
    value.workstation,
    `Schedule ${day} workstation`,
    MAX_WORKSTATION_LENGTH,
  );
  if (!Array.isArray(value.members) || value.members.length === 0) {
    throw new Error(
      `Schedule ${day} workstation ${workstation} needs at least one person.`,
    );
  }
  const memberIds = new Set<string>();
  const members = value.members.map((member, memberIndex) => {
    assertPlainObject(
      member,
      `Schedule ${day} workstation ${workstation} member ${memberIndex + 1} must be an object.`,
    );
    const personId = normalizedRequiredString(
      member.personId,
      `Schedule ${day} person ID`,
      MAX_PERSON_ID_LENGTH,
    );
    if (!personIds.has(personId)) {
      throw new Error(
        `Schedule ${day} references unknown personnel ID: ${personId}.`,
      );
    }
    if (memberIds.has(personId)) {
      throw new Error(
        `Schedule ${day} workstation ${workstation} contains duplicate personnel ID: ${personId}.`,
      );
    }
    if (
      typeof member.creditFactor !== "number" ||
      !Number.isFinite(member.creditFactor) ||
      member.creditFactor <= 0
    ) {
      throw new Error(
        `Schedule ${day} workstation ${workstation} creditFactor must be a positive number.`,
      );
    }
    memberIds.add(personId);
    return { personId, creditFactor: member.creditFactor };
  });
  const collectorCount =
    value.collectorCount === undefined ? members.length : value.collectorCount;
  if (
    typeof collectorCount !== "number" ||
    !Number.isInteger(collectorCount) ||
    collectorCount <= 0
  ) {
    throw new Error(
      `Schedule ${day} workstation ${workstation} collectorCount must be a positive integer.`,
    );
  }
  if (collectorCount < members.length) {
    throw new Error(
      `Schedule ${day} workstation ${workstation} collectorCount cannot be less than the mapped personnel count.`,
    );
  }
  return { workstation, collectorCount, members };
}

function normalizeSchedules(
  input: unknown,
  people: readonly WorkbenchPerson[],
): WorkbenchPersonnelSchedules {
  assertPlainObject(input, "Personnel mapping must be an object.");
  const output: WorkbenchPersonnelSchedules = {};
  const personIds = new Set(people.map((person) => person.id));
  for (const [day, rawAssignments] of Object.entries(input).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (!isWorkbenchPersonnelDay(day)) {
      throw new Error(`Invalid personnel mapping date: ${day}.`);
    }
    if (!Array.isArray(rawAssignments)) {
      throw new Error(`Personnel mapping ${day} must be an array.`);
    }
    const workstations = new Set<string>();
    output[day] = rawAssignments.map((assignment, index) => {
      const normalized = normalizeAssignment(assignment, day, index, personIds);
      if (workstations.has(normalized.workstation)) {
        throw new Error(
          `Schedule ${day} contains duplicate workstation: ${normalized.workstation}.`,
        );
      }
      workstations.add(normalized.workstation);
      return normalized;
    });
  }
  return output;
}

export function validateWorkbenchPersonnelOrganizationConfig(
  input: unknown,
  updatedAt: string | null = null,
): WorkbenchPersonnelOrganizationConfig {
  assertPlainObject(input, "Personnel configuration must be an object.");
  const people = normalizePeople(input.people);
  return {
    people,
    schedules: normalizeSchedules(input.schedules, people),
    updatedAt:
      typeof input.updatedAt === "string" && input.updatedAt.trim()
        ? input.updatedAt
        : updatedAt,
  };
}

function validateConfigFile(input: unknown): WorkbenchPersonnelConfigFile {
  assertPlainObject(input, "Personnel configuration file must be an object.");
  if (input.version !== PERSONNEL_CONFIG_VERSION) {
    throw new Error(
      `Unsupported personnel configuration version: ${String(input.version)}.`,
    );
  }
  assertPlainObject(
    input.organizations,
    "Personnel configuration organizations must be an object.",
  );
  const organizations: Record<string, WorkbenchPersonnelOrganizationConfig> =
    {};
  for (const [rawOrg, rawConfig] of Object.entries(input.organizations)) {
    const org = normalizeOrg(rawOrg);
    organizations[org] =
      validateWorkbenchPersonnelOrganizationConfig(rawConfig);
  }
  return { version: PERSONNEL_CONFIG_VERSION, organizations };
}

async function readConfigFile(
  filePath: string,
): Promise<WorkbenchPersonnelConfigFile> {
  try {
    return validateConfigFile(
      JSON.parse(await fs.readFile(filePath, "utf8")) as unknown,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { version: PERSONNEL_CONFIG_VERSION, organizations: {} };
    }
    throw error;
  }
}

export async function readWorkbenchPersonnelConfig(
  org: string,
  filePath = WORKBENCH_PERSONNEL_CONFIG_PATH,
): Promise<WorkbenchPersonnelConfig> {
  const normalizedOrg = normalizeOrg(org);
  const file = await readConfigFile(filePath);
  const config = file.organizations[normalizedOrg] ?? {
    people: [],
    schedules: {},
    updatedAt: null,
  };
  return {
    org: normalizedOrg,
    people: config.people,
    schedules: config.schedules,
    updatedAt: config.updatedAt,
  };
}

function writableStoreError(error: unknown, filePath: string): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new WorkbenchPersonnelStoreError(
      "Personnel configuration is not writable at " +
        filePath +
        ". Check repository permissions.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function writeWorkbenchPersonnelConfig(
  org: string,
  input: unknown,
  filePath = WORKBENCH_PERSONNEL_CONFIG_PATH,
): Promise<WorkbenchPersonnelConfig> {
  const normalizedOrg = normalizeOrg(org);
  const updatedAt = new Date().toISOString();
  const normalized = validateWorkbenchPersonnelOrganizationConfig(
    input,
    updatedAt,
  );
  const file = await readConfigFile(filePath);
  file.organizations[normalizedOrg] = { ...normalized, updatedAt };

  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } catch (error: unknown) {
    throw writableStoreError(error, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }

  return { org: normalizedOrg, ...file.organizations[normalizedOrg] };
}

import type { WorkbenchPersonnelConfig } from "@/types/workbench-personnel.types";
import {
  WORKBENCH_CONFIGURATION_VERSION,
  WORKBENCH_DEVICE_TYPES,
  WORKBENCH_PERSON_ROLES,
  type WorkbenchConfigurationDiagnostic,
  type WorkbenchConfigurationV2,
  type WorkbenchDeviceSource,
  type WorkbenchDeviceType,
  type WorkbenchDeviceTypeDescriptor,
  type WorkbenchEffectiveStaffingV2,
  type WorkbenchObservedDevice,
  type WorkbenchPersonRole,
  type WorkbenchStaffingRecordV2,
} from "@/types/workbench-configuration.types";

export const WORKBENCH_DEVICE_TYPE_DESCRIPTORS: WorkbenchDeviceTypeDescriptor[] =
  [
    {
      type: "umi_gripper",
      source: "robot_id",
      label: "UMI gripper",
      suggestedPrefixes: ["bi_taccap_"],
    },
    {
      type: "pico_umi_gripper",
      source: "robot_id",
      label: "PICO UMI gripper",
      suggestedPrefixes: ["xtac_umi_g1_"],
    },
    {
      type: "collector_backpack",
      source: "collector_sn",
      label: "Collector backpack",
      suggestedPrefixes: ["TCGU"],
    },
  ];

type DatasetDeviceEvidence = {
  robotId?: string | null;
  collectorSerialNumber?: string | null;
  leftGripperSn?: string | null;
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isWorkbenchConfigurationDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.toISOString().slice(0, 10) === value;
}

export function workbenchDeviceSourceForType(
  type: WorkbenchDeviceType,
): WorkbenchDeviceSource {
  return type === "collector_backpack" ? "collector_sn" : "robot_id";
}

export function suggestWorkbenchDeviceType(
  identifier: string,
  source: WorkbenchDeviceSource,
): WorkbenchDeviceType {
  if (source === "collector_sn") return "collector_backpack";
  if (identifier.startsWith("xtac_umi_g1_")) return "pico_umi_gripper";
  return "umi_gripper";
}

export const WORKBENCH_STATIC_ROLE_EFFECTIVE_DATE = "1970-01-01";
export const WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE = "1970-01-01";

export function nextWorkbenchPersonId(
  people: readonly Pick<WorkbenchConfigurationV2["people"][number], "id">[],
): string {
  const used = new Set(people.map((person) => person.id));
  let next = people.reduce((maximum, person) => {
    const match = /^person-(\d+)$/u.exec(person.id);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  let candidate: string;
  do candidate = `person-${++next}`;
  while (used.has(candidate));
  return candidate;
}

function startsWithAsciiAlphaNumeric(value: string): boolean {
  return /^[A-Za-z0-9]/u.test(value.trim());
}

/** Natural ordering with ASCII station/person labels before local text. */
export function compareWorkbenchLabels(left: string, right: string): number {
  const leftValue = left.trim();
  const rightValue = right.trim();
  const asciiOrder =
    Number(startsWithAsciiAlphaNumeric(leftValue)) -
    Number(startsWithAsciiAlphaNumeric(rightValue));
  if (asciiOrder !== 0) return -asciiOrder;
  return (
    leftValue.localeCompare(rightValue, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || leftValue.localeCompare(rightValue)
  );
}

export function sortWorkbenchWorkstations(
  workstations: readonly WorkbenchConfigurationV2["workstations"][number][],
): WorkbenchConfigurationV2["workstations"] {
  return [...workstations].sort(
    (left, right) =>
      Number(right.enabled !== false) - Number(left.enabled !== false) ||
      compareWorkbenchLabels(left.name, right.name) ||
      compareWorkbenchLabels(left.id, right.id),
  );
}

export function sortWorkbenchPeople(
  people: readonly WorkbenchConfigurationV2["people"][number][],
): WorkbenchConfigurationV2["people"] {
  return [...people].sort(
    (left, right) =>
      Number(right.enabled !== false) - Number(left.enabled !== false) ||
      compareWorkbenchLabels(left.id, right.id),
  );
}

export function sortWorkbenchDevices(
  devices: readonly WorkbenchConfigurationV2["devices"][number][],
): WorkbenchConfigurationV2["devices"] {
  return [...devices].sort(
    (left, right) =>
      Number(right.enabled !== false) - Number(left.enabled !== false) ||
      compareWorkbenchLabels(left.identifier, right.identifier) ||
      compareWorkbenchLabels(left.id, right.id),
  );
}

/**
 * Staffing choices are collectors only. A disabled collector remains visible
 * when already assigned so an existing schedule can be reviewed safely.
 */
export function workbenchCollectorOptions(
  people: readonly WorkbenchConfigurationV2["people"][number][],
  selectedPersonIds: readonly string[] = [],
): WorkbenchConfigurationV2["people"] {
  const selected = new Set(selectedPersonIds);
  return sortWorkbenchPeople(
    people.filter(
      (person) =>
        resolveWorkbenchPersonRole(person) === "data_collector" &&
        (person.enabled !== false || selected.has(person.id)),
    ),
  );
}

function workstationIsReferenced(
  config: WorkbenchConfigurationV2,
  workstationId: string,
): boolean {
  return (
    config.devices.some((device) => device.workstationId === workstationId) ||
    config.devices.some((device) =>
      (device.assignmentHistory ?? []).some(
        (record) => record.workstationId === workstationId,
      ),
    ) ||
    config.legacyDeviceAliases.some(
      (alias) => alias.workstationId === workstationId,
    ) ||
    config.legacyDeviceAliases.some((alias) =>
      (alias.assignmentHistory ?? []).some(
        (record) => record.workstationId === workstationId,
      ),
    ) ||
    config.staffingHistory.some(
      (record) => record.workstationId === workstationId,
    )
  );
}

export function pruneWorkbenchWorkstations(
  config: WorkbenchConfigurationV2,
): void {
  config.workstations = config.workstations.filter((workstation) =>
    workstationIsReferenced(config, workstation.id),
  );
}

function setWorkbenchDeviceAssignment(
  device: WorkbenchConfigurationV2["devices"][number],
  workstationId: string | null,
  effectiveDate: string,
): void {
  const day = isWorkbenchConfigurationDay(effectiveDate)
    ? effectiveDate
    : WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE;
  device.assignmentHistory = (device.assignmentHistory ?? []).filter(
    (record) => record.effectiveDate !== day,
  );
  device.assignmentHistory.push({ effectiveDate: day, workstationId });
  device.assignmentHistory.sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate),
  );
}

function ensureWorkbenchDeviceAssignmentHistory(
  device: WorkbenchConfigurationV2["devices"][number],
): void {
  if ((device.assignmentHistory ?? []).length > 0 || !device.workstationId) {
    device.assignmentHistory ??= [];
    return;
  }
  device.assignmentHistory = [
    {
      effectiveDate: WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
      workstationId: device.workstationId,
    },
  ];
}

export function setWorkbenchDeviceWorkstation(
  config: WorkbenchConfigurationV2,
  deviceId: string,
  rawName: string,
  effectiveDate = WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
): void {
  const device = config.devices.find((entry) => entry.id === deviceId);
  if (!device) return;
  ensureWorkbenchDeviceAssignmentHistory(device);
  const name = cleanString(rawName);
  if (!name) {
    device.workstationId = null;
    setWorkbenchDeviceAssignment(device, null, effectiveDate);
    pruneWorkbenchWorkstations(config);
    return;
  }
  let workstation = config.workstations.find((entry) => entry.name === name);
  if (!workstation) {
    const usedIds = new Set(config.workstations.map((entry) => entry.id));
    let id = name;
    let suffix = 2;
    while (usedIds.has(id)) id = `${name}-${suffix++}`;
    workstation = { id, name, enabled: true };
    config.workstations.push(workstation);
  }
  device.workstationId = workstation.id;
  setWorkbenchDeviceAssignment(device, workstation.id, effectiveDate);
  pruneWorkbenchWorkstations(config);
}

export function removeWorkbenchDevice(
  config: WorkbenchConfigurationV2,
  deviceId: string,
): void {
  config.devices = config.devices.filter((device) => device.id !== deviceId);
  for (const alias of config.legacyDeviceAliases) {
    if (alias.deviceId === deviceId) alias.deviceId = null;
  }
  pruneWorkbenchWorkstations(config);
}

export function setWorkbenchPersonRole(
  config: WorkbenchConfigurationV2,
  personId: string,
  role: WorkbenchPersonRole,
): void {
  const person = config.people.find((entry) => entry.id === personId);
  if (!person) return;
  person.roleHistory = [
    { effectiveDate: WORKBENCH_STATIC_ROLE_EFFECTIVE_DATE, role },
  ];
  if (role !== "data_collector") {
    for (const record of config.staffingHistory) {
      record.members = record.members.filter(
        (member) => member.personId !== personId,
      );
    }
  }
}

export function removeWorkbenchPerson(
  config: WorkbenchConfigurationV2,
  personId: string,
): void {
  config.people = config.people.filter((person) => person.id !== personId);
  for (const record of config.staffingHistory) {
    record.members = record.members.filter(
      (member) => member.personId !== personId,
    );
  }
}

export function workbenchStaffingWorkstations(
  config: WorkbenchConfigurationV2,
): WorkbenchConfigurationV2["workstations"] {
  const visibleIds = new Set([
    ...config.devices.flatMap((device) =>
      device.workstationId ? [device.workstationId] : [],
    ),
    ...config.devices.flatMap((device) =>
      (device.assignmentHistory ?? []).flatMap((record) =>
        record.workstationId ? [record.workstationId] : [],
      ),
    ),
    ...config.staffingHistory.map((record) => record.workstationId),
  ]);
  return config.workstations.filter((workstation) =>
    visibleIds.has(workstation.id),
  );
}

export function resolveWorkbenchPersonRole(
  person: Pick<WorkbenchConfigurationV2["people"][number], "roleHistory">,
  day?: string,
): WorkbenchPersonRole | null {
  void day;
  return (
    [...person.roleHistory]
      .sort((left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate),
      )
      .at(-1)?.role ?? null
  );
}

export function resolveWorkbenchStaffing(
  config: Pick<WorkbenchConfigurationV2, "staffingHistory">,
  workstationId: string,
  day: string,
): WorkbenchEffectiveStaffingV2 {
  const record = config.staffingHistory
    .filter(
      (entry) =>
        entry.workstationId === workstationId && entry.effectiveDate <= day,
    )
    .sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate),
    )
    .at(-1);
  if (!record) {
    return {
      workstationId,
      day,
      sourceDate: null,
      isExplicit: false,
      status: "unconfigured",
      originalCollectors: null,
      members: [],
    };
  }
  return {
    workstationId,
    day,
    sourceDate: record.effectiveDate,
    isExplicit: record.effectiveDate === day,
    status: record.status,
    originalCollectors: record.originalCollectors,
    members: record.members.map((member) => ({ ...member })),
  };
}

export function workbenchPersonnelEmailGroups(
  config: Pick<WorkbenchConfigurationV2, "people">,
  day?: string,
): Record<WorkbenchPersonRole | "all_personnel", string[]> {
  void day;
  type Group = WorkbenchPersonRole | "all_personnel";
  const keys: readonly Group[] = [...WORKBENCH_PERSON_ROLES, "all_personnel"];
  const groups: Record<Group, string[]> = {
    data_collector: [],
    data_quality_inspector: [],
    manager: [],
    developer: [],
    all_personnel: [],
  };
  const seen = new Map<Group, Set<string>>(
    keys.map((role) => [role, new Set<string>()]),
  );
  const add = (
    role: WorkbenchPersonRole | "all_personnel",
    rawEmail: string,
  ) => {
    const email = rawEmail.trim();
    const key = email.toLocaleLowerCase();
    if (!email || seen.get(role)?.has(key)) return;
    seen.get(role)?.add(key);
    groups[role].push(email);
  };
  for (const person of config.people) {
    const role = resolveWorkbenchPersonRole(person);
    if (role) add(role, person.email);
    add("all_personnel", person.email);
  }
  return groups;
}

export type WorkbenchDatasetDeviceResolution = {
  workstationId: string | null;
  workstation: string | null;
  source: WorkbenchDeviceSource | "left_gripper_sn" | null;
  identifier: string | null;
  deviceId: string | null;
  conflict: boolean;
  candidates: Array<{
    source: WorkbenchDeviceSource | "left_gripper_sn";
    identifier: string;
    workstationId: string;
  }>;
};

function latestDeviceAssignment(
  assignments: readonly {
    effectiveDate: string;
    workstationId: string | null;
  }[],
  day?: string,
): string | null | undefined {
  const selected = assignments
    .filter((entry) => !day || entry.effectiveDate <= day)
    .sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate),
    )
    .at(-1);
  return selected ? selected.workstationId : undefined;
}

export function resolveWorkbenchDeviceWorkstationId(
  device: Pick<
    WorkbenchConfigurationV2["devices"][number],
    "workstationId" | "assignmentHistory"
  >,
  day?: string,
): string | null {
  const assignments = device.assignmentHistory ?? [];
  if (assignments.length === 0) return device.workstationId ?? null;
  // `workstationId` is the latest legacy snapshot. It must not leak into
  // dates before the first historical assignment.
  return latestDeviceAssignment(assignments, day) ?? null;
}

export function resolveWorkbenchAliasWorkstationId(
  alias: Pick<
    WorkbenchConfigurationV2["legacyDeviceAliases"][number],
    "workstationId" | "assignmentHistory"
  >,
  linkedDevice?: Pick<
    WorkbenchConfigurationV2["devices"][number],
    "workstationId" | "assignmentHistory"
  > | null,
  day?: string,
): string | null {
  const assignments = alias.assignmentHistory ?? [];
  const assigned = latestDeviceAssignment(assignments, day);
  if (assigned !== undefined) return assigned;
  const linked = linkedDevice
    ? resolveWorkbenchDeviceWorkstationId(linkedDevice, day)
    : null;
  return assignments.length === 0 ? (alias.workstationId ?? linked) : linked;
}

export function resolveWorkbenchDatasetDevice(
  dataset: DatasetDeviceEvidence,
  config: WorkbenchConfigurationV2,
  day?: string,
): WorkbenchDatasetDeviceResolution {
  const workstationNames = new Map(
    config.workstations.map((workstation) => [
      workstation.id,
      workstation.name,
    ]),
  );
  const devices = new Map(
    config.devices.map((device) => [
      [device.source, device.identifier].join("\u0000"),
      device,
    ]),
  );
  const aliases = new Map(
    config.legacyDeviceAliases.map((alias) => [alias.identifier, alias]),
  );
  const candidates: WorkbenchDatasetDeviceResolution["candidates"] = [];

  const deviceCandidates: Array<{
    source: WorkbenchDeviceSource;
    identifier: string | null | undefined;
  }> = [
    { source: "robot_id", identifier: dataset.robotId },
    { source: "collector_sn", identifier: dataset.collectorSerialNumber },
  ];
  let selected:
    | {
        source: WorkbenchDeviceSource | "left_gripper_sn";
        identifier: string;
        workstationId: string;
        deviceId: string | null;
      }
    | undefined;
  for (const candidate of deviceCandidates) {
    const identifier = cleanString(candidate.identifier);
    if (!identifier) continue;
    const device = devices.get([candidate.source, identifier].join("\u0000"));
    if (!device) continue;
    const workstationId = resolveWorkbenchDeviceWorkstationId(device, day);
    if (!workstationId) continue;
    const value = {
      source: candidate.source,
      identifier,
      workstationId,
      deviceId: device.id,
    };
    candidates.push(value);
    selected ??= value;
  }

  const leftIdentifier = cleanString(dataset.leftGripperSn);
  if (leftIdentifier) {
    const alias = aliases.get(leftIdentifier);
    const linked = alias?.deviceId
      ? config.devices.find((device) => device.id === alias.deviceId)
      : null;
    const workstationId = alias
      ? resolveWorkbenchAliasWorkstationId(alias, linked, day)
      : linked
        ? resolveWorkbenchDeviceWorkstationId(linked, day)
        : null;
    if (workstationId) {
      const value = {
        source: "left_gripper_sn" as const,
        identifier: leftIdentifier,
        workstationId,
        deviceId: linked?.id ?? null,
      };
      candidates.push(value);
      selected ??= value;
    }
  }

  const distinct = new Set(candidates.map((entry) => entry.workstationId));
  return {
    workstationId: selected?.workstationId ?? null,
    workstation: selected
      ? (workstationNames.get(selected.workstationId) ?? null)
      : null,
    source: selected?.source ?? null,
    identifier: selected?.identifier ?? null,
    deviceId: selected?.deviceId ?? null,
    conflict: distinct.size > 1,
    candidates,
  };
}

export function workbenchMappingsFromConfiguration(
  config: WorkbenchConfigurationV2,
  day?: string,
): {
  mappings: Record<string, string>;
  legacyMappings: Record<string, string>;
} {
  const names = new Map(
    config.workstations.map((workstation) => [
      workstation.id,
      workstation.name,
    ]),
  );
  const devices = new Map(config.devices.map((device) => [device.id, device]));
  const mappings: Record<string, string> = {};
  const legacyMappings: Record<string, string> = {};
  for (const device of config.devices) {
    const workstationId = resolveWorkbenchDeviceWorkstationId(device, day);
    const name = workstationId ? names.get(workstationId) : undefined;
    if (name) mappings[device.identifier] = name;
  }
  for (const alias of config.legacyDeviceAliases) {
    const linked = alias.deviceId ? devices.get(alias.deviceId) : undefined;
    const workstationId = resolveWorkbenchAliasWorkstationId(
      alias,
      linked,
      day,
    );
    const name = workstationId ? names.get(workstationId) : undefined;
    if (name) legacyMappings[alias.identifier] = name;
  }
  return { mappings, legacyMappings };
}

export function legacyPersonnelConfigFromConfiguration(
  org: string,
  config: WorkbenchConfigurationV2,
  updatedAt: string | null,
): WorkbenchPersonnelConfig {
  const names = new Map(
    config.workstations.map((workstation) => [
      workstation.id,
      workstation.name,
    ]),
  );
  const dates = Array.from(
    new Set([
      ...config.staffingHistory.map((record) => record.effectiveDate),
      ...config.people.flatMap((person) =>
        person.roleHistory.map((entry) => entry.effectiveDate),
      ),
    ]),
  ).sort();
  return {
    org,
    updatedAt,
    people: config.people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      email: person.email,
    })),
    schedules: Object.fromEntries(
      dates.map((day) => [
        day,
        config.workstations.flatMap((workstation) => {
          const effective = resolveWorkbenchStaffing(
            config,
            workstation.id,
            day,
          );
          if (effective.status !== "active") return [];
          return [
            {
              workstation: names.get(workstation.id) ?? workstation.id,
              collectorCount: effective.originalCollectors ?? undefined,
              members: effective.members.map((member) => ({
                personId: member.personId,
                creditFactor: member.qualityWeight,
              })),
            },
          ];
        }),
      ]),
    ),
  };
}

export function observeWorkbenchDevices(
  datasets: readonly DatasetDeviceEvidence[],
  config?: WorkbenchConfigurationV2,
): WorkbenchObservedDevice[] {
  const counts = new Map<
    string,
    {
      identifier: string;
      source: WorkbenchObservedDevice["source"];
      count: number;
    }
  >();
  for (const dataset of datasets) {
    const values: Array<{
      identifier: string | null | undefined;
      source: WorkbenchObservedDevice["source"];
    }> = [
      { identifier: dataset.robotId, source: "robot_id" },
      { identifier: dataset.collectorSerialNumber, source: "collector_sn" },
      { identifier: dataset.leftGripperSn, source: "left_gripper_sn" },
    ];
    for (const value of values) {
      const identifier = cleanString(value.identifier);
      if (!identifier) continue;
      const key = [value.source, identifier].join("\u0000");
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { identifier, source: value.source, count: 1 });
    }
  }
  return Array.from(counts.values())
    .map((entry) => {
      const configuredDevice =
        entry.source === "left_gripper_sn"
          ? null
          : (config?.devices.find(
              (device) =>
                device.source === entry.source &&
                device.identifier === entry.identifier,
            ) ?? null);
      const configuredAlias =
        entry.source === "left_gripper_sn"
          ? (config?.legacyDeviceAliases.find(
              (alias) => alias.identifier === entry.identifier,
            ) ?? null)
          : null;
      return {
        identifier: entry.identifier,
        source: entry.source,
        suggestedType:
          entry.source === "left_gripper_sn"
            ? null
            : suggestWorkbenchDeviceType(entry.identifier, entry.source),
        datasetCount: entry.count,
        configuredDeviceId:
          configuredDevice?.id ?? configuredAlias?.deviceId ?? null,
      };
    })
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.identifier.localeCompare(right.identifier),
    );
}

function nextStableId(
  prefix: string,
  value: string,
  used: Set<string>,
): string {
  const base =
    prefix +
    "-" +
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80);
  let candidate = base === prefix + "-" ? prefix : base;
  let suffix = 2;
  while (used.has(candidate)) candidate = base + "-" + suffix++;
  used.add(candidate);
  return candidate;
}

function looksLikeCollector(identifier: string): boolean {
  return /^TCGU.*(?:B|backpack)$/iu.test(identifier);
}

function looksLikeRobot(identifier: string): boolean {
  return /^(?:bi_taccap_|xtac_umi_g1_)/u.test(identifier);
}

export function migrateLegacyWorkbenchConfiguration(
  mappings: Readonly<Record<string, string>>,
  personnel: Pick<WorkbenchPersonnelConfig, "people" | "schedules">,
  datasets: readonly DatasetDeviceEvidence[] = [],
  organization?: string,
): WorkbenchConfigurationV2 {
  const workstationNames = new Set<string>();
  for (const name of Object.values(mappings)) {
    const normalized = cleanString(name);
    if (normalized && normalized.toLocaleUpperCase() !== "ERROR") {
      workstationNames.add(normalized);
    }
  }
  for (const assignments of Object.values(personnel.schedules)) {
    for (const assignment of assignments) {
      const name = cleanString(assignment.workstation);
      if (name && name.toLocaleUpperCase() !== "ERROR")
        workstationNames.add(name);
    }
  }
  const workstations = Array.from(workstationNames)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ id: name, name, enabled: true }));
  const workstationIds = new Set(workstations.map((entry) => entry.id));

  const robotIds = new Set<string>();
  if (organization === "TacVerse") {
    robotIds.add("bi_taccap_8");
    robotIds.add("xtac_umi_g1_3");
  }
  const collectorIds = new Set<string>();
  const aliasToRobots = new Map<string, Set<string>>();
  for (const dataset of datasets) {
    const robotId = cleanString(dataset.robotId);
    const collector = cleanString(dataset.collectorSerialNumber);
    const alias = cleanString(dataset.leftGripperSn);
    if (robotId && robotId !== "bi_taccap_0") robotIds.add(robotId);
    if (collector) collectorIds.add(collector);
    if (alias && robotId && robotId !== "bi_taccap_0") {
      const linked = aliasToRobots.get(alias) ?? new Set<string>();
      linked.add(robotId);
      aliasToRobots.set(alias, linked);
    }
  }
  for (const identifier of Object.keys(mappings)) {
    if (looksLikeCollector(identifier)) collectorIds.add(identifier);
    else if (looksLikeRobot(identifier) && identifier !== "bi_taccap_0") {
      robotIds.add(identifier);
    }
  }

  const usedDeviceIds = new Set<string>();
  const devices: WorkbenchConfigurationV2["devices"] = [];
  for (const identifier of [...robotIds].sort()) {
    const type = suggestWorkbenchDeviceType(identifier, "robot_id");
    const workstation = cleanString(mappings[identifier]);
    devices.push({
      id: nextStableId("device", identifier, usedDeviceIds),
      type,
      source: "robot_id",
      identifier,
      workstationId: workstationIds.has(workstation) ? workstation : null,
      assignmentHistory: workstationIds.has(workstation)
        ? [
            {
              effectiveDate: WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
              workstationId: workstation,
            },
          ]
        : [],
    });
  }
  for (const identifier of [...collectorIds].sort()) {
    const workstation = cleanString(mappings[identifier]);
    devices.push({
      id: nextStableId("device", identifier, usedDeviceIds),
      type: "collector_backpack",
      source: "collector_sn",
      identifier,
      workstationId: workstationIds.has(workstation) ? workstation : null,
      assignmentHistory: workstationIds.has(workstation)
        ? [
            {
              effectiveDate: WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
              workstationId: workstation,
            },
          ]
        : [],
    });
  }

  const usedAliasIds = new Set<string>();
  const legacyDeviceAliases: WorkbenchConfigurationV2["legacyDeviceAliases"] =
    [];
  for (const [identifier, mappedName] of Object.entries(mappings)) {
    if (
      devices.some((device) => device.identifier === identifier) ||
      identifier === "bi_taccap_0"
    ) {
      continue;
    }
    const possibleRobots = aliasToRobots.get(identifier);
    const linkedRobot =
      possibleRobots?.size === 1 ? possibleRobots.values().next().value : null;
    const linkedDevice = linkedRobot
      ? devices.find(
          (device) =>
            device.source === "robot_id" && device.identifier === linkedRobot,
        )
      : null;
    const workstation = cleanString(mappedName);
    legacyDeviceAliases.push({
      id: nextStableId("alias", identifier, usedAliasIds),
      identifier,
      deviceId: linkedDevice?.id ?? null,
      workstationId: workstationIds.has(workstation) ? workstation : null,
      assignmentHistory: workstationIds.has(workstation)
        ? [
            {
              effectiveDate: WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
              workstationId: workstation,
            },
          ]
        : [],
    });
  }

  for (const device of devices) {
    if (device.workstationId) continue;
    const aliasWorkstations = new Set(
      legacyDeviceAliases
        .filter((alias) => alias.deviceId === device.id && alias.workstationId)
        .map((alias) => alias.workstationId as string),
    );
    if (aliasWorkstations.size === 1) {
      device.workstationId = aliasWorkstations.values().next().value ?? null;
      device.assignmentHistory = device.workstationId
        ? [
            {
              effectiveDate: WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
              workstationId: device.workstationId,
            },
          ]
        : [];
    }
  }

  const emailCounts = new Map<string, number>();
  for (const person of personnel.people) {
    const email = cleanString(person.email).toLocaleLowerCase();
    if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
  }
  const people = personnel.people.map((person) => {
    const email = cleanString(person.email);
    return {
      id: person.id,
      displayName: person.displayName,
      email:
        email && (emailCounts.get(email.toLocaleLowerCase()) ?? 0) === 1
          ? email
          : "",
      enabled: true,
      roleHistory: [
        { effectiveDate: "1970-01-01", role: "data_collector" as const },
      ],
    };
  });

  const staffingHistory: WorkbenchStaffingRecordV2[] = [];
  let previouslyActive = new Set<string>();
  for (const effectiveDate of Object.keys(personnel.schedules).sort()) {
    const current = new Set<string>();
    for (const assignment of personnel.schedules[effectiveDate] ?? []) {
      const workstationId = cleanString(assignment.workstation);
      if (!workstationIds.has(workstationId)) continue;
      current.add(workstationId);
      staffingHistory.push({
        workstationId,
        effectiveDate,
        status: "active",
        originalCollectors:
          typeof assignment.collectorCount === "number"
            ? assignment.collectorCount
            : assignment.members.length,
        members: assignment.members.map((member) => ({
          personId: member.personId,
          qualityWeight: 1,
        })),
      });
    }
    for (const workstationId of previouslyActive) {
      if (current.has(workstationId)) continue;
      staffingHistory.push({
        workstationId,
        effectiveDate,
        status: "inactive",
        originalCollectors: null,
        members: [],
      });
    }
    previouslyActive = current;
  }

  return {
    version: WORKBENCH_CONFIGURATION_VERSION,
    workstations,
    devices,
    legacyDeviceAliases,
    people,
    staffingHistory,
  };
}

export class WorkbenchConfigurationValidationError extends Error {
  readonly code = "WORKBENCH_CONFIGURATION_INVALID";

  constructor(
    readonly diagnostics: WorkbenchConfigurationDiagnostic[],
    message = diagnostics.find((entry) => entry.severity === "error")
      ?.message ?? "Workbench configuration is invalid.",
  ) {
    super(message);
  }
}

function requiredArray(
  record: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new WorkbenchConfigurationValidationError([
      {
        severity: "error",
        code: "INVALID_STRUCTURE",
        message: `${key} must be an array.`,
        path: key,
      },
    ]);
  }
  return value;
}

function invalidStructure(message: string, path?: string): never {
  throw new WorkbenchConfigurationValidationError([
    { severity: "error", code: "INVALID_STRUCTURE", message, path },
  ]);
}

function normalizedRequired(value: unknown, label: string): string {
  const normalized = cleanString(value);
  if (!normalized || normalized.length > 128) {
    throw new WorkbenchConfigurationValidationError([
      {
        severity: "error",
        code: "INVALID_IDENTIFIER",
        message: `${label} must be a non-empty string of at most 128 characters.`,
      },
    ]);
  }
  return normalized;
}

function normalizeDeviceAssignmentHistory(
  raw: Record<string, unknown>,
  fallbackWorkstationId: string | null,
  ownerLabel: string,
  path: string,
  workstationIds: ReadonlySet<string>,
  diagnostics: WorkbenchConfigurationDiagnostic[],
): WorkbenchConfigurationV2["devices"][number]["assignmentHistory"] {
  const rawHistory = Array.isArray(raw.assignmentHistory)
    ? raw.assignmentHistory
    : [];
  const source =
    rawHistory.length > 0
      ? rawHistory
      : fallbackWorkstationId
        ? [
            {
              effectiveDate: WORKBENCH_STATIC_DEVICE_EFFECTIVE_DATE,
              workstationId: fallbackWorkstationId,
            },
          ]
        : [];
  const dates = new Set<string>();
  return source
    .flatMap((entry, index) => {
      if (!isRecord(entry)) {
        invalidStructure(
          `${ownerLabel} assignment ${index + 1} must be an object.`,
          `${path}.assignmentHistory[${index}]`,
        );
      }
      const effectiveDate = cleanString(entry.effectiveDate);
      const workstationId = cleanString(entry.workstationId) || null;
      if (!isWorkbenchConfigurationDay(effectiveDate)) {
        diagnostics.push({
          severity: "error",
          code: "INVALID_DATE",
          message: `Invalid assignment effective date: ${effectiveDate}.`,
          path: `${path}.assignmentHistory[${index}].effectiveDate`,
        });
      }
      if (dates.has(effectiveDate)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_DEVICE_ASSIGNMENT_HISTORY",
          message: `Duplicate assignment date ${effectiveDate} for ${ownerLabel}.`,
          path: `${path}.assignmentHistory`,
        });
      }
      if (workstationId && !workstationIds.has(workstationId)) {
        diagnostics.push({
          severity: "error",
          code: "UNKNOWN_WORKSTATION",
          message: `${ownerLabel} references unknown workstation ${workstationId}.`,
          path: `${path}.assignmentHistory[${index}].workstationId`,
        });
      }
      dates.add(effectiveDate);
      return [{ effectiveDate, workstationId }];
    })
    .sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate),
    );
}

export function validateWorkbenchConfiguration(
  input: unknown,
  observedDevices: readonly WorkbenchObservedDevice[] = [],
): {
  config: WorkbenchConfigurationV2;
  diagnostics: WorkbenchConfigurationDiagnostic[];
} {
  if (!isRecord(input) || input.version !== WORKBENCH_CONFIGURATION_VERSION) {
    throw new WorkbenchConfigurationValidationError([
      {
        severity: "error",
        code: "UNSUPPORTED_VERSION",
        message: "Workbench configuration version must be 2.",
        path: "version",
      },
    ]);
  }
  const diagnostics: WorkbenchConfigurationDiagnostic[] = [];
  const errors = () =>
    diagnostics.filter((entry) => entry.severity === "error");
  const workstations = requiredArray(input, "workstations").map(
    (raw, index) => {
      if (!isRecord(raw)) {
        invalidStructure(
          `Workstation ${index + 1} must be an object.`,
          `workstations[${index}]`,
        );
      }
      const id = normalizedRequired(raw.id, `Workstation ${index + 1} ID`);
      const name = normalizedRequired(
        raw.name,
        `Workstation ${index + 1} name`,
      );
      if (
        id.toLocaleUpperCase() === "ERROR" ||
        name.toLocaleUpperCase() === "ERROR"
      ) {
        diagnostics.push({
          severity: "error",
          code: "RESERVED_WORKSTATION",
          message:
            "ERROR is reserved for unconfigured diagnostics and cannot be a workstation.",
          path: `workstations[${index}]`,
        });
      }
      return { id, name, enabled: raw.enabled !== false };
    },
  );
  const workstationIds = new Set<string>();
  const workstationNames = new Set<string>();
  workstations.forEach((entry, index) => {
    if (workstationIds.has(entry.id))
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_WORKSTATION_ID",
        message: `Duplicate workstation ID: ${entry.id}.`,
        path: `workstations[${index}].id`,
      });
    if (workstationNames.has(entry.name))
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_WORKSTATION_NAME",
        message: `Duplicate workstation name: ${entry.name}.`,
        path: `workstations[${index}].name`,
      });
    workstationIds.add(entry.id);
    workstationNames.add(entry.name);
  });

  const identifiers = new Set<string>();
  const deviceIds = new Set<string>();
  const devices = requiredArray(input, "devices").map((raw, index) => {
    if (!isRecord(raw)) {
      invalidStructure(
        `Device ${index + 1} must be an object.`,
        `devices[${index}]`,
      );
    }
    const id = normalizedRequired(raw.id, `Device ${index + 1} ID`);
    const identifier = normalizedRequired(
      raw.identifier,
      `Device ${index + 1} identifier`,
    );
    const type = raw.type as WorkbenchDeviceType;
    const source = raw.source as WorkbenchDeviceSource;
    const fallbackWorkstationId = cleanString(raw.workstationId) || null;
    const assignmentHistory = normalizeDeviceAssignmentHistory(
      raw,
      fallbackWorkstationId,
      `Device ${identifier}`,
      `devices[${index}]`,
      workstationIds,
      diagnostics,
    );
    const latestWorkstationId = latestDeviceAssignment(assignmentHistory ?? []);
    const workstationId =
      latestWorkstationId !== undefined
        ? latestWorkstationId
        : fallbackWorkstationId;
    if (!(WORKBENCH_DEVICE_TYPES as readonly unknown[]).includes(type))
      diagnostics.push({
        severity: "error",
        code: "INVALID_DEVICE_TYPE",
        message: `Invalid device type for ${identifier}.`,
        path: `devices[${index}].type`,
      });
    else if (source !== workbenchDeviceSourceForType(type))
      diagnostics.push({
        severity: "error",
        code: "DEVICE_SOURCE_MISMATCH",
        message: `Source ${String(source)} is invalid for device type ${type}.`,
        path: `devices[${index}].source`,
      });
    if (deviceIds.has(id))
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_DEVICE_ID",
        message: `Duplicate device ID: ${id}.`,
        path: `devices[${index}].id`,
      });
    if (identifiers.has(identifier))
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_DEVICE_IDENTIFIER",
        message: `Duplicate device identifier: ${identifier}.`,
        path: `devices[${index}].identifier`,
      });
    if (workstationId && !workstationIds.has(workstationId))
      diagnostics.push({
        severity: "error",
        code: "UNKNOWN_WORKSTATION",
        message: `Device ${identifier} references unknown workstation ${workstationId}.`,
        path: `devices[${index}].workstationId`,
      });
    if (!workstationId)
      diagnostics.push({
        severity: "warning",
        code: "DEVICE_WITHOUT_WORKSTATION",
        message: `Device ${identifier} has no workstation.`,
        path: `devices[${index}].workstationId`,
      });
    deviceIds.add(id);
    identifiers.add(identifier);
    return {
      id,
      type,
      source,
      identifier,
      enabled: raw.enabled !== false,
      workstationId,
      assignmentHistory,
    };
  });

  const aliasIds = new Set<string>();
  const legacyDeviceAliases = requiredArray(input, "legacyDeviceAliases").map(
    (raw, index) => {
      if (!isRecord(raw)) {
        invalidStructure(
          `Legacy alias ${index + 1} must be an object.`,
          `legacyDeviceAliases[${index}]`,
        );
      }
      const id = normalizedRequired(raw.id, `Legacy alias ${index + 1} ID`);
      const identifier = normalizedRequired(
        raw.identifier,
        `Legacy alias ${index + 1} identifier`,
      );
      const deviceId = cleanString(raw.deviceId) || null;
      const fallbackWorkstationId = cleanString(raw.workstationId) || null;
      const assignmentHistory = normalizeDeviceAssignmentHistory(
        raw,
        fallbackWorkstationId,
        `Alias ${identifier}`,
        `legacyDeviceAliases[${index}]`,
        workstationIds,
        diagnostics,
      );
      const latestWorkstationId = latestDeviceAssignment(
        assignmentHistory ?? [],
      );
      const workstationId =
        latestWorkstationId !== undefined
          ? latestWorkstationId
          : fallbackWorkstationId;
      if (aliasIds.has(id)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_ALIAS_ID",
          message: `Duplicate legacy alias ID: ${id}.`,
          path: `legacyDeviceAliases[${index}].id`,
        });
      }
      if (identifiers.has(identifier)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_DEVICE_IDENTIFIER",
          message: `Duplicate device identifier: ${identifier}.`,
          path: `legacyDeviceAliases[${index}].identifier`,
        });
      }
      if (deviceId && !deviceIds.has(deviceId)) {
        diagnostics.push({
          severity: "error",
          code: "UNKNOWN_DEVICE",
          message: `Alias ${identifier} references unknown device ${deviceId}.`,
          path: `legacyDeviceAliases[${index}].deviceId`,
        });
      }
      if (workstationId && !workstationIds.has(workstationId)) {
        diagnostics.push({
          severity: "error",
          code: "UNKNOWN_WORKSTATION",
          message: `Alias ${identifier} references unknown workstation ${workstationId}.`,
          path: `legacyDeviceAliases[${index}].workstationId`,
        });
      }
      aliasIds.add(id);
      identifiers.add(identifier);
      return { id, identifier, deviceId, workstationId, assignmentHistory };
    },
  );

  const personIds = new Set<string>();
  const emailIndexes = new Map<string, number[]>();
  const people = requiredArray(input, "people").map((raw, index) => {
    if (!isRecord(raw)) {
      invalidStructure(
        `Person ${index + 1} must be an object.`,
        `people[${index}]`,
      );
    }
    const id = normalizedRequired(raw.id, `Person ${index + 1} ID`);
    const displayName = normalizedRequired(
      raw.displayName,
      `Person ${index + 1} display name`,
    );
    const email = cleanString(raw.email);
    if (personIds.has(id)) {
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_PERSON_ID",
        message: `Duplicate personnel ID: ${id}.`,
        path: `people[${index}].id`,
      });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      diagnostics.push({
        severity: "error",
        code: "INVALID_EMAIL",
        message: `Email for ${displayName} is invalid.`,
        path: `people[${index}].email`,
      });
    }
    if (email) {
      const key = email.toLocaleLowerCase();
      emailIndexes.set(key, [...(emailIndexes.get(key) ?? []), index]);
    } else {
      diagnostics.push({
        severity: "warning",
        code: "MISSING_EMAIL",
        message: `${displayName} has no email address.`,
        path: `people[${index}].email`,
      });
    }
    const roleDates = new Set<string>();
    const parsedRoleHistory = (
      Array.isArray(raw.roleHistory) ? raw.roleHistory : []
    )
      .map((entry, historyIndex) => {
        if (!isRecord(entry)) {
          invalidStructure(
            `Role history ${historyIndex + 1} for ${displayName} must be an object.`,
            `people[${index}].roleHistory[${historyIndex}]`,
          );
        }
        const effectiveDate = cleanString(entry.effectiveDate);
        const role = entry.role as WorkbenchPersonRole;
        if (!isWorkbenchConfigurationDay(effectiveDate)) {
          diagnostics.push({
            severity: "error",
            code: "INVALID_DATE",
            message: `Invalid role effective date: ${effectiveDate}.`,
            path: `people[${index}].roleHistory[${historyIndex}].effectiveDate`,
          });
        }
        if (!(WORKBENCH_PERSON_ROLES as readonly unknown[]).includes(role)) {
          diagnostics.push({
            severity: "error",
            code: "INVALID_ROLE",
            message: `Invalid personnel role: ${String(role)}.`,
            path: `people[${index}].roleHistory[${historyIndex}].role`,
          });
        }
        if (roleDates.has(effectiveDate)) {
          diagnostics.push({
            severity: "error",
            code: "DUPLICATE_ROLE_HISTORY",
            message: `Duplicate role history date ${effectiveDate} for ${displayName}.`,
            path: `people[${index}].roleHistory`,
          });
        }
        roleDates.add(effectiveDate);
        return { effectiveDate, role };
      })
      .sort((left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate),
      );
    const currentRole = parsedRoleHistory.at(-1)?.role;
    const roleHistory =
      currentRole &&
      (WORKBENCH_PERSON_ROLES as readonly unknown[]).includes(currentRole)
        ? [
            {
              effectiveDate: WORKBENCH_STATIC_ROLE_EFFECTIVE_DATE,
              role: currentRole,
            },
          ]
        : [];
    if (roleHistory.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "MISSING_ROLE",
        message: `${displayName} has no role history.`,
        path: `people[${index}].roleHistory`,
      });
    }
    personIds.add(id);
    return {
      id,
      displayName,
      email,
      enabled: raw.enabled !== false,
      roleHistory,
    };
  });
  if (people.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "MISSING_PERSONNEL",
      message: "No personnel are configured.",
      path: "people",
    });
  }
  for (const [email, indexes] of emailIndexes) {
    if (indexes.length <= 1) continue;
    for (const index of indexes) {
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_EMAIL",
        message: `Duplicate personnel email: ${email}.`,
        path: `people[${index}].email`,
      });
    }
  }

  const staffingKeys = new Set<string>();
  const staffingHistory = requiredArray(input, "staffingHistory")
    .map((raw, index) => {
      if (!isRecord(raw)) {
        invalidStructure(
          `Staffing record ${index + 1} must be an object.`,
          `staffingHistory[${index}]`,
        );
      }
      const workstationId = cleanString(raw.workstationId);
      const effectiveDate = cleanString(raw.effectiveDate);
      const status = raw.status as "active" | "inactive";
      const originalCollectors =
        raw.originalCollectors === null || raw.originalCollectors === undefined
          ? null
          : Number(raw.originalCollectors);
      if (!workstationIds.has(workstationId)) {
        diagnostics.push({
          severity: "error",
          code: "UNKNOWN_WORKSTATION",
          message: `Staffing references unknown workstation ${workstationId}.`,
          path: `staffingHistory[${index}].workstationId`,
        });
      }
      if (!isWorkbenchConfigurationDay(effectiveDate)) {
        diagnostics.push({
          severity: "error",
          code: "INVALID_DATE",
          message: `Invalid staffing effective date: ${effectiveDate}.`,
          path: `staffingHistory[${index}].effectiveDate`,
        });
      }
      if (status !== "active" && status !== "inactive") {
        diagnostics.push({
          severity: "error",
          code: "INVALID_STAFFING_STATUS",
          message: `Invalid staffing status: ${String(status)}.`,
          path: `staffingHistory[${index}].status`,
        });
      }
      if (
        originalCollectors !== null &&
        (!Number.isInteger(originalCollectors) || originalCollectors < 0)
      ) {
        diagnostics.push({
          severity: "error",
          code: "INVALID_COLLECTOR_COUNT",
          message:
            "Original collectors must be a non-negative integer or null.",
          path: `staffingHistory[${index}].originalCollectors`,
        });
      }
      if (status === "active" && originalCollectors === null) {
        diagnostics.push({
          severity: "warning",
          code: "MISSING_COLLECTOR_COUNT",
          message: `Original collectors is not set for workstation ${workstationId} on ${effectiveDate}.`,
          path: `staffingHistory[${index}].originalCollectors`,
        });
      }
      const memberIds = new Set<string>();
      const members = (Array.isArray(raw.members) ? raw.members : []).flatMap(
        (member, memberIndex) => {
          if (!isRecord(member)) {
            invalidStructure(
              `Staffing member ${memberIndex + 1} must be an object.`,
              `staffingHistory[${index}].members[${memberIndex}]`,
            );
          }
          const personId = cleanString(member.personId);
          if (!personIds.has(personId)) {
            diagnostics.push({
              severity: "error",
              code: "UNKNOWN_PERSON",
              message: `Staffing references unknown personnel ID: ${personId}.`,
              path: `staffingHistory[${index}].members[${memberIndex}].personId`,
            });
          }
          const person = people.find((entry) => entry.id === personId);
          if (
            person &&
            resolveWorkbenchPersonRole(person) !== "data_collector"
          ) {
            return [];
          }
          if (memberIds.has(personId)) {
            diagnostics.push({
              severity: "error",
              code: "DUPLICATE_STAFFING_PERSON",
              message: `Staffing contains duplicate personnel ID: ${personId}.`,
              path: `staffingHistory[${index}].members`,
            });
          }
          memberIds.add(personId);
          return [{ personId, qualityWeight: 1 }];
        },
      );
      const key = [workstationId, effectiveDate].join("\u0000");
      if (staffingKeys.has(key)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_STAFFING_HISTORY",
          message: `Duplicate staffing record for ${workstationId} on ${effectiveDate}.`,
          path: `staffingHistory[${index}]`,
        });
      }
      staffingKeys.add(key);
      if (status === "inactive" && members.length > 0) {
        diagnostics.push({
          severity: "error",
          code: "INACTIVE_STAFFING_MEMBERS",
          message: "Inactive staffing records cannot contain members.",
          path: `staffingHistory[${index}].members`,
        });
      }
      const collectorCount = members.length;
      if (
        status === "active" &&
        originalCollectors !== null &&
        collectorCount > originalCollectors
      ) {
        diagnostics.push({
          severity: "error",
          code: "TOO_MANY_COLLECTORS",
          message: `Workstation ${workstationId} has ${collectorCount} collectors but only ${originalCollectors} were planned.`,
          path: `staffingHistory[${index}].members`,
        });
      }
      if (
        status === "active" &&
        originalCollectors !== null &&
        collectorCount < originalCollectors
      ) {
        diagnostics.push({
          severity: "warning",
          code: "UNFILLED_COLLECTOR_SLOTS",
          message: `Workstation ${workstationId} has ${originalCollectors - collectorCount} unfilled collector slot(s) on ${effectiveDate}.`,
          path: `staffingHistory[${index}].members`,
        });
      }
      return {
        workstationId,
        effectiveDate,
        status,
        originalCollectors,
        members,
      };
    })
    .sort(
      (left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate) ||
        left.workstationId.localeCompare(right.workstationId),
    );

  const config: WorkbenchConfigurationV2 = {
    version: WORKBENCH_CONFIGURATION_VERSION,
    workstations,
    devices,
    legacyDeviceAliases,
    people,
    staffingHistory,
  };
  pruneWorkbenchWorkstations(config);
  const boundaryDates = new Set([
    ...staffingHistory.map((record) => record.effectiveDate),
    ...people.flatMap((person) =>
      person.roleHistory.map((entry) => entry.effectiveDate),
    ),
  ]);
  for (const effectiveDate of boundaryDates) {
    for (const workstation of workstations) {
      const effective = resolveWorkbenchStaffing(
        config,
        workstation.id,
        effectiveDate,
      );
      if (
        effective.status !== "active" ||
        effective.originalCollectors === null
      ) {
        continue;
      }
      const collectors = effective.members.filter((member) => {
        const person = people.find((entry) => entry.id === member.personId);
        return (
          person &&
          resolveWorkbenchPersonRole(person, effectiveDate) === "data_collector"
        );
      }).length;
      if (collectors > effective.originalCollectors) {
        const alreadyReported = diagnostics.some(
          (entry) =>
            entry.code === "TOO_MANY_COLLECTORS" &&
            entry.message.includes(workstation.id) &&
            entry.message.includes(effectiveDate),
        );
        if (!alreadyReported) {
          diagnostics.push({
            severity: "error",
            code: "TOO_MANY_COLLECTORS",
            message: `Workstation ${workstation.id} has ${collectors} collectors but only ${effective.originalCollectors} were planned on ${effectiveDate}.`,
          });
        }
      }
    }
  }
  for (const observed of observedDevices) {
    const configured =
      observed.source === "left_gripper_sn"
        ? legacyDeviceAliases.some(
            (alias) => alias.identifier === observed.identifier,
          )
        : devices.some(
            (device) =>
              device.source === observed.source &&
              device.identifier === observed.identifier,
          );
    if (!configured) {
      diagnostics.push({
        severity: "warning",
        code: "OBSERVED_DEVICE_UNCONFIGURED",
        message: `Observed ${observed.source} device ${observed.identifier} is not configured.`,
      });
    }
  }
  if (errors().length > 0) {
    throw new WorkbenchConfigurationValidationError(diagnostics);
  }
  return { config, diagnostics };
}

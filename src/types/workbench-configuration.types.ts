export const WORKBENCH_CONFIGURATION_VERSION = 2 as const;

export const WORKBENCH_DEVICE_TYPES = [
  "umi_gripper",
  "pico_umi_gripper",
  "collector_backpack",
] as const;

export type WorkbenchDeviceType = (typeof WORKBENCH_DEVICE_TYPES)[number];
export type WorkbenchDeviceSource = "robot_id" | "collector_sn";

export const WORKBENCH_PERSON_ROLES = [
  "data_collector",
  "data_quality_inspector",
  "manager",
  "developer",
] as const;

export type WorkbenchPersonRole = (typeof WORKBENCH_PERSON_ROLES)[number];

export type WorkbenchWorkstationV2 = {
  id: string;
  name: string;
  enabled: boolean;
};

export type WorkbenchDeviceV2 = {
  id: string;
  type: WorkbenchDeviceType;
  /** Determined by type; exposed so malformed documents can be diagnosed. */
  source: WorkbenchDeviceSource;
  identifier: string;
  /** Latest value for legacy consumers; day-aware code must use assignmentHistory. */
  workstationId: string | null;
  assignmentHistory?: WorkbenchDeviceAssignmentV2[];
};

export type WorkbenchLegacyDeviceAliasV2 = {
  id: string;
  identifier: string;
  deviceId: string | null;
  /** Latest explicit alias value; day-aware code must use assignmentHistory. */
  workstationId: string | null;
  assignmentHistory?: WorkbenchDeviceAssignmentV2[];
};

export type WorkbenchDeviceAssignmentV2 = {
  effectiveDate: string;
  workstationId: string | null;
};

export type WorkbenchPersonRoleHistoryV2 = {
  effectiveDate: string;
  role: WorkbenchPersonRole;
};

export type WorkbenchPersonV2 = {
  id: string;
  displayName: string;
  email: string;
  /** Older configuration documents omit this and are treated as enabled. */
  enabled?: boolean;
  roleHistory: WorkbenchPersonRoleHistoryV2[];
};

export type WorkbenchStaffingMemberV2 = {
  personId: string;
  /** Hidden v2 compatibility field; normalized to 1. */
  qualityWeight: number;
};

export type WorkbenchStaffingRecordV2 = {
  workstationId: string;
  effectiveDate: string;
  status: "active" | "inactive";
  /** Null is intentionally saveable but produces a strong warning. */
  originalCollectors: number | null;
  members: WorkbenchStaffingMemberV2[];
};

export type WorkbenchConfigurationV2 = {
  version: typeof WORKBENCH_CONFIGURATION_VERSION;
  workstations: WorkbenchWorkstationV2[];
  devices: WorkbenchDeviceV2[];
  legacyDeviceAliases: WorkbenchLegacyDeviceAliasV2[];
  people: WorkbenchPersonV2[];
  staffingHistory: WorkbenchStaffingRecordV2[];
};

export type WorkbenchConfigurationDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
};

export type WorkbenchObservedDevice = {
  identifier: string;
  source: WorkbenchDeviceSource | "left_gripper_sn";
  suggestedType: WorkbenchDeviceType | null;
  datasetCount: number;
  configuredDeviceId: string | null;
};

export type WorkbenchDeviceTypeDescriptor = {
  type: WorkbenchDeviceType;
  source: WorkbenchDeviceSource;
  label: string;
  suggestedPrefixes: string[];
};

export type WorkbenchConfigurationResponse = {
  config: WorkbenchConfigurationV2;
  revision: string;
  updatedAt: string | null;
  source: "stored" | "migrated";
  /** Origin of the workstation half when this is an in-memory migration. */
  legacySource: "stored" | "defaults" | null;
  deviceTypes: WorkbenchDeviceTypeDescriptor[];
  observedDevices: WorkbenchObservedDevice[];
  diagnostics: WorkbenchConfigurationDiagnostic[];
};

export type WorkbenchEffectiveStaffingV2 = {
  workstationId: string;
  day: string;
  sourceDate: string | null;
  isExplicit: boolean;
  status: "active" | "inactive" | "unconfigured";
  originalCollectors: number | null;
  members: WorkbenchStaffingMemberV2[];
};

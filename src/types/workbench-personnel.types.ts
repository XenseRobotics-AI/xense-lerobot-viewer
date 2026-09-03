import type { WorkbenchRewardPreview } from "@/utils/workbenchRewards";

export type WorkbenchPerson = {
  id: string;
  displayName: string;
  email: string;
};

export type WorkbenchPersonnelScheduleMember = {
  personId: string;
  creditFactor: 1;
};

export type WorkbenchPersonnelScheduleAssignment = {
  workstation: string;
  members: WorkbenchPersonnelScheduleMember[];
};

export type WorkbenchPersonnelSchedules = Record<
  string,
  WorkbenchPersonnelScheduleAssignment[]
>;

export type WorkbenchPersonnelOrganizationConfig = {
  people: WorkbenchPerson[];
  schedules: WorkbenchPersonnelSchedules;
  updatedAt: string | null;
};

export type WorkbenchPersonnelConfig = WorkbenchPersonnelOrganizationConfig & {
  org: string;
};

export type WorkbenchEffectivePersonnelSchedule = {
  day: string;
  sourceDate: string | null;
  isExplicit: boolean;
  assignments: WorkbenchPersonnelScheduleAssignment[];
};

export type WorkbenchPersonnelRollupRow = {
  personId: string;
  personnel: string;
  workstations: string[];
  hours: number;
  scheduledDays: number;
  targetHours: number;
  ratePercent: number | null;
  rule: string;
  reward: WorkbenchRewardPreview;
  email: string;
};

export type WorkbenchPersonnelUnattributedWorkstation = {
  day: string;
  workstation: string;
  hours: number;
};

export type WorkbenchPersonnelRollup = {
  rows: WorkbenchPersonnelRollupRow[];
  totalBonus: number;
  unattributedHours: number;
  unattributedWorkstations: WorkbenchPersonnelUnattributedWorkstation[];
};

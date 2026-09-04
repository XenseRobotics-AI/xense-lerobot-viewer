import type { WorkbenchRewardPreview } from "@/utils/workbenchRewards";
import type { WorkbenchQualitySettlement } from "@/types/workbench-score.types";

export type WorkbenchPerson = {
  id: string;
  displayName: string;
  email: string;
};

export type WorkbenchPersonnelScheduleMember = {
  personId: string;
  /** Positive relative contribution weight within this workstation/day. */
  creditFactor: number;
};

export type WorkbenchPersonnelScheduleAssignment = {
  workstation: string;
  /** Original number of collectors for this workstation/day. */
  collectorCount?: number;
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
  /** Existing duration/OKR bonus. */
  durationBonus: number;
  /** Per-dataset quality bonuses allocated by contribution factor. */
  qualityBonus: number;
  /** Duration plus quality bonus. */
  totalBonus: number;
  email: string;
};

export type WorkbenchPersonnelUnattributedWorkstation = {
  day: string;
  workstation: string;
  hours: number;
};

export type WorkbenchPersonnelRollup = {
  rows: WorkbenchPersonnelRollupRow[];
  /** Total duration plus quality bonus. */
  totalBonus: number;
  durationBonusTotal: number;
  qualityBonusTotal: number;
  qualitySettlements: readonly WorkbenchQualitySettlement[];
  unattributedHours: number;
  unattributedWorkstations: WorkbenchPersonnelUnattributedWorkstation[];
};

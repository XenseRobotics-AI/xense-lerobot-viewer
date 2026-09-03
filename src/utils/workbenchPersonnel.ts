import type {
  WorkbenchEffectivePersonnelSchedule,
  WorkbenchPersonnelConfig,
  WorkbenchPersonnelRollup,
  WorkbenchPersonnelRollupRow,
  WorkbenchPersonnelScheduleAssignment,
  WorkbenchPersonnelSchedules,
} from "@/types/workbench-personnel.types";
import type {
  WorkbenchRollupDataset,
  WorkbenchRollupDateRange,
} from "@/utils/workbenchRollup";
import {
  evaluateWorkbenchRewardRules,
  type WorkbenchRewardRulesConfig,
} from "@/utils/workbenchRewards";

const DAY_MS = 86_400_000;

function cloneAssignments(
  assignments: readonly WorkbenchPersonnelScheduleAssignment[],
): WorkbenchPersonnelScheduleAssignment[] {
  return assignments.map((assignment) => ({
    workstation: assignment.workstation,
    members: assignment.members.map((member) => ({ ...member })),
  }));
}

export function resolveWorkbenchPersonnelSchedule(
  schedules: WorkbenchPersonnelSchedules,
  day: string,
): WorkbenchEffectivePersonnelSchedule {
  if (Object.prototype.hasOwnProperty.call(schedules, day)) {
    return {
      day,
      sourceDate: day,
      isExplicit: true,
      assignments: cloneAssignments(schedules[day] ?? []),
    };
  }
  const sourceDate = Object.keys(schedules)
    .filter((candidate) => candidate <= day)
    .sort()
    .at(-1);
  return {
    day,
    sourceDate: sourceDate ?? null,
    isExplicit: false,
    assignments: sourceDate
      ? cloneAssignments(schedules[sourceDate] ?? [])
      : [],
  };
}

function dayValue(day: string | null): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const [year, month, date] = day.split("-").map(Number);
  const value = Date.UTC(year, month - 1, date);
  return new Date(value).toISOString().slice(0, 10) === day ? value : null;
}

function daysInRange(range: WorkbenchRollupDateRange): string[] {
  const start = dayValue(range.startDate);
  const end = dayValue(range.endDate);
  if (start === null || end === null || start === end) return [];
  const [left, right] = start < end ? [start, end] : [end, start];
  const days: string[] = [];
  for (let value = left; value < right; value += DAY_MS) {
    days.push(new Date(value).toISOString().slice(0, 10));
  }
  return days;
}

function roundHours(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function computeWorkbenchPersonnelRollup(
  datasets: readonly WorkbenchRollupDataset[],
  workstationMappings: Readonly<Record<string, string>>,
  personnelConfig: Pick<WorkbenchPersonnelConfig, "people" | "schedules">,
  range: WorkbenchRollupDateRange,
  rewardRules: WorkbenchRewardRulesConfig,
): WorkbenchPersonnelRollup {
  const workstationHours = new Map<string, number>();
  for (const dataset of datasets) {
    const workstationKey =
      dataset.robotId?.trim() || dataset.leftGripperSn?.trim();
    const workstation = workstationKey
      ? workstationMappings[workstationKey]?.trim()
      : "";
    for (const addition of dataset.dailyAdditions ?? []) {
      if (range.startDate && addition.day < range.startDate) continue;
      if (range.endDate && addition.day >= range.endDate) continue;
      const hours = Number(addition.hours);
      if (!Number.isFinite(hours) || hours <= 0) continue;
      const key = `${addition.day}\u0000${workstation || "—"}`;
      workstationHours.set(key, (workstationHours.get(key) ?? 0) + hours);
    }
  }

  type MutableRow = {
    personId: string;
    personnel: string;
    email: string;
    workstations: Set<string>;
    scheduledDays: Set<string>;
    hours: number;
  };
  const peopleById = new Map(
    personnelConfig.people.map((person) => [person.id, person]),
  );
  const rows = new Map<string, MutableRow>();
  const unattributed = new Map<string, number>();

  for (const day of daysInRange(range)) {
    const schedule = resolveWorkbenchPersonnelSchedule(
      personnelConfig.schedules,
      day,
    );
    const assignmentsByWorkstation = new Map(
      schedule.assignments.map((assignment) => [
        assignment.workstation,
        assignment,
      ]),
    );

    for (const assignment of schedule.assignments) {
      for (const member of assignment.members) {
        const person = peopleById.get(member.personId);
        if (!person) continue;
        const row = rows.get(person.id) ?? {
          personId: person.id,
          personnel: person.displayName,
          email: person.email,
          workstations: new Set<string>(),
          scheduledDays: new Set<string>(),
          hours: 0,
        };
        row.workstations.add(assignment.workstation);
        row.scheduledDays.add(day);
        row.hours +=
          (workstationHours.get(`${day}\u0000${assignment.workstation}`) ?? 0) *
          member.creditFactor;
        rows.set(person.id, row);
      }
    }

    for (const [key, hours] of workstationHours) {
      const [hoursDay, workstation] = key.split("\u0000");
      if (hoursDay !== day || assignmentsByWorkstation.has(workstation))
        continue;
      unattributed.set(key, (unattributed.get(key) ?? 0) + hours);
    }
  }

  const completedRows: WorkbenchPersonnelRollupRow[] = Array.from(rows.values())
    .map((row) => {
      const hours = roundHours(row.hours);
      const targetHours = roundHours(
        row.scheduledDays.size * rewardRules.dailyTargetHours,
      );
      const reward = evaluateWorkbenchRewardRules(
        hours,
        targetHours,
        rewardRules,
      );
      return {
        personId: row.personId,
        personnel: row.personnel,
        email: row.email,
        workstations: Array.from(row.workstations).sort((left, right) =>
          left.localeCompare(right),
        ),
        hours,
        scheduledDays: row.scheduledDays.size,
        targetHours,
        ratePercent: reward.percent,
        rule: reward.level?.label ?? reward.symbol,
        reward,
      };
    })
    .sort(
      (left, right) =>
        right.hours - left.hours ||
        left.personnel.localeCompare(right.personnel, "zh-CN") ||
        left.personId.localeCompare(right.personId),
    );

  const unattributedWorkstations = Array.from(unattributed.entries())
    .map(([key, hours]) => {
      const [day, workstation] = key.split("\u0000");
      return { day, workstation, hours: roundHours(hours) };
    })
    .sort(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        left.workstation.localeCompare(right.workstation),
    );
  return {
    rows: completedRows,
    totalBonus: completedRows.reduce((sum, row) => sum + row.reward.amount, 0),
    unattributedHours: roundHours(
      unattributedWorkstations.reduce((sum, row) => sum + row.hours, 0),
    ),
    unattributedWorkstations,
  };
}

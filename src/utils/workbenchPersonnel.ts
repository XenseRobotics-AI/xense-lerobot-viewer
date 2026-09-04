import type {
  WorkbenchEffectivePersonnelSchedule,
  WorkbenchPersonnelConfig,
  WorkbenchPersonnelRollup,
  WorkbenchPersonnelRollupRow,
  WorkbenchPersonnelScheduleAssignment,
  WorkbenchPersonnelSchedules,
} from "@/types/workbench-personnel.types";
import {
  workbenchDayKey,
  workbenchDatasetSuffixDay,
  workbenchDatasetRangeContributions,
  type WorkbenchDailyAddition,
  type WorkbenchRollupDataset,
  type WorkbenchRollupDateRange,
} from "@/utils/workbenchRollup";
import {
  allocateWorkbenchCents,
  evaluateWorkbenchRewardRules,
  qualityBonusForGrade,
  roundWorkbenchMoney,
  type WorkbenchRewardRulesConfig,
} from "@/utils/workbenchRewards";
import type {
  WorkbenchDatasetScore,
  WorkbenchQualitySettlement,
} from "@/types/workbench-score.types";

const DAY_MS = 86_400_000;

function cloneAssignments(
  assignments: readonly WorkbenchPersonnelScheduleAssignment[],
): WorkbenchPersonnelScheduleAssignment[] {
  return assignments.map((assignment) => ({
    workstation: assignment.workstation,
    collectorCount: assignment.collectorCount,
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
  datasetScores: ReadonlyMap<string, WorkbenchDatasetScore> = new Map(),
): WorkbenchPersonnelRollup {
  const workstationHours = new Map<string, number>();
  const datasetAdditions = new Map<string, WorkbenchDailyAddition[]>();
  for (const dataset of datasets) {
    const workstationKey =
      dataset.robotId?.trim() || dataset.leftGripperSn?.trim();
    const workstation = workstationKey
      ? workstationMappings[workstationKey]?.trim()
      : "";
    const additions = workbenchDatasetRangeContributions(dataset, range).filter(
      (addition) => {
        const hours = Number(addition.hours);
        return Number.isFinite(hours) && hours > 0;
      },
    );
    if (additions.length > 0)
      datasetAdditions.set(dataset.relativePath, additions);
    for (const addition of additions) {
      const hours = Number(addition.hours);
      const key = [addition.day, workstation || "—"].join("\u0000");
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
    targetHours: number;
    durationBonus: number;
  };
  const peopleById = new Map(
    personnelConfig.people.map((person) => [person.id, person]),
  );
  const rows = new Map<string, MutableRow>();
  const unattributed = new Map<string, number>();
  type MutableWorkstation = {
    hours: number;
    targetHours: number;
    assignmentDays: number;
    memberShareSums: Map<string, number>;
  };
  const workstationRollups = new Map<string, MutableWorkstation>();

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
      const mappedCollectorCount = assignment.members.length;
      const configuredCollectorCount = assignment.collectorCount;
      const collectorCount =
        typeof configuredCollectorCount === "number" &&
        Number.isInteger(configuredCollectorCount) &&
        configuredCollectorCount > 0 &&
        configuredCollectorCount >= mappedCollectorCount
          ? configuredCollectorCount
          : mappedCollectorCount;
      const workstationKey = assignment.workstation.trim();
      const workstationRollup = workstationRollups.get(workstationKey) ?? {
        hours: 0,
        targetHours: 0,
        assignmentDays: 0,
        memberShareSums: new Map<string, number>(),
      };
      workstationRollup.hours +=
        workstationHours.get([day, assignment.workstation].join("\u0000")) ?? 0;
      workstationRollup.targetHours += rewardRules.dailyTargetHours;
      workstationRollup.assignmentDays += 1;

      for (const member of assignment.members) {
        const person = peopleById.get(member.personId);
        if (!person) continue;
        workstationRollup.memberShareSums.set(
          person.id,
          (workstationRollup.memberShareSums.get(person.id) ?? 0) +
            1 / collectorCount,
        );
        const row = rows.get(person.id) ?? {
          personId: person.id,
          personnel: person.displayName,
          email: person.email,
          workstations: new Set<string>(),
          scheduledDays: new Set<string>(),
          hours: 0,
          targetHours: 0,
          durationBonus: 0,
        };
        row.workstations.add(assignment.workstation);
        row.scheduledDays.add(day);
        row.hours +=
          (workstationHours.get([day, assignment.workstation].join("\u0000")) ??
            0) / collectorCount;
        row.targetHours += rewardRules.dailyTargetHours / collectorCount;
        rows.set(person.id, row);
      }
      workstationRollups.set(workstationKey, workstationRollup);
    }

    for (const [key, hours] of workstationHours) {
      const [hoursDay, workstation] = key.split("\u0000");
      if (hoursDay !== day || assignmentsByWorkstation.has(workstation))
        continue;
      unattributed.set(key, (unattributed.get(key) ?? 0) + hours);
    }
  }

  for (const workstation of workstationRollups.values()) {
    const workstationReward = evaluateWorkbenchRewardRules(
      workstation.hours,
      workstation.targetHours,
      rewardRules,
    );
    if (workstation.assignmentDays <= 0) continue;
    for (const [personId, shareSum] of workstation.memberShareSums) {
      const row = rows.get(personId);
      if (!row) continue;
      row.durationBonus +=
        workstationReward.amount * (shareSum / workstation.assignmentDays);
    }
  }

  const qualityByPerson = new Map<string, number>();
  const qualitySettlements: WorkbenchQualitySettlement[] = [];
  for (const [datasetPath, score] of datasetScores) {
    const dataset = datasets.find(
      (entry) => entry.relativePath === datasetPath,
    );
    if (!dataset) continue;
    const addition = datasetAdditions.get(datasetPath)?.[0];
    const datasetDay =
      addition?.day ??
      workbenchDatasetSuffixDay(dataset.relativePath, dataset.lastModified) ??
      workbenchDayKey(dataset.lastModified);
    if (
      !datasetDay ||
      (range.startDate && datasetDay < range.startDate) ||
      (range.endDate && datasetDay >= range.endDate)
    )
      continue;
    if (score.status !== "scored" || !score.grade) {
      qualitySettlements.push({
        datasetPath,
        grade: score.grade,
        pool: 0,
        allocated: false,
        status: "pending",
        allocations: {},
      });
      continue;
    }
    const key = dataset.robotId?.trim() || dataset.leftGripperSn?.trim();
    const workstation = key ? workstationMappings[key]?.trim() : "";
    const assignment = resolveWorkbenchPersonnelSchedule(
      personnelConfig.schedules,
      datasetDay,
    ).assignments.find((entry) => entry.workstation === workstation);
    const pool = roundWorkbenchMoney(
      qualityBonusForGrade(score.grade, rewardRules.qualityBonusByGrade),
    );
    const members =
      assignment?.members.filter((member) => peopleById.has(member.personId)) ??
      [];
    if (members.length === 0 || !workstation) {
      qualitySettlements.push({
        datasetPath,
        grade: score.grade,
        pool,
        allocated: false,
        status: "unassigned",
        allocations: {},
      });
      continue;
    }
    const cents = allocateWorkbenchCents(
      Math.round(pool * 100),
      members.map((member) => member.creditFactor),
    );
    const allocations: Record<string, number> = {};
    members.forEach((member, index) => {
      allocations[member.personId] =
        (allocations[member.personId] ?? 0) + cents[index];
      qualityByPerson.set(
        member.personId,
        (qualityByPerson.get(member.personId) ?? 0) + cents[index],
      );
    });
    qualitySettlements.push({
      datasetPath,
      grade: score.grade,
      pool,
      allocated: true,
      status: "allocated",
      allocations: Object.fromEntries(
        Object.entries(allocations).map(([personId, value]) => [
          personId,
          value / 100,
        ]),
      ),
    });
  }

  const completedRows: WorkbenchPersonnelRollupRow[] = Array.from(rows.values())
    .map((row) => {
      const hours = roundHours(row.hours);
      const targetHours = roundHours(row.targetHours);
      const performance = evaluateWorkbenchRewardRules(
        hours,
        targetHours,
        rewardRules,
      );
      const durationBonus = roundWorkbenchMoney(row.durationBonus);
      const reward = {
        ...performance,
        amount: durationBonus,
        symbol:
          durationBonus > 0
            ? ("✅" as const)
            : durationBonus < 0
              ? ("❌" as const)
              : performance.symbol === "—"
                ? ("—" as const)
                : ("…" as const),
      };
      const qualityBonus = roundWorkbenchMoney(
        (qualityByPerson.get(row.personId) ?? 0) / 100,
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
        durationBonus,
        qualityBonus,
        totalBonus: roundWorkbenchMoney(durationBonus + qualityBonus),
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
  const durationBonusTotal = roundWorkbenchMoney(
    completedRows.reduce((sum, row) => sum + row.durationBonus, 0),
  );
  const qualityBonusTotal = roundWorkbenchMoney(
    completedRows.reduce((sum, row) => sum + row.qualityBonus, 0),
  );
  return {
    rows: completedRows,
    totalBonus: roundWorkbenchMoney(durationBonusTotal + qualityBonusTotal),
    durationBonusTotal,
    qualityBonusTotal,
    qualitySettlements,
    unattributedHours: roundHours(
      unattributedWorkstations.reduce((sum, row) => sum + row.hours, 0),
    ),
    unattributedWorkstations,
  };
}

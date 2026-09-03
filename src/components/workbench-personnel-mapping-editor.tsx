"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkbenchPersonnelConfig,
  WorkbenchPersonnelScheduleAssignment,
} from "@/types/workbench-personnel.types";
import { resolveWorkbenchPersonnelSchedule } from "@/utils/workbenchPersonnel";

export const WORKBENCH_PERSONNEL_BASELINE_DAY = "1970-01-01";
export const DEFAULT_WORKBENCH_PERSONNEL_EMAIL = "jay@xenserobotics.com";
const ANONYMOUS_PERSONNEL_NAME = "匿名";

export type WorkbenchPersonnelMappingRow = {
  workstation: string;
  personnel: string;
  email: string;
};

type WorkbenchPersonnelMappingEditorProps = {
  organization: string;
  config: WorkbenchPersonnelConfig;
  workstationSuggestions: readonly string[];
  onSaved: (config: WorkbenchPersonnelConfig) => void;
  defaultDay?: string | null;
};

function todayDay(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function compareWorkstations(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function cleanWorkstationSuggestions(
  workstationSuggestions: readonly string[],
): string[] {
  return [...new Set(workstationSuggestions.map((value) => value.trim()))]
    .filter(Boolean)
    .sort(compareWorkstations);
}

export function buildWorkbenchPersonnelMappingRows(
  config: WorkbenchPersonnelConfig,
  workstationSuggestions: readonly string[],
  selectedDay = "9999-12-31",
): WorkbenchPersonnelMappingRow[] {
  const peopleById = new Map(
    config.people.map((person) => [person.id, person]),
  );
  const assignments = resolveWorkbenchPersonnelSchedule(
    config.schedules,
    selectedDay,
  ).assignments;
  const mappedWorkstations = new Set(
    assignments.map((assignment) => assignment.workstation),
  );
  const rows = assignments.flatMap((assignment) =>
    assignment.members.map((member) => {
      const person = peopleById.get(member.personId);
      return {
        workstation: assignment.workstation,
        personnel: person?.displayName.trim() || ANONYMOUS_PERSONNEL_NAME,
        email: person?.email.trim() || DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
      };
    }),
  );

  for (const workstation of cleanWorkstationSuggestions(
    workstationSuggestions,
  )) {
    if (mappedWorkstations.has(workstation)) continue;
    rows.push({
      workstation,
      personnel: ANONYMOUS_PERSONNEL_NAME,
      email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
    });
  }

  return rows.sort((left, right) =>
    compareWorkstations(left.workstation, right.workstation),
  );
}

function nextPersonId(usedIds: Set<string>): string {
  let index = 1;
  while (usedIds.has(`person-${index}`)) index += 1;
  const id = `person-${index}`;
  usedIds.add(id);
  return id;
}

function normalizedMappingRows(
  rows: readonly WorkbenchPersonnelMappingRow[],
  workstationSuggestions: readonly string[],
): WorkbenchPersonnelMappingRow[] {
  const normalized = rows.map((row) => ({
    workstation: row.workstation.trim(),
    personnel: row.personnel.trim() || ANONYMOUS_PERSONNEL_NAME,
    email: row.email.trim() || DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
  }));
  const mappedWorkstations = new Set(
    normalized.map((row) => row.workstation).filter(Boolean),
  );
  for (const workstation of cleanWorkstationSuggestions(
    workstationSuggestions,
  )) {
    if (!mappedWorkstations.has(workstation)) {
      normalized.push({
        workstation,
        personnel: ANONYMOUS_PERSONNEL_NAME,
        email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
      });
    }
  }
  return normalized;
}

export function buildWorkbenchPersonnelConfigFromMapping(
  config: WorkbenchPersonnelConfig,
  rows: readonly WorkbenchPersonnelMappingRow[],
  workstationSuggestions: readonly string[] = [],
  selectedDay = WORKBENCH_PERSONNEL_BASELINE_DAY,
): WorkbenchPersonnelConfig {
  const peopleByName = new Map(
    config.people.map((person) => [person.displayName.trim(), { ...person }]),
  );
  const usedIds = new Set(config.people.map((person) => person.id));
  const mappedEmailsByName = new Map<string, string>();
  const assignmentsByWorkstation = new Map<
    string,
    WorkbenchPersonnelScheduleAssignment
  >();

  for (const row of normalizedMappingRows(rows, workstationSuggestions)) {
    if (!row.workstation) {
      throw new Error("Workstation is required for every personnel mapping.");
    }
    const mappedEmail = mappedEmailsByName.get(row.personnel);
    if (mappedEmail && mappedEmail.toLowerCase() !== row.email.toLowerCase()) {
      throw new Error(
        `Email for ${row.personnel} must be consistent across mappings.`,
      );
    }
    mappedEmailsByName.set(row.personnel, row.email);

    let person = peopleByName.get(row.personnel);
    if (!person) {
      const preferredAnonymousId =
        row.personnel === ANONYMOUS_PERSONNEL_NAME && !usedIds.has("anonymous")
          ? "anonymous"
          : null;
      if (preferredAnonymousId) usedIds.add(preferredAnonymousId);
      person = {
        id: preferredAnonymousId ?? nextPersonId(usedIds),
        displayName: row.personnel,
        email: row.email,
      };
      peopleByName.set(row.personnel, person);
    } else {
      person.email = row.email;
    }

    const assignment = assignmentsByWorkstation.get(row.workstation) ?? {
      workstation: row.workstation,
      members: [],
    };
    if (!assignment.members.some((member) => member.personId === person.id)) {
      assignment.members.push({ personId: person.id, creditFactor: 1 });
    }
    assignmentsByWorkstation.set(row.workstation, assignment);
  }

  const schedules = {
    ...config.schedules,
    [selectedDay]: Array.from(assignmentsByWorkstation.values()),
  };
  const referencedPeople = new Set(
    Object.values(schedules).flatMap((assignments) =>
      assignments.flatMap((assignment) =>
        assignment.members.map((member) => member.personId),
      ),
    ),
  );

  return {
    ...config,
    people: Array.from(peopleByName.values()).filter((person) =>
      referencedPeople.has(person.id),
    ),
    schedules,
  };
}

export default function WorkbenchPersonnelMappingEditor({
  organization,
  config,
  workstationSuggestions,
  onSaved,
  defaultDay,
}: WorkbenchPersonnelMappingEditorProps) {
  const [selectedDay, setSelectedDay] = useState(
    () => defaultDay ?? todayDay(),
  );
  const effective = useMemo(
    () => resolveWorkbenchPersonnelSchedule(config.schedules, selectedDay),
    [config.schedules, selectedDay],
  );
  const initialRows = useMemo(
    () =>
      buildWorkbenchPersonnelMappingRows(
        config,
        workstationSuggestions,
        selectedDay,
      ),
    [config, selectedDay, workstationSuggestions],
  );
  const [rows, setRows] = useState(initialRows);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  useEffect(() => {
    setSelectedDay(defaultDay ?? todayDay());
    setStatus(null);
  }, [defaultDay, organization]);

  const dirty = JSON.stringify(rows) !== JSON.stringify(initialRows);

  const persist = useCallback(
    async (nextConfig: WorkbenchPersonnelConfig, successMessage: string) => {
      setSaving(true);
      setStatus(null);
      try {
        const response = await fetch(
          `/api/workbench/personnel-schedules?org=${encodeURIComponent(organization)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              config: {
                people: nextConfig.people,
                schedules: nextConfig.schedules,
              },
            }),
            cache: "no-store",
          },
        );
        const payload = (await response
          .json()
          .catch(() => ({}))) as WorkbenchPersonnelConfig & { error?: string };
        if (!response.ok) {
          throw new Error(
            payload.error ?? `Unable to save (${response.status}).`,
          );
        }
        onSaved(payload);
        setStatus({ kind: "success", message: successMessage });
      } catch (reason: unknown) {
        setStatus({
          kind: "error",
          message: reason instanceof Error ? reason.message : String(reason),
        });
      } finally {
        setSaving(false);
      }
    },
    [onSaved, organization],
  );

  const save = () => {
    try {
      const nextConfig = buildWorkbenchPersonnelConfigFromMapping(
        config,
        rows,
        workstationSuggestions,
        selectedDay,
      );
      void persist(nextConfig, `Personnel mapping saved for ${selectedDay}.`);
    } catch (reason: unknown) {
      setStatus({
        kind: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  const restoreInheritance = () => {
    const schedules = { ...config.schedules };
    delete schedules[selectedDay];
    void persist(
      { ...config, schedules },
      `Personnel mapping for ${selectedDay} now follows the previous date.`,
    );
  };

  const removeRow = (index: number) => {
    setRows((current) => {
      const row = current[index];
      if (!row) return current;
      const sameWorkstationCount = current.filter(
        (item) => item.workstation === row.workstation,
      ).length;
      if (row.workstation && sameWorkstationCount === 1) {
        return current.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                personnel: ANONYMOUS_PERSONNEL_NAME,
                email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
              }
            : item,
        );
      }
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
    setStatus(null);
  };

  return (
    <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
              Personnel mapping
            </h4>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <span>Date</span>
              <input
                aria-label="Personnel mapping date"
                type="date"
                value={selectedDay}
                disabled={saving}
                onChange={(event) => {
                  const nextDay = event.target.value;
                  if (!nextDay) return;
                  if (
                    dirty &&
                    !window.confirm(
                      "Discard unsaved personnel mapping changes?",
                    )
                  ) {
                    return;
                  }
                  setSelectedDay(nextDay);
                  setStatus(null);
                }}
                className="rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-1.5 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
            </label>
            <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-500">
              {effective.isExplicit
                ? `Saved for ${selectedDay}`
                : effective.sourceDate
                  ? effective.sourceDate === WORKBENCH_PERSONNEL_BASELINE_DAY
                    ? "Inherited from previous date"
                    : `Inherited from ${effective.sourceDate}`
                  : "No previous mapping"}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-[11px] leading-5 text-slate-500">
            Each row binds one workstation to one person. Unconfigured dates
            copy the latest earlier mapping automatically.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setRows(initialRows);
              setStatus(null);
            }}
            disabled={!dirty || saving}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={restoreInheritance}
            disabled={
              !effective.isExplicit ||
              selectedDay === WORKBENCH_PERSONNEL_BASELINE_DAY ||
              saving
            }
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-50"
          >
            Follow previous date
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 disabled:opacity-50"
          >
            {saving ? "Saving…" : `Save ${selectedDay}`}
          </button>
        </div>
      </div>

      {status && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-xs ${
            status.kind === "error"
              ? "border-amber-400/25 bg-amber-400/5 text-amber-200"
              : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
          }`}
        >
          {status.message}
        </div>
      )}

      <datalist id="workbench-personnel-workstations">
        {cleanWorkstationSuggestions(workstationSuggestions).map(
          (workstation) => (
            <option key={workstation} value={workstation} />
          ),
        )}
      </datalist>
      <div className="mt-4 overflow-x-auto rounded-md border border-white/10">
        <table className="w-full min-w-[860px] border-collapse text-left text-xs">
          <thead className="bg-[var(--surface-2)] text-slate-400">
            <tr>
              <th className="w-40 px-3 py-2.5 font-medium">Workstation</th>
              <th className="px-3 py-2.5 font-medium">Personnel</th>
              <th className="px-3 py-2.5 font-medium">Email</th>
              <th className="w-24 px-3 py-2.5 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-white/5">
                <td className="px-3 py-2.5">
                  <input
                    aria-label={`Mapping ${index + 1} workstation`}
                    list="workbench-personnel-workstations"
                    value={row.workstation}
                    placeholder="A2"
                    onChange={(event) => {
                      const workstation = event.target.value;
                      setRows((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, workstation } : item,
                        ),
                      );
                      setStatus(null);
                    }}
                    className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 font-mono text-slate-100 focus:border-cyan-400 focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <input
                    aria-label={`Mapping ${index + 1} personnel`}
                    value={row.personnel}
                    placeholder={ANONYMOUS_PERSONNEL_NAME}
                    onChange={(event) => {
                      const personnel = event.target.value;
                      setRows((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, personnel } : item,
                        ),
                      );
                      setStatus(null);
                    }}
                    className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <input
                    aria-label={`Mapping ${index + 1} email`}
                    type="email"
                    value={row.email}
                    placeholder={DEFAULT_WORKBENCH_PERSONNEL_EMAIL}
                    onChange={(event) => {
                      const email = event.target.value;
                      setRows((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, email } : item,
                        ),
                      );
                      setStatus(null);
                    }}
                    className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-amber-200"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => {
          setRows((current) => [
            ...current,
            {
              workstation: "",
              personnel: ANONYMOUS_PERSONNEL_NAME,
              email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
            },
          ]);
          setStatus(null);
        }}
        className="mt-3 rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
      >
        Add mapping
      </button>
    </section>
  );
}

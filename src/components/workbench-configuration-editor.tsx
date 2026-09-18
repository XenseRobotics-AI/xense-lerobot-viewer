"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/locale-context";
import type {
  WorkbenchConfigurationDiagnostic,
  WorkbenchConfigurationResponse,
  WorkbenchConfigurationV2,
  WorkbenchDeviceType,
  WorkbenchPersonRole,
} from "@/types/workbench-configuration.types";
import {
  compareWorkbenchLabels,
  nextWorkbenchPersonId,
  pruneWorkbenchWorkstations,
  resolveWorkbenchDeviceWorkstationId,
  removeWorkbenchDevice,
  removeWorkbenchPerson,
  resolveWorkbenchPersonRole,
  resolveWorkbenchStaffing,
  sortWorkbenchPeople,
  sortWorkbenchWorkstations,
  workbenchCollectorOptions,
  setWorkbenchDeviceWorkstation,
  setWorkbenchPersonRole,
  suggestWorkbenchDeviceType,
  validateWorkbenchConfiguration,
  workbenchDeviceSourceForType,
  workbenchStaffingWorkstations,
  WorkbenchConfigurationValidationError,
} from "@/utils/workbenchConfiguration";
import WorkbenchModelScopeCredentials from "@/components/workbench-modelscope-credentials";

type Tab = "devices" | "people" | "staffing";

type Props = {
  organization: string;
  initial?: WorkbenchConfigurationResponse;
  onSaved?: (value: WorkbenchConfigurationResponse) => void;
};

const ROLE_LABELS: Record<WorkbenchPersonRole, { en: string; zh: string }> = {
  data_collector: { en: "Data collectors", zh: "数据采集员" },
  data_quality_inspector: { en: "Quality inspectors", zh: "数据质检员" },
  manager: { en: "Managers", zh: "管理者" },
  developer: { en: "Developers", zh: "开发者" },
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cloneConfig(
  config: WorkbenchConfigurationV2,
): WorkbenchConfigurationV2 {
  return JSON.parse(JSON.stringify(config)) as WorkbenchConfigurationV2;
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export default function WorkbenchConfigurationEditor({
  organization,
  initial,
  onSaved,
}: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [loaded, setLoaded] = useState<WorkbenchConfigurationResponse | null>(
    initial ?? null,
  );
  const [draft, setDraft] = useState<WorkbenchConfigurationV2 | null>(
    initial ? cloneConfig(initial.config) : null,
  );
  const [tab, setTab] = useState<Tab>("devices");
  const [day, setDay] = useState(today);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const dirty =
    Boolean(loaded && draft) &&
    JSON.stringify(loaded?.config) !== JSON.stringify(draft);

  const load = useCallback(
    async (discard = false) => {
      if (
        dirty &&
        !discard &&
        !window.confirm(
          zh
            ? "放弃未保存的配置修改？"
            : "Discard unsaved configuration changes?",
        )
      ) {
        return;
      }
      setSaving(true);
      setStatus(null);
      try {
        const response = await fetch(
          `/api/workbench/configuration?org=${encodeURIComponent(organization)}`,
          { cache: "no-store" },
        );
        const payload =
          (await response.json()) as WorkbenchConfigurationResponse & {
            error?: string;
          };
        if (!response.ok)
          throw new Error(payload.error || `Load failed (${response.status})`);
        setLoaded(payload);
        setDraft(cloneConfig(payload.config));
      } catch (error: unknown) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [dirty, organization, zh],
  );

  useEffect(() => {
    if (!loaded) void load(true);
  }, [load, loaded]);

  useEffect(() => {
    if (!initial || dirty) return;
    setLoaded(initial);
    setDraft(cloneConfig(initial.config));
  }, [dirty, initial]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  const diagnostics = useMemo<WorkbenchConfigurationDiagnostic[]>(() => {
    if (!draft) return [];
    try {
      return validateWorkbenchConfiguration(
        draft,
        loaded?.observedDevices ?? [],
      ).diagnostics;
    } catch (error: unknown) {
      return error instanceof WorkbenchConfigurationValidationError
        ? error.diagnostics
        : [
            {
              severity: "error",
              code: "INVALID_DRAFT",
              message: error instanceof Error ? error.message : String(error),
            },
          ];
    }
  }, [draft, loaded?.observedDevices]);
  const hasErrors = diagnostics.some((entry) => entry.severity === "error");

  const update = (mutate: (next: WorkbenchConfigurationV2) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      mutate(next);
      return next;
    });
    setStatus(null);
  };

  const save = async () => {
    if (!loaded || !draft || hasErrors) return;
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/workbench/configuration?org=${encodeURIComponent(organization)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "if-match": loaded.revision,
          },
          body: JSON.stringify({ config: draft }),
          cache: "no-store",
        },
      );
      const payload =
        (await response.json()) as WorkbenchConfigurationResponse & {
          error?: string;
        };
      if (!response.ok) {
        const suffix =
          response.status === 409
            ? zh
              ? " 草稿已保留，请重新加载后手工合并。"
              : " Your draft was preserved; reload and merge it manually."
            : "";
        throw new Error(
          (payload.error || `Save failed (${response.status})`) + suffix,
        );
      }
      setLoaded(payload);
      setDraft(cloneConfig(payload.config));
      setStatus(
        zh
          ? "统一配置已保存并进入共享同步队列。"
          : "Configuration saved and queued for shared sync.",
      );
      onSaved?.(payload);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const people = draft ? sortWorkbenchPeople(draft.people) : [];
  const staffingWorkstations = useMemo(() => {
    if (!draft) return [];
    const statusRank = (
      status: ReturnType<typeof resolveWorkbenchStaffing>["status"],
    ) => (status === "active" ? 0 : status === "unconfigured" ? 1 : 2);
    return sortWorkbenchWorkstations(workbenchStaffingWorkstations(draft)).sort(
      (left, right) =>
        statusRank(resolveWorkbenchStaffing(draft, left.id, day).status) -
          statusRank(resolveWorkbenchStaffing(draft, right.id, day).status) ||
        compareWorkbenchLabels(left.name, right.name) ||
        compareWorkbenchLabels(left.id, right.id),
    );
  }, [day, draft]);

  if (!draft || !loaded) {
    return (
      <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4 text-xs text-slate-400">
        {saving ? (zh ? "正在加载配置……" : "Loading configuration…") : status}
      </section>
    );
  }

  const upsertRole = (personId: string, role: WorkbenchPersonRole) =>
    update((next) => setWorkbenchPersonRole(next, personId, role));

  const staffingAtDay = (workstationId: string) =>
    draft.staffingHistory.find(
      (record) =>
        record.workstationId === workstationId && record.effectiveDate === day,
    );
  const ensureStaffing = (workstationId: string) => {
    let record = staffingAtDay(workstationId);
    if (record) return record;
    const inherited = resolveWorkbenchStaffing(draft, workstationId, day);
    record = {
      workstationId,
      effectiveDate: day,
      status: inherited.status === "active" ? "active" : "inactive",
      originalCollectors: inherited.originalCollectors,
      members: inherited.members.map((member) => ({ ...member })),
    };
    return record;
  };
  const updateStaffing = (
    workstationId: string,
    change: (
      record: WorkbenchConfigurationV2["staffingHistory"][number],
    ) => void,
  ) =>
    update((next) => {
      let record = next.staffingHistory.find(
        (entry) =>
          entry.workstationId === workstationId && entry.effectiveDate === day,
      );
      if (!record) {
        const inherited = resolveWorkbenchStaffing(draft, workstationId, day);
        record = {
          workstationId,
          effectiveDate: day,
          status: inherited.status === "active" ? "active" : "inactive",
          originalCollectors: inherited.originalCollectors,
          members: inherited.members.map((member) => ({ ...member })),
        };
        next.staffingHistory.push(record);
      }
      change(record);
    });

  const tabLabel: Record<Tab, string> = {
    devices: zh ? "设备与工位" : "Devices & Workstations",
    people: zh ? "人员目录" : "Personnel Directory",
    staffing: zh ? "日期排班" : "Date Staffing",
  };

  return (
    <section className="rounded-md border border-cyan-400/20 bg-[var(--surface-1)]/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-100">
            {zh ? "Configuration · 统一配置" : "Configuration"}
          </h4>
          <p className="mt-1 text-[11px] text-slate-500">
            {zh
              ? "设备实例 → 工位 → 日期人员配置，共享同一份草稿并原子保存。"
              : "Device instances → workstations → date staffing, in one shared draft and atomic save."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => setDraft(cloneConfig(loaded.config))}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40"
          >
            {zh ? "放弃" : "Discard"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void load()}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40"
          >
            {zh ? "重新加载" : "Reload"}
          </button>
          <button
            type="button"
            disabled={!dirty || saving || hasErrors}
            onClick={() => void save()}
            className="rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 disabled:opacity-40"
          >
            {saving
              ? zh
                ? "保存中……"
                : "Saving…"
              : zh
                ? "保存全部"
                : "Save all"}
          </button>
        </div>
      </div>

      <WorkbenchModelScopeCredentials organization={organization} />

      <div className="mt-4 flex gap-1 border-b border-white/10" role="tablist">
        {(["devices", "people", "staffing"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`px-3 py-2 text-xs ${tab === value ? "border-b-2 border-cyan-300 text-cyan-100" : "text-slate-400"}`}
          >
            {tabLabel[value]}
          </button>
        ))}
      </div>

      {diagnostics.length > 0 && (
        <div className="mt-3 max-h-32 overflow-auto rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px]">
          {diagnostics.map((entry, index) => (
            <div
              key={`${entry.code}-${entry.path}-${index}`}
              className={
                entry.severity === "error" ? "text-red-300" : "text-amber-200"
              }
            >
              {entry.severity === "error" ? "⛔" : "⚠"} {entry.message}
            </div>
          ))}
        </div>
      )}
      {status && (
        <p className="mt-3 text-xs text-cyan-200" role="status">
          {status}
        </p>
      )}

      {tab === "devices" && (
        <div className="mt-4 space-y-5">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            {zh ? "工位生效日期" : "Workstation effective date"}
            <input
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
              className="input w-auto"
            />
          </label>
          <ConfigTable
            title={zh ? "设备实例" : "Device instances"}
            headers={[
              zh ? "主标识" : "Primary identifier",
              zh ? "类别" : "Type",
              "Source",
              zh ? "工位" : "Workstation",
              "",
            ]}
          >
            {draft.devices.map((device) => (
              <tr key={device.id} className="border-t border-white/5">
                <Cell>
                  <input
                    value={device.identifier}
                    onChange={(event) =>
                      update((next) => {
                        const found = next.devices.find(
                          (entry) => entry.id === device.id,
                        );
                        if (found) found.identifier = event.target.value;
                      })
                    }
                    className="input font-mono"
                  />
                </Cell>
                <Cell>
                  <select
                    value={device.type}
                    onChange={(event) =>
                      update((next) => {
                        const found = next.devices.find(
                          (entry) => entry.id === device.id,
                        );
                        if (found) {
                          found.type = event.target
                            .value as WorkbenchDeviceType;
                          found.source = workbenchDeviceSourceForType(
                            found.type,
                          );
                        }
                      })
                    }
                    className="input"
                  >
                    {loaded.deviceTypes.map((entry) => (
                      <option key={entry.type} value={entry.type}>
                        {entry.type}
                      </option>
                    ))}
                  </select>
                </Cell>
                <Cell mono>{device.source}</Cell>
                <Cell>
                  <WorkstationInput
                    value={
                      draft.workstations.find(
                        (station) =>
                          station.id ===
                          resolveWorkbenchDeviceWorkstationId(device, day),
                      )?.name ?? ""
                    }
                    onCommit={(value) =>
                      update((next) =>
                        setWorkbenchDeviceWorkstation(
                          next,
                          device.id,
                          value,
                          day,
                        ),
                      )
                    }
                  />
                </Cell>
                <Cell>
                  <button
                    type="button"
                    onClick={() =>
                      update((next) => removeWorkbenchDevice(next, device.id))
                    }
                    className="text-amber-200"
                  >
                    {zh ? "删除" : "Remove"}
                  </button>
                </Cell>
              </tr>
            ))}
          </ConfigTable>
          <button
            type="button"
            onClick={() =>
              update((next) =>
                next.devices.push({
                  id: newId("device"),
                  identifier: "",
                  type: "umi_gripper",
                  source: "robot_id",
                  workstationId: null,
                  assignmentHistory: [],
                }),
              )
            }
            className="small-button"
          >
            {zh ? "手工添加设备" : "Add device manually"}
          </button>

          <div>
            <h5 className="text-xs font-semibold text-slate-300">
              {zh ? "数据集中发现" : "Observed in datasets"}
            </h5>
            <div className="mt-2 flex flex-wrap gap-2">
              {loaded.observedDevices
                .filter(
                  (entry) =>
                    entry.source !== "left_gripper_sn" &&
                    !draft.devices.some(
                      (device) =>
                        device.source === entry.source &&
                        device.identifier === entry.identifier,
                    ),
                )
                .map((entry) => (
                  <button
                    key={`${entry.source}-${entry.identifier}`}
                    type="button"
                    onClick={() =>
                      update((next) => {
                        const type =
                          entry.suggestedType ??
                          suggestWorkbenchDeviceType(
                            entry.identifier,
                            entry.source as "robot_id" | "collector_sn",
                          );
                        next.devices.push({
                          id: newId("device"),
                          identifier: entry.identifier,
                          type,
                          source: workbenchDeviceSourceForType(type),
                          workstationId: null,
                          assignmentHistory: [],
                        });
                      })
                    }
                    className="rounded-md border border-amber-300/20 px-2 py-1 text-[11px] text-amber-100"
                  >
                    + {entry.identifier} · {entry.source} · {entry.datasetCount}
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {tab === "people" && (
        <div className="mt-4">
          <ConfigTable
            title={zh ? "人员目录" : "Personnel directory"}
            headers={[
              zh ? "稳定 ID" : "Stable ID",
              zh ? "原名称" : "Original name",
              "Email",
              zh ? "角色" : "Role",
              zh ? "状态" : "Status",
              "",
            ]}
          >
            {people.map((person) => (
              <tr key={person.id} className="border-t border-white/5">
                <Cell mono>{person.id}</Cell>
                <Cell>
                  <input
                    value={person.displayName}
                    onChange={(event) =>
                      update((next) => {
                        const found = next.people.find(
                          (entry) => entry.id === person.id,
                        );
                        if (found) found.displayName = event.target.value;
                      })
                    }
                    className="input"
                  />
                </Cell>
                <Cell>
                  <input
                    type="email"
                    value={person.email}
                    onChange={(event) =>
                      update((next) => {
                        const found = next.people.find(
                          (entry) => entry.id === person.id,
                        );
                        if (found) found.email = event.target.value;
                      })
                    }
                    className="input"
                  />
                </Cell>
                <Cell>
                  <select
                    value={resolveWorkbenchPersonRole(person) ?? ""}
                    onChange={(event) =>
                      upsertRole(
                        person.id,
                        event.target.value as WorkbenchPersonRole,
                      )
                    }
                    className="input"
                  >
                    <option value="" disabled>
                      —
                    </option>
                    {Object.entries(ROLE_LABELS).map(([role, label]) => (
                      <option key={role} value={role}>
                        {zh ? label.zh : label.en}
                      </option>
                    ))}
                  </select>
                </Cell>
                <Cell>
                  <label className="flex items-center gap-2 whitespace-nowrap text-[11px] text-slate-300">
                    <input
                      type="checkbox"
                      checked={person.enabled !== false}
                      aria-label={
                        zh
                          ? `启用人员 ${person.displayName || person.id}`
                          : `Enable personnel ${person.displayName || person.id}`
                      }
                      onChange={(event) =>
                        update((next) => {
                          const found = next.people.find(
                            (entry) => entry.id === person.id,
                          );
                          if (found) found.enabled = event.target.checked;
                        })
                      }
                      className="accent-cyan-400"
                    />
                    {person.enabled !== false
                      ? zh
                        ? "启用"
                        : "Enabled"
                      : zh
                        ? "停用"
                        : "Disabled"}
                  </label>
                </Cell>
                <Cell>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !window.confirm(
                          zh
                            ? `删除“${person.displayName}”并从全部历史排班中移除？`
                            : `Remove “${person.displayName}” from the directory and all staffing history?`,
                        )
                      )
                        return;
                      update((next) => removeWorkbenchPerson(next, person.id));
                    }}
                    className="text-amber-200"
                  >
                    {zh ? "删除" : "Remove"}
                  </button>
                </Cell>
              </tr>
            ))}
          </ConfigTable>
          <button
            type="button"
            onClick={() =>
              update((next) =>
                next.people.push({
                  id: nextWorkbenchPersonId(next.people),
                  displayName: "",
                  email: "",
                  enabled: true,
                  roleHistory: [
                    { effectiveDate: "1970-01-01", role: "data_collector" },
                  ],
                }),
              )
            }
            className="small-button"
          >
            {zh ? "添加人员" : "Add person"}
          </button>
        </div>
      )}

      {tab === "staffing" && (
        <div className="mt-4">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            {zh ? "配置日期" : "Staffing date"}
            <input
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
              className="input w-auto"
            />
          </label>
          <div className="mt-3 space-y-3">
            {staffingWorkstations.map((station) => {
              const effective = resolveWorkbenchStaffing(
                draft,
                station.id,
                day,
              );
              const explicit = staffingAtDay(station.id);
              const working = explicit ?? ensureStaffing(station.id);
              return (
                <div
                  key={station.id}
                  className="rounded-md border border-white/10 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs text-slate-100">
                        {station.name}
                      </span>
                      <span className="ml-2 text-[10px] text-slate-500">
                        {explicit
                          ? zh
                            ? "当日覆盖"
                            : "override"
                          : effective.sourceDate
                            ? `${zh ? "继承自" : "inherited from"} ${effective.sourceDate}`
                            : zh
                              ? "未配置"
                              : "unconfigured"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          updateStaffing(station.id, (record) => {
                            record.status =
                              record.status === "active"
                                ? "inactive"
                                : "active";
                            if (record.status === "inactive")
                              record.members = [];
                          })
                        }
                        className="small-button"
                      >
                        {working.status === "active"
                          ? zh
                            ? "写入停用"
                            : "Deactivate"
                          : zh
                            ? "启用"
                            : "Activate"}
                      </button>
                      <button
                        type="button"
                        disabled={!explicit}
                        onClick={() =>
                          update((next) => {
                            next.staffingHistory = next.staffingHistory.filter(
                              (entry) =>
                                !(
                                  entry.workstationId === station.id &&
                                  entry.effectiveDate === day
                                ),
                            );
                            pruneWorkbenchWorkstations(next);
                          })
                        }
                        className="small-button disabled:opacity-30"
                      >
                        {zh ? "删除当天覆盖" : "Restore inheritance"}
                      </button>
                    </div>
                  </div>
                  {working.status === "active" && (
                    <>
                      <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                        {zh ? "Original collectors" : "Original collectors"}
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={working.originalCollectors ?? ""}
                          onChange={(event) =>
                            updateStaffing(station.id, (record) => {
                              const count =
                                event.target.value === ""
                                  ? null
                                  : Number(event.target.value);
                              record.originalCollectors = count;
                              record.members = record.members.slice(
                                0,
                                count ?? 0,
                              );
                              record.status = "active";
                            })
                          }
                          className="input w-24"
                        />
                      </label>
                      {(working.originalCollectors ?? 0) > 0 && (
                        <div className="mt-3 grid gap-2 md:grid-cols-2">
                          {Array.from(
                            { length: working.originalCollectors ?? 0 },
                            (_, index) => {
                              const selected =
                                working.members[index]?.personId ?? "";
                              const collectorOptions =
                                workbenchCollectorOptions(
                                  draft.people,
                                  working.members.map(
                                    (member) => member.personId,
                                  ),
                                );
                              return (
                                <label
                                  key={index}
                                  className="text-[11px] text-slate-400"
                                >
                                  {zh
                                    ? `采集员 ${index + 1}`
                                    : `Collector ${index + 1}`}
                                  <select
                                    aria-label={`collector-${index + 1}`}
                                    value={selected}
                                    onChange={(event) =>
                                      updateStaffing(station.id, (record) => {
                                        const personId = event.target.value;
                                        const members = [...record.members];
                                        if (!personId) members.splice(index, 1);
                                        else {
                                          const member = {
                                            personId,
                                            qualityWeight: 1,
                                          };
                                          if (index < members.length)
                                            members[index] = member;
                                          else members.push(member);
                                        }
                                        record.members = members
                                          .filter(
                                            (member, memberIndex, values) =>
                                              values.findIndex(
                                                (entry) =>
                                                  entry.personId ===
                                                  member.personId,
                                              ) === memberIndex,
                                          )
                                          .slice(
                                            0,
                                            record.originalCollectors ?? 0,
                                          );
                                        record.status = "active";
                                      })
                                    }
                                    className="input mt-1"
                                  >
                                    <option value="">—</option>
                                    {collectorOptions.map((person) => (
                                      <option
                                        key={person.id}
                                        value={person.id}
                                        disabled={
                                          (person.enabled === false &&
                                            person.id !== selected) ||
                                          (person.id !== selected &&
                                            working.members.some(
                                              (member) =>
                                                member.personId === person.id,
                                            ))
                                        }
                                      >
                                        {person.displayName}
                                        {person.enabled === false
                                          ? zh
                                            ? "（停用）"
                                            : " (disabled)"
                                          : ""}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              );
                            },
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <style jsx>{`
        .input {
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.375rem;
          background: var(--surface-0);
          padding: 0.4rem 0.6rem;
          color: #e2e8f0;
          width: 100%;
        }
        .small-button {
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.375rem;
          padding: 0.35rem 0.65rem;
          font-size: 0.75rem;
          color: #cbd5e1;
        }
      `}</style>
    </section>
  );
}

function ConfigTable({
  title,
  headers,
  children,
}: {
  title: string;
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div>
      <h5 className="mb-2 text-xs font-semibold text-slate-300">{title}</h5>
      <div className="overflow-x-auto rounded-md border border-white/10">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="bg-[var(--surface-2)] text-slate-400">
            <tr>
              {headers.map((header, index) => (
                <th
                  key={`${header}-${index}`}
                  className="px-3 py-2 font-medium"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({
  children,
  mono = false,
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <td className={`px-3 py-2 ${mono ? "font-mono text-slate-300" : ""}`}>
      {children}
    </td>
  );
}

function WorkstationInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [input, setInput] = useState(value);
  useEffect(() => setInput(value), [value]);
  return (
    <input
      value={input}
      onChange={(event) => setInput(event.target.value)}
      onBlur={() => onCommit(input.trim())}
      className="input"
    />
  );
}

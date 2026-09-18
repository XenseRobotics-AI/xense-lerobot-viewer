import { describe, expect, test } from "bun:test";
import type { WorkbenchConfigurationV2 } from "@/types/workbench-configuration.types";
import type { WorkbenchPersonnelConfig } from "@/types/workbench-personnel.types";
import {
  migrateLegacyWorkbenchConfiguration,
  nextWorkbenchPersonId,
  pruneWorkbenchWorkstations,
  removeWorkbenchDevice,
  removeWorkbenchPerson,
  resolveWorkbenchDatasetDevice,
  resolveWorkbenchDeviceWorkstationId,
  resolveWorkbenchPersonRole,
  resolveWorkbenchStaffing,
  setWorkbenchDeviceWorkstation,
  setWorkbenchPersonRole,
  validateWorkbenchConfiguration,
  workbenchPersonnelEmailGroups,
  workbenchStaffingWorkstations,
  WorkbenchConfigurationValidationError,
  sortWorkbenchPeople,
  sortWorkbenchWorkstations,
  workbenchCollectorOptions,
} from "@/utils/workbenchConfiguration";
import { computeWorkbenchPersonnelRollup } from "@/utils/workbenchPersonnel";
import type { WorkbenchRollupDataset } from "@/utils/workbenchRollup";

function baseConfiguration(): WorkbenchConfigurationV2 {
  return {
    version: 2,
    workstations: [
      { id: "A1", name: "A1", enabled: true },
      { id: "NO", name: "NO", enabled: true },
      { id: "N0", name: "N0", enabled: true },
    ],
    devices: [
      {
        id: "robot",
        type: "umi_gripper",
        source: "robot_id",
        identifier: "bi_taccap_8",
        workstationId: "A1",
      },
    ],
    legacyDeviceAliases: [],
    people: [
      {
        id: "collector",
        displayName: "Collector-A1",
        email: "collector@example.com",
        roleHistory: [{ effectiveDate: "1970-01-01", role: "data_collector" }],
      },
      {
        id: "inspector",
        displayName: "Inspector",
        email: "inspector@example.com",
        roleHistory: [
          { effectiveDate: "1970-01-01", role: "data_quality_inspector" },
        ],
      },
      {
        id: "manager",
        displayName: "Manager",
        email: "manager@example.com",
        roleHistory: [{ effectiveDate: "1970-01-01", role: "manager" }],
      },
    ],
    staffingHistory: [
      {
        workstationId: "A1",
        effectiveDate: "2026-09-01",
        status: "active",
        originalCollectors: 2,
        members: [
          { personId: "collector", qualityWeight: 1 },
          { personId: "inspector", qualityWeight: 3 },
          { personId: "manager", qualityWeight: 1 },
        ],
      },
    ],
  };
}

describe("Workbench configuration v2", () => {
  test("sorts enabled labels first with natural ASCII ordering", () => {
    const config = baseConfiguration();
    config.workstations = [
      { id: "cn", name: "中控", enabled: true },
      { id: "disabled", name: "A1", enabled: false },
      { id: "a10", name: "A10", enabled: true },
      { id: "a2", name: "A2", enabled: true },
      { id: "one", name: "1", enabled: true },
    ];
    expect(
      sortWorkbenchWorkstations(config.workstations).map((item) => item.name),
    ).toEqual(["1", "A2", "A10", "中控", "A1"]);

    config.people[0].displayName = "张三";
    config.people[0].enabled = false;
    config.people.push({
      id: "collector-2",
      displayName: "Collector 2",
      email: "collector-2@example.com",
      enabled: true,
      roleHistory: [{ effectiveDate: "1970-01-01", role: "data_collector" }],
    });
    expect(sortWorkbenchPeople(config.people).map((item) => item.id)).toEqual([
      "collector-2",
      "inspector",
      "manager",
      "collector",
    ]);
  });

  test("limits staffing choices to enabled data collectors", () => {
    const config = baseConfiguration();
    config.people.push({
      id: "disabled-collector",
      displayName: "Disabled collector",
      email: "disabled@example.com",
      enabled: false,
      roleHistory: [{ effectiveDate: "1970-01-01", role: "data_collector" }],
    });
    config.people[1].enabled = true;
    config.people[2].enabled = true;

    expect(
      workbenchCollectorOptions(config.people).map((person) => person.id),
    ).toEqual(["collector"]);
    expect(
      workbenchCollectorOptions(config.people, ["disabled-collector"]).map(
        (person) => person.id,
      ),
    ).toEqual(["collector", "disabled-collector"]);
  });

  test("migrates legacy snapshots without losing aliases, people, or stop dates", () => {
    const personnel: WorkbenchPersonnelConfig = {
      org: "TacVerse",
      updatedAt: null,
      people: [
        { id: "one", displayName: "陆萍-A5", email: " jay@example.com " },
        { id: "two", displayName: "陆萍-B2", email: "JAY@example.com" },
        { id: "three", displayName: "Unique", email: " unique@example.com " },
      ],
      schedules: {
        "2026-09-01": [
          {
            workstation: "A5",
            collectorCount: 2,
            members: [{ personId: "one", creditFactor: 2 }],
          },
        ],
        "2026-09-02": [],
      },
    };
    const migrated = migrateLegacyWorkbenchConfiguration(
      {
        TCGU01A31Z0004B: "A5",
        TCGU01A28Z0077m: "A5",
      },
      personnel,
      [
        {
          robotId: "bi_taccap_8",
          collectorSerialNumber: null,
          leftGripperSn: "TCGU01A28Z0077m",
        },
        {
          robotId: "xtac_umi_g1_3",
          collectorSerialNumber: null,
          leftGripperSn: null,
        },
      ],
    );

    expect(migrated.workstations.map((entry) => entry.id)).toEqual(["A5"]);
    expect(migrated.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "collector_backpack",
          source: "collector_sn",
          identifier: "TCGU01A31Z0004B",
          workstationId: "A5",
        }),
        expect.objectContaining({
          type: "umi_gripper",
          identifier: "bi_taccap_8",
          workstationId: "A5",
        }),
        expect.objectContaining({
          type: "pico_umi_gripper",
          identifier: "xtac_umi_g1_3",
          workstationId: null,
        }),
      ]),
    );
    expect(migrated.legacyDeviceAliases[0]).toMatchObject({
      identifier: "TCGU01A28Z0077m",
      workstationId: "A5",
    });
    expect(migrated.people.map((person) => person.email)).toEqual([
      "",
      "",
      "unique@example.com",
    ]);
    expect(
      resolveWorkbenchStaffing(migrated, "A5", "2026-09-03"),
    ).toMatchObject({ status: "inactive", sourceDate: "2026-09-02" });
  });

  test("uses robot_id first and reports a multi-source conflict", () => {
    const config = baseConfiguration();
    config.devices.push({
      id: "backpack",
      type: "collector_backpack",
      source: "collector_sn",
      identifier: "collector-1",
      workstationId: "NO",
    });
    config.legacyDeviceAliases.push({
      id: "alias",
      identifier: "left-1",
      deviceId: null,
      workstationId: "N0",
    });

    expect(
      resolveWorkbenchDatasetDevice(
        {
          robotId: "bi_taccap_8",
          collectorSerialNumber: "collector-1",
          leftGripperSn: "left-1",
        },
        config,
      ),
    ).toMatchObject({
      workstationId: "A1",
      source: "robot_id",
      conflict: true,
    });
  });

  test("allows N0, NO, zero collectors, cleans old inspectors, and blocks invalid sources", () => {
    const config = baseConfiguration();
    config.staffingHistory[0].originalCollectors = 0;
    config.staffingHistory[0].members = [
      { personId: "inspector", qualityWeight: 17 },
    ];
    const normalized = validateWorkbenchConfiguration(config).config;
    expect(normalized.workstations.map((station) => station.name)).toEqual([
      "A1",
    ]);
    expect(normalized.staffingHistory[0].members).toEqual([]);

    config.devices[0].source = "collector_sn";
    expect(() => validateWorkbenchConfiguration(config)).toThrow(
      WorkbenchConfigurationValidationError,
    );
  });

  test("uses the latest historical role as one static role", () => {
    const config = baseConfiguration();
    config.staffingHistory[0].originalCollectors = 1;
    config.people[1].roleHistory.push({
      effectiveDate: "2026-09-03",
      role: "data_collector",
    });
    expect(() => validateWorkbenchConfiguration(config)).toThrow(
      "has 2 collectors but only 1 were planned",
    );
    config.staffingHistory[0].originalCollectors = 2;
    const normalized = validateWorkbenchConfiguration(config).config;
    expect(normalized.people[1].roleHistory).toEqual([
      { effectiveDate: "1970-01-01", role: "data_collector" },
    ]);
  });

  test("builds four static email groups, filtering empty and duplicate addresses", () => {
    const config = baseConfiguration();
    config.people[0].roleHistory.push({
      effectiveDate: "2026-09-05",
      role: "developer",
    });
    config.people[1].email = "COLLECTOR@example.com";
    config.people[2].email = "";
    const before = workbenchPersonnelEmailGroups(config, "2026-09-04");
    expect(before.data_collector).toEqual([]);
    expect(before.data_quality_inspector).toEqual(["COLLECTOR@example.com"]);
    expect(before.manager).toEqual([]);
    expect(before.developer).toEqual(["collector@example.com"]);
    expect(before.all_personnel).toEqual(["collector@example.com"]);
    expect(workbenchPersonnelEmailGroups(config, "1900-01-01")).toEqual(before);
  });

  test("resolves independent workstation inheritance and a static role", () => {
    const config = baseConfiguration();
    config.staffingHistory.push({
      workstationId: "NO",
      effectiveDate: "2026-09-02",
      status: "inactive",
      originalCollectors: null,
      members: [],
    });
    config.people[0].roleHistory.push({
      effectiveDate: "2026-09-05",
      role: "developer",
    });
    expect(resolveWorkbenchStaffing(config, "A1", "2026-09-04")).toMatchObject({
      status: "active",
      sourceDate: "2026-09-01",
      isExplicit: false,
    });
    expect(resolveWorkbenchStaffing(config, "NO", "2026-09-04")).toMatchObject({
      status: "inactive",
      sourceDate: "2026-09-02",
    });
    expect(resolveWorkbenchPersonRole(config.people[0], "2026-09-04")).toBe(
      "developer",
    );
    expect(resolveWorkbenchPersonRole(config.people[0], "2026-09-05")).toBe(
      "developer",
    );
  });

  test("applies device workstation changes from their effective date forward", () => {
    const config = baseConfiguration();
    config.staffingHistory[0].originalCollectors = 1;
    config.staffingHistory[0].members = [
      { personId: "collector", qualityWeight: 1 },
    ];
    config.staffingHistory.push({
      workstationId: "NO",
      effectiveDate: "2026-09-03",
      status: "active",
      originalCollectors: 1,
      members: [{ personId: "collector", qualityWeight: 1 }],
    });
    setWorkbenchDeviceWorkstation(config, "robot", "NO", "2026-09-03");
    const normalized = validateWorkbenchConfiguration(config).config;

    expect(
      resolveWorkbenchDeviceWorkstationId(normalized.devices[0], "2026-09-02"),
    ).toBe("A1");
    expect(
      resolveWorkbenchDeviceWorkstationId(normalized.devices[0], "2026-09-03"),
    ).toBe("NO");
    expect(
      resolveWorkbenchDatasetDevice(
        { robotId: "bi_taccap_8" },
        normalized,
        "2026-09-02",
      ).workstation,
    ).toBe("A1");
    expect(
      resolveWorkbenchDatasetDevice(
        { robotId: "bi_taccap_8" },
        normalized,
        "2026-09-03",
      ).workstation,
    ).toBe("NO");

    const result = computeWorkbenchPersonnelRollup(
      [
        {
          relativePath: "TacVerse/task-0901",
          total_episodes: 2,
          total_frames: 2,
          fps: 30,
          robot_type: "bi_taccap",
          sizeBytes: 0,
          robotId: "bi_taccap_8",
          dailyAdditions: [
            { day: "2026-09-02", hours: 8, episodes: 1, frames: 1 },
            { day: "2026-09-03", hours: 8, episodes: 1, frames: 1 },
          ],
        },
      ],
      {},
      normalized,
      { startDate: "2026-09-02", endDate: "2026-09-04" },
      { enabled: false, dailyTargetHours: 8, levels: [] },
    );

    expect(result.rows[0]).toMatchObject({
      personId: "collector",
      hours: 16,
      workstations: ["A1", "NO"],
    });
  });

  test("creates, reuses, suffixes, and prunes hidden workstation records", () => {
    const config = baseConfiguration();
    config.legacyDeviceAliases.push({
      id: "legacy",
      identifier: "legacy-left",
      deviceId: null,
      workstationId: "NO",
    });
    setWorkbenchDeviceWorkstation(config, "robot", "  Desk A  ");
    expect(config.devices[0].workstationId).toBe("Desk A");
    expect(config.workstations).toContainEqual({
      id: "Desk A",
      name: "Desk A",
      enabled: true,
    });

    config.devices.push({
      id: "robot-2",
      type: "umi_gripper",
      source: "robot_id",
      identifier: "bi_taccap_9",
      workstationId: null,
    });
    setWorkbenchDeviceWorkstation(config, "robot-2", "Desk A");
    expect(config.devices[1].workstationId).toBe("Desk A");
    expect(
      config.workstations.filter((station) => station.name === "Desk A"),
    ).toHaveLength(1);

    config.workstations.push({ id: "Collision", name: "Other", enabled: true });
    config.staffingHistory.push({
      workstationId: "Collision",
      effectiveDate: "2026-08-01",
      status: "inactive",
      originalCollectors: null,
      members: [],
    });
    setWorkbenchDeviceWorkstation(config, "robot-2", "Collision");
    expect(config.devices[1].workstationId).toBe("Collision-2");
    expect(config.workstations).toContainEqual({
      id: "Collision-2",
      name: "Collision",
      enabled: true,
    });

    setWorkbenchDeviceWorkstation(config, "robot-2", "");
    expect(config.devices[1].workstationId).toBeNull();
    expect(
      config.workstations.some((station) => station.id === "Collision-2"),
    ).toBeFalse();
    expect(
      config.workstations.some((station) => station.id === "NO"),
    ).toBeTrue();
  });

  test("accepts N0 and NO, warns on empty workstations, and reserves ERROR", () => {
    const config = baseConfiguration();
    setWorkbenchDeviceWorkstation(config, "robot", "N0");
    expect(
      validateWorkbenchConfiguration(config).config.devices[0],
    ).toMatchObject({
      workstationId: "N0",
    });
    setWorkbenchDeviceWorkstation(config, "robot", "NO");
    expect(
      validateWorkbenchConfiguration(config).config.devices[0],
    ).toMatchObject({
      workstationId: "NO",
    });
    setWorkbenchDeviceWorkstation(config, "robot", "");
    expect(validateWorkbenchConfiguration(config).diagnostics).toContainEqual(
      expect.objectContaining({ code: "DEVICE_WITHOUT_WORKSTATION" }),
    );
    setWorkbenchDeviceWorkstation(config, "robot", "ERROR");
    expect(() => validateWorkbenchConfiguration(config)).toThrow(
      WorkbenchConfigurationValidationError,
    );
  });

  test("keeps historical workstations visible and cascades device and personnel changes", () => {
    const config = baseConfiguration();
    config.staffingHistory.push({
      workstationId: "NO",
      effectiveDate: "2026-08-01",
      status: "active",
      originalCollectors: 1,
      members: [{ personId: "collector", qualityWeight: 4 }],
    });
    expect(
      workbenchStaffingWorkstations(config).map((station) => station.id),
    ).toEqual(["A1", "NO"]);

    setWorkbenchPersonRole(config, "collector", "manager");
    expect(config.people[0].roleHistory).toEqual([
      { effectiveDate: "1970-01-01", role: "manager" },
    ]);
    expect(
      config.staffingHistory.every((record) =>
        record.members.every((member) => member.personId !== "collector"),
      ),
    ).toBeTrue();

    config.staffingHistory[0].members.push({
      personId: "inspector",
      qualityWeight: 1,
    });
    removeWorkbenchPerson(config, "inspector");
    expect(
      config.people.some((person) => person.id === "inspector"),
    ).toBeFalse();
    expect(
      config.staffingHistory[0].members.some(
        (member) => member.personId === "inspector",
      ),
    ).toBeFalse();

    config.legacyDeviceAliases.push({
      id: "legacy",
      identifier: "left",
      deviceId: "robot",
      workstationId: null,
    });
    removeWorkbenchDevice(config, "robot");
    expect(config.legacyDeviceAliases[0].deviceId).toBeNull();
    expect(
      config.workstations.some((station) => station.id === "A1"),
    ).toBeTrue();

    config.staffingHistory = config.staffingHistory.filter(
      (record) => record.workstationId !== "A1",
    );
    pruneWorkbenchWorkstations(config);
    expect(
      config.workstations.some((station) => station.id === "A1"),
    ).toBeFalse();
    expect(
      workbenchStaffingWorkstations(config).map((station) => station.id),
    ).toEqual(["NO"]);
  });

  test("allocates monotonic person-N IDs without reusing gaps", () => {
    expect(nextWorkbenchPersonId([])).toBe("person-1");
    expect(
      nextWorkbenchPersonId([
        { id: "legacy-random" },
        { id: "person-1" },
        { id: "person-3" },
        { id: "person-4x" },
      ]),
    ).toBe("person-4");
    expect(nextWorkbenchPersonId([{ id: "person-900719" }])).toBe(
      "person-900720",
    );
  });
});

describe("v2 personnel settlement", () => {
  const rules = {
    enabled: true,
    dailyTargetHours: 8,
    levels: [
      {
        id: "all",
        label: "all",
        minPercent: 0,
        maxPercent: null,
        amount: 20,
      },
    ],
    qualityBonusByGrade: { A: 40, B: 20, C: 0, D: 0 },
  };

  function dataset(): WorkbenchRollupDataset {
    return {
      relativePath: "TacVerse/task-0901",
      total_episodes: 1,
      total_frames: 1,
      fps: 30,
      robot_type: "bi_taccap",
      sizeBytes: 0,
      robotId: "bi_taccap_8",
      dailyAdditions: [{ day: "2026-09-01", hours: 8, episodes: 1, frames: 1 }],
    };
  }

  test("gives one of two planned collector shares and leaves the other half unattributed", () => {
    const result = computeWorkbenchPersonnelRollup(
      [dataset()],
      { bi_taccap_8: "A1" },
      baseConfiguration(),
      { startDate: "2026-09-01", endDate: "2026-09-02" },
      rules,
    );
    expect(
      result.rows.find((row) => row.personId === "collector"),
    ).toMatchObject({
      hours: 4,
      targetHours: 4,
    });
    expect(result.rows.some((row) => row.personId === "manager")).toBeFalse();
    expect(result.unattributedHours).toBe(4);
  });

  test("keeps a unified quality pool unassigned without inspector rows", () => {
    const data = dataset();
    const result = computeWorkbenchPersonnelRollup(
      [data],
      { bi_taccap_8: "A1" },
      baseConfiguration(),
      { startDate: "2026-09-01", endDate: "2026-09-02" },
      rules,
      new Map([
        [
          data.relativePath,
          {
            status: "scored",
            score: 100,
            grade: "A",
            doctorReport: null,
            scoredAt: "2026-09-01T12:00:00Z",
          },
        ],
      ]),
    );
    expect(result.rows.some((row) => row.personId === "inspector")).toBeFalse();
    expect(
      result.rows.find((row) => row.personId === "collector")?.qualityBonus,
    ).toBe(0);
    expect(result.qualityBonusTotal).toBe(0);
    expect(result.qualitySettlements).toEqual([
      {
        datasetPath: data.relativePath,
        grade: "A",
        pool: 40,
        allocated: false,
        status: "unassigned",
        allocations: {},
      },
    ]);

    const pending = computeWorkbenchPersonnelRollup(
      [data],
      { bi_taccap_8: "A1" },
      baseConfiguration(),
      { startDate: "2026-09-01", endDate: "2026-09-02" },
      rules,
      new Map([
        [
          data.relativePath,
          {
            status: "retry",
            score: null,
            grade: null,
            doctorReport: null,
            scoredAt: null,
          },
        ],
      ]),
    );
    expect(pending.qualitySettlements[0]).toMatchObject({
      pool: 0,
      status: "unassigned",
      allocations: {},
    });
  });

  test("supports zero collectors and records all collection time as unattributed", () => {
    const config = baseConfiguration();
    config.staffingHistory[0].originalCollectors = 0;
    config.staffingHistory[0].members = [
      { personId: "inspector", qualityWeight: 1 },
    ];
    const result = computeWorkbenchPersonnelRollup(
      [dataset()],
      { bi_taccap_8: "A1" },
      config,
      { startDate: "2026-09-01", endDate: "2026-09-02" },
      rules,
    );
    expect(result.unattributedHours).toBe(8);
    expect(result.rows).toEqual([]);
  });
});

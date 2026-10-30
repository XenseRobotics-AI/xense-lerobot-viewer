import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultWorkbenchRewardRules } from "@/lib/workbench-reward-store";
import {
  listPendingWorkbenchSharedEvents,
  markWorkbenchSharedEventsSent,
  migrateLegacyWorkbenchSharedConfig,
  parseWorkbenchSharedConfig,
  recordWorkbenchSharedEvent,
  readWorkbenchSharedSyncBaseline,
  writeWorkbenchSharedSyncBaseline,
  resolveWorkbenchSharedConfig,
  type WorkbenchSharedConfigDocument,
  workbenchSharedConfigPath,
} from "@/lib/workbench-shared-sync";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "workbench-shared-sync-"),
  );
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function configurationDocument(updatedAt: string, workstationName: string) {
  return parseWorkbenchSharedConfig(
    {
      schema: "xense.workbench.config/2",
      version: 2,
      kind: "configuration",
      org: "TacVerse",
      updatedAt,
      data: {
        version: 2,
        workstations: [{ id: "station", name: workstationName, enabled: true }],
        devices: [
          {
            id: "device",
            type: "umi_gripper",
            source: "robot_id",
            identifier: "robot-1",
            workstationId: "station",
          },
        ],
        legacyDeviceAliases: [],
        people: [
          {
            id: "operator-one",
            displayName: "Operator One",
            email: "operator@example.com",
            roleHistory: [
              { effectiveDate: "1970-01-01", role: "data_collector" },
            ],
          },
        ],
        staffingHistory: [],
      },
    },
    "configuration",
    "TacVerse",
  );
}

describe("Workbench shared synchronization", () => {
  test("keeps personnel email addresses in the public v2 document", () => {
    const document = configurationDocument("2026-09-05T08:00:00.000Z", "A1");
    expect(
      (
        document.data.people as Array<{
          email: string;
        }>
      )[0].email,
    ).toBe("operator@example.com");
  });

  test("migrates split v1 documents only when a v2 document is absent", () => {
    const document = migrateLegacyWorkbenchSharedConfig(
      "TacVerse",
      {
        schema: "xense.workbench.config/1",
        version: 1,
        kind: "workstation-mappings",
        org: "TacVerse",
        updatedAt: "2026-09-05T08:00:00.000Z",
        data: { mappings: { TCGU01A28Z0077m: "A5" } },
      },
      {
        schema: "xense.workbench.config/1",
        version: 1,
        kind: "personnel-mapping",
        org: "TacVerse",
        updatedAt: "2026-09-05T09:00:00.000Z",
        data: {
          people: [
            {
              id: "operator",
              displayName: "Operator",
              email: "operator@example.com",
            },
          ],
          schedules: {},
        },
      },
    );
    expect(document).toMatchObject({
      schema: "xense.workbench.config/2",
      version: 2,
      kind: "configuration",
      updatedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(
      (document?.data.legacyDeviceAliases as Array<{ identifier: string }>)[0]
        .identifier,
    ).toBe("TCGU01A28Z0077m");
  });

  test("migrates old shared reward rules with default duration tiers", () => {
    const document = parseWorkbenchSharedConfig(
      {
        schema: "xense.workbench.config/1",
        version: 1,
        kind: "reward-rules",
        org: "TacVerse",
        updatedAt: "2026-09-05T08:00:00.000Z",
        data: {
          enabled: true,
          dailyTargetHours: 6,
          levels: [
            {
              id: "all",
              label: "All",
              minPercent: 0,
              maxPercent: null,
              amount: 10,
            },
          ],
        },
      },
      "reward-rules",
      "TacVerse",
    );

    expect(document.version).toBe(2);
    expect(
      (
        document.data.episodeDurationLevels as Array<{ multiplier: number }>
      ).map((level) => level.multiplier),
    ).toEqual([1.2, 1.1, 1]);
  });

  test("reports first-sync differences even when timestamps differ", () => {
    const older = configurationDocument("2026-09-05T08:00:00.000Z", "A1");
    const newer = configurationDocument("2026-09-05T09:00:00.000Z", "B2");
    const tied = configurationDocument("2026-09-05T08:00:00.000Z", "C3");

    expect(resolveWorkbenchSharedConfig(older, newer)).toMatchObject({
      conflict: true,
      conflictPaths: ['workstations["station"].name'],
    });
    const first = resolveWorkbenchSharedConfig(older, tied);
    const second = resolveWorkbenchSharedConfig(tied, older);
    expect(first.conflict).toBe(true);
    expect(second.conflict).toBe(true);
    expect(second.conflictPaths).toEqual(first.conflictPaths);
  });

  test("merges independent keyed-record changes against a baseline", () => {
    const base = configurationDocument("2026-09-05T08:00:00.000Z", "A1");
    const local = structuredClone(base) as WorkbenchSharedConfigDocument;
    local.updatedAt = "2026-09-05T09:00:00.000Z";
    (local.data.people as Array<Record<string, unknown>>).push({
      id: "operator-two",
      displayName: "Operator Two",
      email: "two@example.com",
      enabled: true,
      roleHistory: [{ effectiveDate: "1970-01-01", role: "manager" }],
    });
    const remote = structuredClone(base) as WorkbenchSharedConfigDocument;
    remote.updatedAt = "2026-09-05T09:01:00.000Z";
    (remote.data.workstations as Array<Record<string, unknown>>)[0].name = "B2";
    const result = resolveWorkbenchSharedConfig(local, remote, base);
    expect(result.winner).toBe("merged");
    expect(result.conflict).toBe(false);
    expect(
      (result.document.data.workstations as Array<Record<string, unknown>>)[0]
        .name,
    ).toBe("B2");
    expect(
      result.document.data.people as Array<Record<string, unknown>>,
    ).toHaveLength(2);
  });

  test("uses remote changes regardless of clock skew when local data is unchanged", () => {
    const base = configurationDocument("2026-09-05T10:00:00.000Z", "A1");
    const remote = configurationDocument("2026-09-05T09:00:00.000Z", "B2");
    expect(resolveWorkbenchSharedConfig(base, remote, base)).toMatchObject({
      winner: "remote",
      conflict: false,
    });
  });

  test("merges independent reward fields and individual reward tiers", () => {
    const base = parseWorkbenchSharedConfig(
      {
        schema: "xense.workbench.config/2",
        version: 2,
        kind: "reward-rules",
        org: "TacVerse",
        updatedAt: "2026-09-05T08:00:00.000Z",
        data: defaultWorkbenchRewardRules("TacVerse"),
      },
      "reward-rules",
      "TacVerse",
    );
    const local = structuredClone(base);
    local.data.dailyTargetHours = 8;
    (local.data.levels as Array<{ amount: number }>)[0].amount = -200;
    const remote = structuredClone(base);
    (remote.data.qualityBonusByGrade as Record<string, number>).A = 30;
    (remote.data.levels as Array<{ amount: number }>)[1].amount = -50;
    const result = resolveWorkbenchSharedConfig(local, remote, base);
    expect(result.conflict).toBe(false);
    expect(result.document.data.dailyTargetHours).toBe(8);
    expect(
      (result.document.data.qualityBonusByGrade as Record<string, number>).A,
    ).toBe(30);
    expect(
      (result.document.data.levels as Array<{ amount: number }>)
        .slice(0, 2)
        .map((entry) => entry.amount),
    ).toEqual([-200, -50]);
  });

  test("detects a combined reward tier that normalization would otherwise discard", () => {
    const base = parseWorkbenchSharedConfig(
      {
        schema: "xense.workbench.config/2",
        version: 2,
        kind: "reward-rules",
        org: "TacVerse",
        updatedAt: "2026-09-05T08:00:00.000Z",
        data: {
          ...defaultWorkbenchRewardRules("TacVerse"),
          levels: [
            { id: "a", label: "A", minPercent: 0, maxPercent: 80, amount: 0 },
            { id: "b", label: "B", minPercent: 80, maxPercent: 90, amount: 10 },
            {
              id: "c",
              label: "C",
              minPercent: 90,
              maxPercent: null,
              amount: 20,
            },
          ],
        },
      },
      "reward-rules",
      "TacVerse",
    );
    const local = structuredClone(base);
    const localLevels = local.data.levels as Array<{
      minPercent: number;
      maxPercent: number | null;
    }>;
    localLevels[0].maxPercent = 95;
    localLevels[1].minPercent = 95;
    localLevels[1].maxPercent = 100;
    localLevels[2].minPercent = 100;
    const remote = structuredClone(base);
    const remoteLevels = remote.data.levels as Array<{
      minPercent: number;
      maxPercent: number | null;
    }>;
    remoteLevels[1].maxPercent = 85;
    remoteLevels[2].minPercent = 85;
    expect(
      resolveWorkbenchSharedConfig(local, remote, base, "remote").document,
    ).toEqual(remote);
    expect(resolveWorkbenchSharedConfig(local, remote, base).conflict).toBe(
      true,
    );
  });

  test("rejects invalid combined references and supports explicit whole-document fallback", () => {
    const base = configurationDocument("2026-09-05T08:00:00.000Z", "A1");
    const local = structuredClone(base);
    local.data.people = [];
    const remote = structuredClone(base);
    remote.data.staffingHistory = [
      {
        workstationId: "station",
        effectiveDate: "2026-09-05",
        status: "active",
        originalCollectors: 1,
        members: [{ personId: "operator-one", qualityWeight: 1 }],
      },
    ];
    expect(resolveWorkbenchSharedConfig(local, remote, base).conflict).toBe(
      true,
    );
    const resolved = resolveWorkbenchSharedConfig(
      local,
      remote,
      base,
      "remote",
    );
    expect(resolved.conflict).toBe(false);
    expect(resolved.document).toEqual(remote);
  });

  test("persists isolated organization baselines and rejects corrupt snapshots", async () => {
    const root = await temporaryRoot();
    expect(await readWorkbenchSharedSyncBaseline("TacVerse", root)).toEqual({
      configuration: null,
      "reward-rules": null,
    });
    const documents = {
      configuration: configurationDocument("2026-09-05T08:00:00.000Z", "A1"),
      "reward-rules": null,
    };
    await writeWorkbenchSharedSyncBaseline("TacVerse", documents, root);
    expect(await readWorkbenchSharedSyncBaseline("TacVerse", root)).toEqual(
      documents,
    );
    expect(
      (await readWorkbenchSharedSyncBaseline("Other", root)).configuration,
    ).toBeNull();
    await fs.writeFile(
      path.join(
        root,
        ".xense-viewer/workbench/shared-sync/baselines/TacVerse.json",
      ),
      "invalid",
    );
    await expect(
      readWorkbenchSharedSyncBaseline("TacVerse", root),
    ).rejects.toThrow();
  });

  test("queues full structured logs while excluding credential fields", async () => {
    const root = await temporaryRoot();
    await recordWorkbenchSharedEvent(
      {
        org: "TacVerse",
        source: "tacflow",
        kind: "score.run",
        outcome: "success",
        occurredAt: "2026-09-05T10:11:12.000Z",
        details: {
          email: "operator@example.com",
          datasetPath: "/home/xense/datasets/TacVerse/example",
          stdout: ["first line", "token=hf_abcdefghijklmnop"],
          stderr: ["warning"],
          report: { checks: [{ id: "schema", passed: true }] },
          hfToken: "hf_should_not_be_stored",
          password: "also-not-stored",
        },
      },
      root,
    );

    const pending = await listPendingWorkbenchSharedEvents(root);
    expect(pending).toHaveLength(1);
    expect(pending[0].remotePath).toMatch(
      /^events\/2026\/09\/05\/[0-9a-f-]+\.json$/u,
    );
    expect(pending[0].event.details.email).toBe("operator@example.com");
    expect(pending[0].event.details.stdout).toEqual([
      "first line",
      "token=[REDACTED]",
    ]);
    expect(pending[0].event.details).not.toHaveProperty("hfToken");
    expect(pending[0].event.details).not.toHaveProperty("password");

    await markWorkbenchSharedEventsSent(pending, root);
    await expect(listPendingWorkbenchSharedEvents(root)).resolves.toEqual([]);
  });

  test("uses organization-scoped v2 config paths", () => {
    expect(workbenchSharedConfigPath("TacVerse", "configuration")).toBe(
      "configs/TacVerse/configuration.json",
    );
    expect(workbenchSharedConfigPath("TacVerse", "reward-rules")).toBe(
      "configs/TacVerse/reward-rules.json",
    );
    expect(() =>
      workbenchSharedConfigPath("../TacVerse", "reward-rules"),
    ).toThrow("organization is invalid");
  });
});

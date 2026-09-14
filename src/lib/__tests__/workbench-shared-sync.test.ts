import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listPendingWorkbenchSharedEvents,
  markWorkbenchSharedEventsSent,
  migrateLegacyWorkbenchSharedConfig,
  parseWorkbenchSharedConfig,
  recordWorkbenchSharedEvent,
  resolveWorkbenchSharedConfig,
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

  test("selects the newer config and resolves timestamp ties deterministically", () => {
    const older = configurationDocument("2026-09-05T08:00:00.000Z", "A1");
    const newer = configurationDocument("2026-09-05T09:00:00.000Z", "B2");
    const tied = configurationDocument("2026-09-05T08:00:00.000Z", "C3");

    expect(resolveWorkbenchSharedConfig(older, newer)).toMatchObject({
      winner: "remote",
      conflict: false,
    });
    const first = resolveWorkbenchSharedConfig(older, tied);
    const second = resolveWorkbenchSharedConfig(tied, older);
    expect(first.conflict).toBe(true);
    expect(second.conflict).toBe(true);
    expect(first.document).toEqual(second.document);
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

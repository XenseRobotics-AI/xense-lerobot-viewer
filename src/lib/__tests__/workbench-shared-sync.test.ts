import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listPendingWorkbenchSharedEvents,
  markWorkbenchSharedEventsSent,
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

describe("Workbench shared synchronization", () => {
  test("keeps personnel email addresses in the public shared document", () => {
    const document = parseWorkbenchSharedConfig(
      {
        schema: "xense.workbench.config/1",
        version: 1,
        kind: "personnel-mapping",
        org: "TacVerse",
        updatedAt: "2026-09-05T08:00:00.000Z",
        data: {
          people: [
            {
              id: "operator-one",
              displayName: "Operator One",
              email: "operator@example.com",
            },
          ],
          schedules: {},
        },
      },
      "personnel-mapping",
      "TacVerse",
    );

    expect(document.data.people).toEqual([
      {
        id: "operator-one",
        displayName: "Operator One",
        email: "operator@example.com",
      },
    ]);
  });

  test("selects the newer config and resolves timestamp ties deterministically", () => {
    const older = parseWorkbenchSharedConfig(
      {
        schema: "xense.workbench.config/1",
        version: 1,
        kind: "workstation-mappings",
        org: "TacVerse",
        updatedAt: "2026-09-05T08:00:00.000Z",
        data: { mappings: { robot: "A1" } },
      },
      "workstation-mappings",
      "TacVerse",
    );
    const newer = parseWorkbenchSharedConfig(
      {
        ...older,
        updatedAt: "2026-09-05T09:00:00.000Z",
        data: { mappings: { robot: "B2" } },
      },
      "workstation-mappings",
      "TacVerse",
    );
    const tied = parseWorkbenchSharedConfig(
      {
        ...older,
        data: { mappings: { robot: "C3" } },
      },
      "workstation-mappings",
      "TacVerse",
    );

    expect(resolveWorkbenchSharedConfig(older, newer)).toMatchObject({
      winner: "remote",
      conflict: false,
      document: { data: { mappings: { robot: "B2" } } },
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
    expect(pending[0].event.details.datasetPath).toBe(
      "/home/xense/datasets/TacVerse/example",
    );
    expect(pending[0].event.details.stdout).toEqual([
      "first line",
      "token=[REDACTED]",
    ]);
    expect(pending[0].event.details.report).toEqual({
      checks: [{ id: "schema", passed: true }],
    });
    expect(pending[0].event.details).not.toHaveProperty("hfToken");
    expect(pending[0].event.details).not.toHaveProperty("password");

    await markWorkbenchSharedEventsSent(pending, root);
    await expect(listPendingWorkbenchSharedEvents(root)).resolves.toEqual([]);
  });

  test("uses organization-scoped config paths", () => {
    expect(workbenchSharedConfigPath("TacVerse", "reward-rules")).toBe(
      "configs/TacVerse/reward-rules.json",
    );
    expect(() =>
      workbenchSharedConfigPath("../TacVerse", "reward-rules"),
    ).toThrow("organization is invalid");
  });
});

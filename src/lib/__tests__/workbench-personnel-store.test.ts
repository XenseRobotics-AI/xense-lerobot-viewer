import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readWorkbenchPersonnelConfig,
  writeWorkbenchPersonnelConfig,
} from "@/lib/workbench-personnel-store";

const temporaryRoots: string[] = [];

async function configPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-personnel-"));
  temporaryRoots.push(root);
  return path.join(root, "config", "personnel.json");
}

function validConfig() {
  return {
    people: [
      { id: "zhang-san", displayName: "张三", email: "zhang@example.com" },
      { id: "li-si", displayName: "李四", email: "" },
    ],
    schedules: {
      "2026-09-03": [
        {
          workstation: "A1",
          members: [{ personId: "zhang-san", creditFactor: 1 }],
        },
      ],
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

describe("workbench personnel store", () => {
  test("keeps organizations isolated and atomically rewrites one config file", async () => {
    const filePath = await configPath();
    await writeWorkbenchPersonnelConfig("TacVerse", validConfig(), filePath);
    await writeWorkbenchPersonnelConfig(
      "OtherOrg",
      {
        people: [{ id: "wang-wu", displayName: "王五", email: "" }],
        schedules: { "2026-09-03": [] },
      },
      filePath,
    );

    const tacverse = await readWorkbenchPersonnelConfig("TacVerse", filePath);
    const other = await readWorkbenchPersonnelConfig("OtherOrg", filePath);
    expect(tacverse.people.map((person) => person.displayName)).toEqual([
      "张三",
      "李四",
    ]);
    expect(other.people.map((person) => person.displayName)).toEqual(["王五"]);
    expect(tacverse.updatedAt).toBeString();
    expect(
      (await fs.readdir(path.dirname(filePath))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  test.each([
    [
      "invalid calendar dates",
      () => ({ ...validConfig(), schedules: { "2026-02-30": [] } }),
      "Invalid personnel mapping date",
    ],
    [
      "invalid email addresses",
      () => ({
        ...validConfig(),
        people: [{ id: "zhang-san", displayName: "张三", email: "invalid@" }],
      }),
      "Email for 张三 is invalid",
    ],
    [
      "duplicate personnel IDs",
      () => ({
        ...validConfig(),
        people: [
          { id: "same", displayName: "甲", email: "" },
          { id: "same", displayName: "乙", email: "" },
        ],
        schedules: {},
      }),
      "Duplicate personnel ID",
    ],
    [
      "duplicate display names",
      () => ({
        ...validConfig(),
        people: [
          { id: "one", displayName: "同名", email: "" },
          { id: "two", displayName: "同名", email: "" },
        ],
        schedules: {},
      }),
      "Duplicate personnel display name",
    ],
    [
      "duplicate workstations on one day",
      () => ({
        ...validConfig(),
        schedules: {
          "2026-09-03": [
            {
              workstation: "A1",
              members: [{ personId: "zhang-san", creditFactor: 1 }],
            },
            {
              workstation: "A1",
              members: [{ personId: "li-si", creditFactor: 1 }],
            },
          ],
        },
      }),
      "duplicate workstation",
    ],
    [
      "unknown personnel references",
      () => ({
        ...validConfig(),
        schedules: {
          "2026-09-03": [
            {
              workstation: "A1",
              members: [{ personId: "missing", creditFactor: 1 }],
            },
          ],
        },
      }),
      "unknown personnel ID",
    ],
    [
      "non-unit credit factors",
      () => ({
        ...validConfig(),
        schedules: {
          "2026-09-03": [
            {
              workstation: "A1",
              members: [{ personId: "zhang-san", creditFactor: 0.5 }],
            },
          ],
        },
      }),
      "creditFactor must be 1",
    ],
  ])("rejects %s", async (_label, createInput, expectedMessage) => {
    const filePath = await configPath();
    await expect(
      writeWorkbenchPersonnelConfig("TacVerse", createInput(), filePath),
    ).rejects.toThrow(expectedMessage);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports a clear error when the repository config is not writable", async () => {
    const filePath = await configPath();
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    await fs.chmod(directory, 0o555);
    try {
      await expect(
        writeWorkbenchPersonnelConfig("TacVerse", validConfig(), filePath),
      ).rejects.toThrow("Personnel configuration is not writable");
    } finally {
      await fs.chmod(directory, 0o755);
    }
  });
});

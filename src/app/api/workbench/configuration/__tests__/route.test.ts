import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/workbench/configuration/route";
import { workbenchConfigurationPath } from "@/lib/workbench-configuration-store";
import type {
  WorkbenchConfigurationResponse,
  WorkbenchConfigurationV2,
} from "@/types/workbench-configuration.types";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;

beforeEach(async () => {
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "workbench-configuration-api-"),
  );
  process.env.LOCAL_DATASET_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function request(
  config: WorkbenchConfigurationV2,
  revision: string | null,
  extraHeaders: HeadersInit = {},
): NextRequest {
  const headers = new Headers({
    "content-type": "application/json",
    ...extraHeaders,
  });
  if (revision) headers.set("if-match", revision);
  return new NextRequest(
    "http://localhost/api/workbench/configuration?org=OtherOrg",
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ config }),
    },
  );
}

describe("Workbench configuration route", () => {
  test("migrates in memory, requires a revision, atomically saves, and rejects stale drafts", async () => {
    const first = await GET(
      new Request("http://localhost/api/workbench/configuration?org=OtherOrg"),
    );
    const loaded = (await first.json()) as WorkbenchConfigurationResponse;
    expect(first.status).toBe(200);
    expect(loaded.source).toBe("migrated");
    await expect(
      fs.stat(workbenchConfigurationPath("OtherOrg", root)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const missingRevision = await PUT(request(loaded.config, null));
    expect(missingRevision.status).toBe(428);

    loaded.config.workstations.push({
      id: "A1",
      name: "A1",
      enabled: true,
    });
    loaded.config.devices.push({
      id: "robot-1",
      type: "umi_gripper",
      source: "robot_id",
      identifier: "bi_taccap_8",
      workstationId: "A1",
    });
    const savedResponse = await PUT(request(loaded.config, loaded.revision));
    const saved =
      (await savedResponse.json()) as WorkbenchConfigurationResponse;
    expect(savedResponse.status).toBe(200);
    expect(saved.source).toBe("stored");
    expect(saved.revision).not.toBe(loaded.revision);
    await expect(
      fs.readFile(workbenchConfigurationPath("OtherOrg", root), "utf8"),
    ).resolves.toContain('"schema": "xense.workbench.configuration/2"');
    expect(
      (
        await fs.readdir(
          path.dirname(workbenchConfigurationPath("OtherOrg", root)),
        )
      ).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

    const stale = await PUT(request(loaded.config, loaded.revision));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "WORKBENCH_CONFIGURATION_CONFLICT",
      actualRevision: saved.revision,
    });

    const removed = {
      ...saved.config,
      workstations: [],
      devices: [],
    };
    const referencedRemoval = await PUT(request(removed, saved.revision));
    expect(referencedRemoval.status).toBe(200);
    await expect(referencedRemoval.json()).resolves.toMatchObject({
      config: { workstations: [], devices: [] },
    });
  });

  test("rejects cross-origin writes and invalid device source/type pairs", async () => {
    const loaded = (await (
      await GET(
        new Request(
          "http://localhost/api/workbench/configuration?org=OtherOrg",
        ),
      )
    ).json()) as WorkbenchConfigurationResponse;
    const crossOrigin = await PUT(
      request(loaded.config, loaded.revision, {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      }),
    );
    expect(crossOrigin.status).toBe(403);

    loaded.config.workstations.push({ id: "A1", name: "A1", enabled: true });
    loaded.config.devices.push({
      id: "bad",
      type: "umi_gripper",
      source: "collector_sn",
      identifier: "bad-device",
      workstationId: "A1",
    });
    const invalid = await PUT(request(loaded.config, loaded.revision));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "WORKBENCH_CONFIGURATION_INVALID",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "DEVICE_SOURCE_MISMATCH" }),
      ]),
    });
  });
});

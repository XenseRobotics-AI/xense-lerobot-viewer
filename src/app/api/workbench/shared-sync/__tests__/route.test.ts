import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/workbench/shared-sync/route";
import * as hub from "@/lib/workbench-shared-hub";
import * as credentials from "@/lib/hf-token-store";
import {
  readWorkbenchConfiguration,
  writeWorkbenchConfiguration,
} from "@/lib/workbench-configuration-store";
import {
  readLocalWorkbenchSharedConfigs,
  readWorkbenchSharedSyncBaseline,
  writeWorkbenchSharedSyncBaseline,
  workbenchSharedConfigPath,
  type WorkbenchSharedConfigDocument,
  type WorkbenchSharedConfigKind,
} from "@/lib/workbench-shared-sync";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
let remote: Record<WorkbenchSharedConfigKind, WorkbenchSharedConfigDocument>;
let commits: hub.WorkbenchSharedHubCommitRequest[];
let beforeCommit: (() => Promise<void>) | undefined;
let writable = true;
let hubSpy: ReturnType<typeof spyOn<typeof hub, "runWorkbenchSharedHub">>;
let tokenSpy: ReturnType<typeof spyOn<typeof credentials, "resolveHfToken">>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-sync-api-"));
  process.env.LOCAL_DATASET_ROOT = root;
  commits = [];
  beforeCommit = undefined;
  writable = true;
  const initial = await readWorkbenchConfiguration("OtherOrg", root);
  await writeWorkbenchConfiguration(
    "OtherOrg",
    {
      ...initial.config,
      workstations: [{ id: "station", name: "Original", enabled: true }],
      devices: [
        {
          id: "device",
          type: "umi_gripper",
          source: "robot_id",
          identifier: "robot-1",
          workstationId: "station",
        },
      ],
    },
    initial.revision,
    root,
  );
  remote = await readLocalWorkbenchSharedConfigs("OtherOrg", root);
  await writeWorkbenchSharedSyncBaseline("OtherOrg", remote, root);
  tokenSpy = spyOn(credentials, "resolveHfToken").mockImplementation(
    async () => ({
      token: writable ? "test-token" : null,
      source: writable ? "viewer" : "none",
    }),
  );
  hubSpy = spyOn(hub, "runWorkbenchSharedHub").mockImplementation(
    async (request) => {
      if (request.action === "read")
        return {
          action: "read",
          head: "head",
          username: "test",
          files: Object.fromEntries(
            Object.entries(remote).map(([kind, document]) => [
              workbenchSharedConfigPath(
                "OtherOrg",
                kind as WorkbenchSharedConfigKind,
              ),
              structuredClone(document),
            ]),
          ),
        };
      commits.push(request);
      await beforeCommit?.();
      for (const file of request.files) {
        const document = JSON.parse(
          file.content,
        ) as WorkbenchSharedConfigDocument;
        remote[document.kind] = document;
      }
      return {
        action: "commit",
        commit: "next",
        commitUrl: null,
        username: "test",
      };
    },
  );
});

afterEach(async () => {
  hubSpy.mockRestore();
  tokenSpy.mockRestore();
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function request(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/workbench/shared-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: "OtherOrg", ...extra }),
  });
}

async function renameLocal(name: string) {
  const current = await readWorkbenchConfiguration("OtherOrg", root);
  current.config.workstations[0].name = name;
  await writeWorkbenchConfiguration(
    "OtherOrg",
    current.config,
    current.revision,
    root,
  );
}

function renameRemote(name: string) {
  (remote.configuration.data.workstations as Array<{ name: string }>)[0].name =
    name;
}

describe("Workbench shared merge API", () => {
  test("publishes independent edits and stores the merged baseline", async () => {
    await renameLocal("Local");
    (
      remote.configuration.data.workstations as Array<{ enabled: boolean }>
    )[0].enabled = false;
    expect((await POST(request())).status).toBe(200);
    expect(commits).toHaveLength(1);
    const local = await readLocalWorkbenchSharedConfigs("OtherOrg", root);
    expect(local.configuration.data.workstations).toEqual([
      { id: "station", name: "Local", enabled: false },
    ]);
    expect(await readWorkbenchSharedSyncBaseline("OtherOrg", root)).toEqual(
      remote,
    );
    expect(local).toEqual(remote);
  });

  test("preserves both sides on conflict and rejects stale choices", async () => {
    await renameLocal("Local");
    renameRemote("Remote");
    const before = await readLocalWorkbenchSharedConfigs("OtherOrg", root);
    const baseline = await readWorkbenchSharedSyncBaseline("OtherOrg", root);
    const response = await POST(request());
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.conflicts[0].paths).toEqual([
      'workstations["station"].name',
    ]);
    expect(await readLocalWorkbenchSharedConfigs("OtherOrg", root)).toEqual(
      before,
    );
    expect(await readWorkbenchSharedSyncBaseline("OtherOrg", root)).toEqual(
      baseline,
    );
    expect(commits).toHaveLength(0);
    renameRemote("Changed again");
    expect(
      (
        await POST(
          request({ conflictPreference: "local", reviewed: payload.reviewed }),
        )
      ).status,
    ).toBe(409);
    const latest = await (await POST(request())).json();
    expect(
      (
        await POST(
          request({ conflictPreference: "remote", reviewed: latest.reviewed }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await readWorkbenchConfiguration("OtherOrg", root)).config
        .workstations[0].name,
    ).toBe("Changed again");
  });

  test("keeps local edits and baselines unchanged when publishing fails", async () => {
    await renameLocal("Local");
    const before = await readLocalWorkbenchSharedConfigs("OtherOrg", root);
    const baseline = await readWorkbenchSharedSyncBaseline("OtherOrg", root);
    beforeCommit = async () => {
      throw new Error("offline");
    };
    expect((await POST(request())).status).toBe(502);
    expect(await readLocalWorkbenchSharedConfigs("OtherOrg", root)).toEqual(
      before,
    );
    expect(await readWorkbenchSharedSyncBaseline("OtherOrg", root)).toEqual(
      baseline,
    );
  });

  test("re-reads remote changes after an optimistic commit conflict", async () => {
    await renameLocal("Local");
    beforeCommit = async () => {
      beforeCommit = undefined;
      (
        remote.configuration.data.workstations as Array<{ enabled: boolean }>
      )[0].enabled = false;
      throw new hub.WorkbenchSharedHubConflictError("head changed");
    };
    expect((await POST(request())).status).toBe(200);
    expect(commits).toHaveLength(2);
    expect(
      (await readWorkbenchConfiguration("OtherOrg", root)).config
        .workstations[0],
    ).toEqual({ id: "station", name: "Local", enabled: false });
  });

  test("preserves edits made during publishing and the previous merge baseline", async () => {
    await renameLocal("Local");
    (
      remote.configuration.data.workstations as Array<{ enabled: boolean }>
    )[0].enabled = false;
    const baseline = await readWorkbenchSharedSyncBaseline("OtherOrg", root);
    beforeCommit = async () => {
      await renameLocal("New local");
      beforeCommit = undefined;
    };
    expect((await POST(request())).status).toBe(200);
    expect(
      (await readWorkbenchConfiguration("OtherOrg", root)).config
        .workstations[0].name,
    ).toBe("New local");
    expect(await readWorkbenchSharedSyncBaseline("OtherOrg", root)).toEqual(
      baseline,
    );
    // Both sides now changed the name, so it is reviewed rather than overwritten.
    expect((await POST(request())).status).toBe(409);
  });

  test("read-only merges retain local pending edits against the remote snapshot", async () => {
    writable = false;
    await renameLocal("Local");
    (
      remote.configuration.data.workstations as Array<{ enabled: boolean }>
    )[0].enabled = false;
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).pendingConfigs).toBe(1);
    expect(commits).toHaveLength(0);
    expect(await readWorkbenchSharedSyncBaseline("OtherOrg", root)).toEqual(
      remote,
    );
    expect(
      (await readWorkbenchConfiguration("OtherOrg", root)).config
        .workstations[0],
    ).toEqual({ id: "station", name: "Local", enabled: false });
    writable = true;
    expect((await POST(request())).status).toBe(200);
    expect(commits).toHaveLength(1);
  });
});

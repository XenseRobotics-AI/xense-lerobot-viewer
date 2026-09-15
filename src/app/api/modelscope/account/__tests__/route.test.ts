import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "@/app/api/modelscope/account/route";
import { modelScopeTokenStorePath } from "@/lib/modelscope-token-store";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousToken = process.env.MODELSCOPE_API_TOKEN;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "modelscope-account-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  delete process.env.MODELSCOPE_API_TOKEN;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousToken === undefined) delete process.env.MODELSCOPE_API_TOKEN;
  else process.env.MODELSCOPE_API_TOKEN = previousToken;
  await fs.rm(root, { recursive: true, force: true });
});

describe("ModelScope account route", () => {
  test("saves local credentials without returning the token", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/modelscope/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org: "TacVerse", token: "ms_local_secret" }),
      }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      org: "TacVerse",
      tokenPresent: true,
      source: "viewer",
      saved: true,
    });
    expect("token" in payload).toBe(false);
    expect(await fs.readFile(modelScopeTokenStorePath(root), "utf8")).toBe(
      "ms_local_secret\n",
    );
  });

  test("prefers the local credential and falls back to the environment", async () => {
    process.env.MODELSCOPE_API_TOKEN = "ms_environment";
    await fs.mkdir(path.dirname(modelScopeTokenStorePath(root)), {
      recursive: true,
    });
    await fs.writeFile(modelScopeTokenStorePath(root), "ms_local\n");

    const local = await GET(
      new NextRequest("http://localhost/api/modelscope/account?org=TacVerse"),
    );
    expect(await local.json()).toMatchObject({
      tokenPresent: true,
      source: "viewer",
    });

    const cleared = await DELETE(
      new NextRequest("http://localhost/api/modelscope/account?org=TacVerse", {
        method: "DELETE",
      }),
    );
    expect(await cleared.json()).toMatchObject({
      tokenPresent: true,
      source: "environment",
      cleared: true,
    });
  });

  test("rejects cross-origin writes and invalid tokens", async () => {
    const crossOrigin = await POST(
      new NextRequest("http://localhost/api/modelscope/account", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: "ms_should_not_be_saved" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const invalid = await POST(
      new NextRequest("http://localhost/api/modelscope/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: " " }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("INVALID_TOKEN");
  });
});

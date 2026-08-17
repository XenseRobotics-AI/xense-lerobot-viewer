import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DELETE, GET, POST, PUT } from "@/app/api/hf/account/route";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousToken = process.env.HF_TOKEN;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-hf-account-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  // Keep the route test independent of a developer's shell credential.
  delete process.env.HF_TOKEN;
});

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = previousToken;
  await fs.rm(root, { recursive: true, force: true });
});

describe("HF account route", () => {
  test("GET reports local credential metadata without returning a token", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/hf/account?org=TacVerse"),
    );
    const payload = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.org).toBe("TacVerse");
    expect("token" in payload).toBe(false);
    expect("HF_TOKEN" in payload).toBe(false);
  });

  test("mutating requests reject another Origin before doing work", async () => {
    const request = new NextRequest("http://localhost/api/hf/account", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "hf_should_not_be_used" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("ORIGIN_REJECTED");
  });

  test("PUT requires an explicitly supplied token", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/hf/account", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_TOKEN");
  });

  test("DELETE is local-only and reports the cleared state", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/hf/account", { method: "DELETE" }),
    );
    const payload = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(payload.cleared).toBe(true);
    expect("token" in payload).toBe(false);
  });
});

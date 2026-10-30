import { beforeEach, afterEach, describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "viewer-doctor-route-"));
  await fs.mkdir(path.join(root, "meta"));
  await fs.writeFile(
    path.join(root, "meta", "info.json"),
    JSON.stringify({
      codebase_version: "v3.0",
      fps: 30,
      total_episodes: 0,
      total_frames: 0,
      total_tasks: 0,
      features: {},
    }),
  );
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));
const context = () => ({
  params: Promise.resolve({ encodedPath: encodeLocalDatasetPath(root) }),
});
const request = (
  stream = false,
  signal?: AbortSignal,
  body = JSON.stringify({ checks: ["metadata"] }),
) =>
  new NextRequest("http://localhost/api/doctor" + (stream ? "?stream=1" : ""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });

describe("Doctor response lifecycle", () => {
  test("pre-aborted requests do not start streaming or JSON work", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const stream of [false, true]) {
      const response = await POST(
        request(stream, controller.signal),
        context(),
      );
      expect(response.status).toBe(499);
      expect(response.body).toBeNull();
    }
  });
  test("cancellation during parameter lookup stops before filesystem work", async () => {
    const controller = new AbortController();
    let resolve!: (value: { encodedPath: string }) => void;
    const params = new Promise<{ encodedPath: string }>((done) => {
      resolve = done;
    });
    const pending = POST(request(true, controller.signal), { params });
    controller.abort();
    resolve(await context().params);
    expect((await pending).status).toBe(499);
  });
  test("streamed results finish and a subsequent request uses the cache", async () => {
    const response = await POST(request(true), context());
    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "progress")).toBe(true);
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    const cached = await POST(request(), context());
    expect((await cached.json()).execution.cache_hit).toBe(true);
  });
  test("a disconnected stream publishes no result or cancelled cache entry", async () => {
    const controller = new AbortController();
    const response = await POST(request(true, controller.signal), context());
    controller.abort();
    expect(await response.text()).not.toContain('"type":"result"');
    const next = await POST(request(), context());
    expect(next.status).toBe(200);
    expect((await next.json()).execution.cache_hit).toBe(false);
  });
  test("validation errors retain their HTTP boundaries", async () => {
    expect(
      (await POST(request(false, undefined, "bad JSON"), context())).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(false, undefined, JSON.stringify({ checks: ["missing"] })),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(request(), {
          params: Promise.resolve({
            encodedPath: encodeLocalDatasetPath(path.join(root, "missing")),
          }),
        })
      ).status,
    ).toBe(404);
  });
});

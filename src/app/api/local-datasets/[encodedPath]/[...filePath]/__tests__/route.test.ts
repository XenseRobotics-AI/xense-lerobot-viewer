import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, HEAD } from "../route";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";

let root: string;
const bytes = Buffer.from("0123456789");
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "viewer-stream-"));
  await fs.writeFile(path.join(root, "video.mp4"), bytes);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const context = (filePath = ["video.mp4"]) => ({
  params: Promise.resolve({
    encodedPath: encodeLocalDatasetPath(root),
    filePath,
  }),
});
const request = (range?: string, signal?: AbortSignal) =>
  new NextRequest("http://localhost/api/file", {
    headers: range ? { range } : {},
    signal,
  });

describe("local dataset file streaming", () => {
  test("streams a complete response with correct size and media type", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  test("streams explicit, suffix, open-ended and clamped byte ranges", async () => {
    for (const [range, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=8-9999", "89", "bytes 8-9/10"],
    ]) {
      const response = await GET(request(range), context());
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(
        String(expected.length),
      );
      expect(await response.text()).toBe(expected);
    }
  });
  test("caps open-ended requests so preview reads stay bounded", async () => {
    await fs.writeFile(
      path.join(root, "video.mp4"),
      Buffer.alloc(3 * 1024 * 1024, 7),
    );
    const response = await GET(request("bytes=0-"), context());
    expect(response.headers.get("content-length")).toBe(
      String(2 * 1024 * 1024),
    );
    expect((await response.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
  });
  test("rejects invalid and unsatisfiable ranges", async () => {
    for (const range of [
      "bytes=99-",
      "bytes=5-2",
      "bytes=-0",
      "bytes=-",
      "bytes=0-2,5-9",
    ]) {
      const response = await GET(request(range), context());
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
  });
  test("HEAD returns metadata and missing paths stay 404", async () => {
    const response = await HEAD(request(), context());
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("10");
    expect((await GET(request(), context(["missing.mp4"]))).status).toBe(404);
  });
  test("aborting a request terminates the pending file read", async () => {
    const controller = new AbortController();
    const response = await GET(
      request(undefined, controller.signal),
      context(),
    );
    controller.abort();
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
  test("pre-aborted full, range and HEAD requests return no body", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const handler of [GET, HEAD]) {
      for (const range of [undefined, "bytes=0-3"]) {
        const response = await handler(
          request(range, controller.signal),
          context(),
        );
        expect(response.status).toBe(499);
        expect(response.body).toBeNull();
      }
    }
  });
  test("cancellation while resolving parameters does not open a file", async () => {
    for (const handler of [GET, HEAD]) {
      for (const range of [undefined, "bytes=0-3"]) {
        const controller = new AbortController();
        let resolve!: (
          value: Awaited<ReturnType<typeof context>["params"]>,
        ) => void;
        const params = new Promise<
          Awaited<ReturnType<typeof context>["params"]>
        >((done) => {
          resolve = done;
        });
        const pending = handler(request(range, controller.signal), { params });
        controller.abort();
        resolve(await context().params);
        const response = await pending;
        expect(response.status).toBe(499);
        expect(response.body).toBeNull();
      }
    }
  });
  test("empty files have a valid full response and reject all byte ranges", async () => {
    await fs.writeFile(path.join(root, "video.mp4"), "");
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    for (const range of ["bytes=-1", "bytes=0-", "bytes=0-0"]) {
      const partial = await GET(request(range), context());
      expect(partial.status).toBe(416);
      expect(partial.headers.get("content-range")).toBe("bytes */0");
    }
  });
  test("a reader can cancel either response without aborting its request", async () => {
    for (const range of [undefined, "bytes=0-3"]) {
      const response = await GET(request(range), context());
      await response.body!.cancel("Page changed");
      expect(response.body!.locked).toBe(false);
    }
  });
});

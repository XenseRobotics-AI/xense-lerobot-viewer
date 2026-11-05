import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import { GET } from "../route";

// A 5 MB "video" with a recognisable byte at each offset (offset % 251), so a range's content can be checked.
const SIZE = 5 * 1024 * 1024;
let dir: string;
let encoded: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-route-"));
  const video = path.join(dir, "videos", "cam", "chunk-000");
  await fs.mkdir(video, { recursive: true });
  const bytes = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i % 251;
  await fs.writeFile(path.join(video, "file-000.mp4"), bytes);
  encoded = encodeLocalDatasetPath(dir);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const FILE = ["videos", "cam", "chunk-000", "file-000.mp4"];

function call(range?: string) {
  const req = new NextRequest("http://localhost/x", {
    headers: range ? { range } : {},
  });
  return GET(req, {
    params: Promise.resolve({ encodedPath: encoded, filePath: FILE }),
  });
}

function expectPattern(body: Uint8Array, start: number) {
  for (const i of [0, 1, body.length - 1])
    expect(body[i]).toBe((start + i) % 251);
}

describe("local file route (streamed)", () => {
  it("streams the whole file without a Range header", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(SIZE);
    expectPattern(body, 0);
  });

  it("serves an explicit inclusive range", async () => {
    const res = await call("bytes=1000-4999");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 1000-4999/${SIZE}`);
    expect(res.headers.get("content-length")).toBe("4000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(4000);
    expectPattern(body, 1000);
  });

  it("caps an open-ended range at the 2 MB chunk browsers ask for while playing", async () => {
    const res = await call("bytes=0-");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes 0-${2 * 1024 * 1024 - 1}/${SIZE}`,
    );
    expect((await res.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
  });

  it("serves a suffix range from the end of the file", async () => {
    const res = await call("bytes=-10");
    expect(res.headers.get("content-range")).toBe(
      `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`,
    );
    expectPattern(new Uint8Array(await res.arrayBuffer()), SIZE - 10);
  });

  it("rejects a range past the end with 416", async () => {
    const res = await call(`bytes=${SIZE}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${SIZE}`);
  });

  it("closes the file when the client cancels mid-stream", async () => {
    const target = path.join(dir, ...FILE);
    const openOnTarget = async () => {
      let n = 0;
      for (const fd of await fs.readdir("/proc/self/fd").catch(() => [])) {
        const link = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => "");
        if (link === target) n += 1;
      }
      return n;
    };
    const res = await call();
    const reader = res.body!.getReader();
    await reader.read();
    expect(await openOnTarget()).toBe(1);
    await reader.cancel();
    for (let i = 0; i < 50 && (await openOnTarget()) > 0; i++)
      await Bun.sleep(10);
    expect(await openOnTarget()).toBe(0);
  });

  it("404s a file outside the dataset", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({
        encodedPath: encoded,
        filePath: ["..", "..", "etc", "passwd"],
      }),
    });
    expect(res.status).toBe(404);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  GET,
  HEAD,
} from "@/app/api/local-datasets/[encodedPath]/[...filePath]/route";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import { getFastStartLayout } from "../mp4-faststart";

function box(type: string, ...payload: Buffer[]) {
  const data = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, data]);
}
const prefix = box("ftyp", Buffer.from("isom0000isom"));
const payload = Buffer.from(Array.from({ length: 251 }, (_, i) => i));
function index(offsets: bigint[], wide = false) {
  const entries = Buffer.alloc(8 + offsets.length * (wide ? 8 : 4));
  entries.writeUInt32BE(offsets.length, 4);
  offsets.forEach((offset, i) =>
    wide
      ? entries.writeBigUInt64BE(offset, 8 + i * 8)
      : entries.writeUInt32BE(Number(offset), 8 + i * 4),
  );
  return box(
    "moov",
    box(
      "trak",
      box(
        "mdia",
        box("minf", box("stbl", box(wide ? "co64" : "stco", entries))),
      ),
    ),
  );
}
const offsets = [BigInt(prefix.length + 8), BigInt(prefix.length + 8 + 100)];
const originalIndex = index(offsets);
const raw = Buffer.concat([prefix, box("mdat", payload), originalIndex]);
const optimized = Buffer.concat([
  prefix,
  index(offsets.map((offset) => offset + BigInt(originalIndex.length))),
  box("mdat", payload),
]);
let root: string;
let target: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mp4-faststart-"));
  target = path.join(root, "camera.mp4");
  await fs.writeFile(target, raw);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function stat() {
  const info = await fs.stat(target);
  return { absolutePath: target, size: info.size, mtimeMs: info.mtimeMs };
}
function request(range?: string, signal?: AbortSignal, playback = true) {
  const req = new NextRequest(
    `http://localhost/api/file${playback ? "?playback=1" : ""}`,
    {
      headers: range ? { range } : {},
      signal,
    },
  );
  return {
    req,
    ctx: {
      params: Promise.resolve({
        encodedPath: encodeLocalDatasetPath(root),
        filePath: ["camera.mp4"],
      }),
    },
  };
}
async function get(range?: string, signal?: AbortSignal, playback = true) {
  const { req, ctx } = request(range, signal, playback);
  return GET(req, ctx);
}

describe("MP4 playback faststart", () => {
  test("moves only the index and preserves every media byte, duration metadata and raw downloads", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(raw.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(optimized);
    expect(
      Buffer.from(await (await get(undefined, undefined, false)).arrayBuffer()),
    ).toEqual(raw);
    expect(await fs.readFile(target)).toEqual(raw);
    const { req, ctx } = request();
    const head = await HEAD(req, ctx);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe(String(raw.length));
  });
  test("serves ranges within and across all virtual spans, including suffix and open ranges", async () => {
    const boundaries = [
      0,
      prefix.length - 1,
      prefix.length,
      prefix.length + originalIndex.length - 1,
      prefix.length + originalIndex.length,
      raw.length - 1,
    ];
    for (const start of boundaries) {
      for (const end of boundaries.filter((value) => value >= start)) {
        const response = await get(`bytes=${start}-${end}`);
        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe(
          `bytes ${start}-${end}/${raw.length}`,
        );
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          optimized.subarray(start, end + 1),
        );
      }
    }
    expect(Buffer.from(await (await get("bytes=-17")).arrayBuffer())).toEqual(
      optimized.subarray(-17),
    );
    expect(Buffer.from(await (await get("bytes=1-")).arrayBuffer())).toEqual(
      optimized.subarray(1),
    );
    expect((await get(`bytes=${raw.length}-`)).status).toBe(416);
  });
  test("shares an index for the same version and invalidates it after a file replacement", async () => {
    const before = await stat();
    const layouts = await Promise.all(
      Array.from({ length: 8 }, () => getFastStartLayout(before)),
    );
    expect(layouts[0]).not.toBeNull();
    expect(layouts.every((layout) => layout === layouts[0])).toBe(true);
    await fs.writeFile(target, optimized);
    await fs.utimes(target, new Date(), new Date(before.mtimeMs + 2000));
    expect(await getFastStartLayout(await stat())).toBeNull();
    expect(Buffer.from(await (await get()).arrayBuffer())).toEqual(optimized);
  });

  test("an I/O failure never caches a conflicting raw playback representation", async () => {
    const info = await stat();
    await fs.unlink(target);
    await expect(getFastStartLayout(info)).rejects.toThrow();
    await fs.writeFile(target, raw);
    expect(await getFastStartLayout(await stat())).not.toBeNull();
  });

  test("oversized and auxiliary-offset indexes fall back to the unchanged file", async () => {
    for (const metadata of [
      box("moov", box("free", Buffer.alloc(4 * 1024 * 1024))),
      box(
        "moov",
        box("trak", box("mdia", box("minf", box("stbl", box("saio"))))),
      ),
    ]) {
      await fs.writeFile(
        target,
        Buffer.concat([prefix, box("mdat", payload), metadata]),
      );
      expect(await getFastStartLayout(await stat())).toBeNull();
      const response = await get("bytes=0-19");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(prefix);
    }
  });
  test("bounds initial playback reads while retaining larger sequential reads and explicit ranges", async () => {
    await fs.writeFile(
      target,
      Buffer.concat([
        prefix,
        box("mdat", Buffer.alloc(3 * 1024 * 1024)),
        originalIndex,
      ]),
    );
    const initial = await get("bytes=0-");
    expect(initial.headers.get("content-length")).toBe(String(256 * 1024));
    expect((await initial.arrayBuffer()).byteLength).toBe(256 * 1024);
    const next = await get("bytes=262144-");
    expect(next.headers.get("content-length")).toBe(String(2 * 1024 * 1024));
    await next.body!.cancel();
    const explicit = await get("bytes=0-524287");
    expect(explicit.headers.get("content-length")).toBe(String(512 * 1024));
    await explicit.body!.cancel();
  });
  test("leaves malformed, fragmented, external-chunk and unsupported files untouched", async () => {
    for (const bytes of [
      Buffer.from("not an mp4"),
      optimized,
      Buffer.concat([prefix, box("mdat", payload), box("moov", box("mvex"))]),
      Buffer.concat([
        prefix,
        box("mdat", payload),
        box("mdat", payload),
        originalIndex,
      ]),
      Buffer.concat([prefix, box("mdat", payload), index([0n])]),
      Buffer.concat([prefix, box("mdat", payload), box("moov", box("cmov"))]),
      Buffer.concat([
        prefix,
        box("mdat", payload),
        box("moov", Buffer.from("truncated")),
      ]),
      Buffer.concat([prefix, box("mdat", payload), box("uuid"), originalIndex]),
    ]) {
      await fs.writeFile(target, bytes);
      await fs.utimes(
        target,
        new Date(),
        new Date(Date.now() + bytes.length * 1000),
      );
      expect(await getFastStartLayout(await stat())).toBeNull();
      expect(Buffer.from(await (await get()).arrayBuffer())).toEqual(bytes);
    }
  });
  test("handles 64-bit chunk offsets in sparse large shards without reading the media", async () => {
    const mediaSize = 0x100000100;
    const mediaHeader = Buffer.alloc(16);
    mediaHeader.writeUInt32BE(1);
    mediaHeader.write("mdat", 4);
    mediaHeader.writeBigUInt64BE(BigInt(mediaSize), 8);
    const largeIndex = index([0x100000020n], true);
    const handle = await fs.open(target, "w");
    try {
      await handle.write(prefix, 0, prefix.length, 0);
      await handle.write(mediaHeader, 0, 16, prefix.length);
      await handle.write(
        largeIndex,
        0,
        largeIndex.length,
        prefix.length + mediaSize,
      );
    } finally {
      await handle.close();
    }
    const layout = await getFastStartLayout(await stat());
    expect(layout?.index).toEqual(
      index([0x100000020n + BigInt(largeIndex.length)], true),
    );
    expect(
      Buffer.from(
        await (
          await get(
            `bytes=${prefix.length}-${prefix.length + largeIndex.length - 1}`,
          )
        ).arrayBuffer(),
      ),
    ).toEqual(layout!.index);
    // The same file with an stco table cannot be safely shifted past 2^32.
    const narrow = index([0xfffffff0n]);
    const writer = await fs.open(target, "r+");
    try {
      await writer.write(narrow, 0, narrow.length, prefix.length + mediaSize);
      await writer.truncate(prefix.length + mediaSize + narrow.length);
    } finally {
      await writer.close();
    }
    expect(await getFastStartLayout(await stat())).toBeNull();
  });
  test("cancellation and abort close underlying media file descriptors", async () => {
    await fs.writeFile(
      target,
      Buffer.concat([
        prefix,
        box("mdat", Buffer.alloc(2 * 1024 * 1024)),
        originalIndex,
      ]),
    );
    const openFiles = async () =>
      (
        await Promise.all(
          (await fs.readdir("/proc/self/fd").catch(() => [])).map((fd) =>
            fs.readlink(`/proc/self/fd/${fd}`).catch(() => ""),
          ),
        )
      ).filter((link) => link === target).length;
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const response = await get(undefined, controller.signal);
      const reader = response.body!.getReader();
      // Pass the prefix and index so the media stream owns a descriptor.
      for (let i = 0; i < 3; i++) await reader.read();
      expect(await openFiles()).toBe(1);
      if (abort) {
        controller.abort();
        await expect(reader.read()).rejects.toThrow();
      } else await reader.cancel();
      for (let i = 0; i < 30 && (await openFiles()); i++) await Bun.sleep(10);
      expect(await openFiles()).toBe(0);
    }
    const controller = new AbortController();
    controller.abort();
    expect((await get(undefined, controller.signal)).status).toBe(499);
  });
});

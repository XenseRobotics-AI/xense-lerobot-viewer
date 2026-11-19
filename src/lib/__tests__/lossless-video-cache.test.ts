import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/local-datasets/[encodedPath]/[...filePath]/route";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import {
  getLosslessPlaybackFile,
  releaseLosslessPlaybackLease,
} from "../lossless-video-cache";

const codecs =
  Bun.which("ffmpeg") && Bun.which("ffprobe")
    ? Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"]).stdout.toString()
    : "";
const available = codecs.includes("libx265") && codecs.includes("libx264");
let fixtures: string;
let root: string;
let source: string;
let cache: string;
const leaseA = "a".repeat(32);
const leaseB = "b".repeat(32);
function command(args: string[]) {
  const result = Bun.spawnSync(args);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
async function input() {
  const info = await fs.stat(source);
  return { absolutePath: source, size: info.size, mtimeMs: info.mtimeMs };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Cache lifecycle did not settle");
}
const files = () => fs.readdir(cache).catch(() => [] as string[]);
function frameHashes(file: string, from = 0, duration = 1) {
  return command([
    "ffmpeg",
    "-v",
    "error",
    "-ss",
    String(from),
    "-t",
    String(duration),
    "-i",
    file,
    "-map",
    "0:v:0",
    "-f",
    "framemd5",
    "-",
  ])
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim());
}

describe.skipIf(!available)("lossless playback cache", () => {
  beforeAll(async () => {
    fixtures = await fs.mkdtemp(path.join(os.tmpdir(), "lossless-fixtures-"));
    for (const [codec, name, options] of [
      [
        "libx265",
        "hevc.mp4",
        ["-x265-params", "pools=1:frame-threads=1:bframes=0:log-level=error"],
      ],
      ["libx264", "h264.mp4", []],
    ] as const) {
      command([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=96x64:rate=10:duration=4",
        "-c:v",
        codec,
        "-threads",
        "1",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-color_range",
        "pc",
        ...options,
        "-y",
        path.join(fixtures, name),
      ]);
    }
  });
  afterAll(async () => {
    if (fixtures) await fs.rm(fixtures, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lossless-test-"));
    source = path.join(root, "source.mp4");
    cache = path.join(root, "cache");
    await fs.copyFile(path.join(fixtures, "hevc.mp4"), source);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("preserves decoded pixels on an episode-local clock without modifying the original", async () => {
    const before = createHash("sha256")
      .update(await fs.readFile(source))
      .digest("hex");
    const result = await getLosslessPlaybackFile(
      await input(),
      { from: 1, to: 2, lease: leaseA },
      new AbortController().signal,
      cache,
    );
    expect(result.converted).toBe(true);
    expect(result.file.absolutePath).not.toBe(source);
    const original = frameHashes(source, 1);
    const decoded = frameHashes(result.file.absolutePath);
    expect(decoded).toHaveLength(10);
    expect(decoded).toEqual(original);
    const probe = JSON.parse(
      command([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,start_time,width,height",
        "-of",
        "json",
        result.file.absolutePath,
      ]),
    ).streams[0];
    expect(probe.codec_name).toBe("h264");
    expect(Number(probe.start_time)).toBeCloseTo(0, 3);
    expect([probe.width, probe.height]).toEqual([96, 64]);
    expect(
      createHash("sha256")
        .update(await fs.readFile(source))
        .digest("hex"),
    ).toBe(before);
  });
  test("shares encoding between clients and releases only the requested lease", async () => {
    const file = await input();
    const [a, b] = await Promise.all(
      [leaseA, leaseB].map((lease) =>
        getLosslessPlaybackFile(
          file,
          { from: 0, to: 2, lease },
          new AbortController().signal,
          cache,
        ),
      ),
    );
    expect(a.file.absolutePath).toBe(b.file.absolutePath);
    expect(
      (await files()).filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name)),
    ).toHaveLength(1);
    expect(
      await fs.stat(path.join(cache, `${a.cacheKey}.lease-${leaseA}`)),
    ).toBeDefined();
    await releaseLosslessPlaybackLease(a.cacheKey!, leaseA, cache);
    expect((await files()).includes(`${a.cacheKey}.lease-${leaseA}`)).toBe(
      false,
    );
    expect((await files()).includes(`${a.cacheKey}.lease-${leaseB}`)).toBe(
      true,
    );
    expect((await fs.stat(a.file.absolutePath)).size).toBeGreaterThan(0);
  });
  test("matching browser display colour changes only colour metadata, not decoded samples", async () => {
    const result = await getLosslessPlaybackFile(
      await input(),
      {
        from: 0,
        to: 1,
        color: {
          matrix: "bt709",
          primaries: "bt709",
          transfer: "bt709",
          fullRange: false,
        },
      },
      new AbortController().signal,
      cache,
    );
    expect(frameHashes(result.file.absolutePath)).toEqual(frameHashes(source));
    const metadata = JSON.parse(
      command([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=color_range,color_space,color_transfer,color_primaries",
        "-of",
        "json",
        result.file.absolutePath,
      ]),
    ).streams[0];
    expect(metadata).toMatchObject({
      color_range: "tv",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
    });
  });
  test("cancelling one client leaves the other client's preparation running", async () => {
    const file = await input();
    const controller = new AbortController();
    const a = getLosslessPlaybackFile(
      file,
      { from: 0, to: 4, lease: leaseA },
      controller.signal,
      cache,
    );
    const rejected = a.then(
      () => false,
      () => true,
    );
    const b = getLosslessPlaybackFile(
      file,
      { from: 0, to: 4, lease: leaseB },
      new AbortController().signal,
      cache,
    );
    await until(async () =>
      (await files()).some((name) => name.endsWith(".lock")),
    );
    controller.abort();
    expect(await rejected).toBe(true);
    const result = await b;
    expect(result.converted).toBe(true);
    expect((await files()).includes(`${result.cacheKey}.lease-${leaseB}`)).toBe(
      true,
    );
    expect((await files()).includes(`${result.cacheKey}.lease-${leaseA}`)).toBe(
      false,
    );
  });
  test("cancelling the last client removes the encoder lock and partial output", async () => {
    const controller = new AbortController();
    const pending = getLosslessPlaybackFile(
      await input(),
      { from: 0, to: 4, lease: leaseA },
      controller.signal,
      cache,
    );
    const rejected = pending.then(
      () => false,
      () => true,
    );
    await until(async () =>
      (await files()).some((name) => name.endsWith(".lock")),
    );
    controller.abort();
    expect(await rejected).toBe(true);
    await until(
      async () =>
        !(await files()).some(
          (name) => name.endsWith(".lock") || name.endsWith(".part.mp4"),
        ),
    );
    expect((await files()).some((name) => name.includes(".lease-"))).toBe(
      false,
    );
  });
  test("unchanged versions reuse a copy, while a replacement gets a new cache key", async () => {
    const first = await getLosslessPlaybackFile(
      await input(),
      { from: 0, to: 1 },
      new AbortController().signal,
      cache,
    );
    const again = await getLosslessPlaybackFile(
      await input(),
      { from: 0, to: 1 },
      new AbortController().signal,
      cache,
    );
    expect(again.cacheKey).toBe(first.cacheKey);
    await fs.utimes(source, new Date(), new Date(Date.now() + 5000));
    const newer = await getLosslessPlaybackFile(
      await input(),
      { from: 0, to: 1 },
      new AbortController().signal,
      cache,
    );
    expect(newer.cacheKey).not.toBe(first.cacheKey);
  });

  test("compatible ranges release low-bitrate preload connections while batching high-bitrate reads", async () => {
    const original = await fs.readFile(source);
    const prepared = await getLosslessPlaybackFile(
      await input(),
      { from: 0, to: 4, lease: leaseA },
      new AbortController().signal,
      cache,
    );
    const previous = process.env.XENSE_VIDEO_CACHE_DIR;
    process.env.XENSE_VIDEO_CACHE_DIR = cache;
    try {
      const context = {
        params: Promise.resolve({
          encodedPath: encodeLocalDatasetPath(root),
          filePath: ["source.mp4"],
        }),
      };
      const base = `http://localhost/api/file?compat=lossless-h264&from=0&to=4&lease=${leaseA}`;
      // Resize the prepared file sparsely to represent disparate camera bitrates.
      for (const [size, maximum] of [
        [1024 * 1024, 512 * 1024],
        [128 * 1024 * 1024, 32 * 1024 * 1024],
      ]) {
        await fs.truncate(prepared.file.absolutePath, size);
        for (const start of [0, 512 * 1024]) {
          const response = await GET(
            new NextRequest(base, { headers: { range: `bytes=${start}-` } }),
            context,
          );
          expect(response.status).toBe(206);
          expect(Number(response.headers.get("content-length"))).toBe(maximum);
          expect(response.headers.get("content-range")).toBe(
            `bytes ${start}-${start + maximum - 1}/${size}`,
          );
          await response.body!.cancel();
        }
      }
      const download = await GET(
        new NextRequest("http://localhost/api/file"),
        context,
      );
      expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
    } finally {
      if (previous === undefined) delete process.env.XENSE_VIDEO_CACHE_DIR;
      else process.env.XENSE_VIDEO_CACHE_DIR = previous;
    }
  });
  test("retains ordinary H.264 and rejects invalid intervals and pre-aborted requests", async () => {
    await fs.copyFile(path.join(fixtures, "h264.mp4"), source);
    const file = await input();
    const result = await getLosslessPlaybackFile(
      file,
      { from: 0, to: 1 },
      new AbortController().signal,
      cache,
    );
    expect(result.converted).toBe(false);
    expect(result.file.absolutePath).toBe(source);
    expect(await files()).toEqual([]);
    for (const range of [
      { from: -1 },
      { from: 2, to: 1 },
      { from: Number.NaN },
    ])
      await expect(
        getLosslessPlaybackFile(
          file,
          range,
          new AbortController().signal,
          cache,
        ),
      ).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      getLosslessPlaybackFile(file, { from: 0 }, aborted.signal, cache),
    ).rejects.toThrow();
  });
  test("evicts unused copies while preserving files with a live client lease", async () => {
    await fs.mkdir(cache);
    const old = new Date(Date.now() - 3600000);
    const keys = Array.from({ length: 4 }, (_, i) =>
      String(i).padStart(64, "0"),
    );
    for (const key of keys) {
      const target = path.join(cache, key + ".mp4");
      const handle = await fs.open(target, "w");
      await handle.truncate(4 * 1024 ** 3);
      await handle.close();
      await fs.utimes(target, old, old);
    }
    await fs.writeFile(path.join(cache, keys[0] + ".lease-" + leaseB), "");
    const result = await getLosslessPlaybackFile(
      await input(),
      { from: 0, to: 1, lease: leaseA },
      new AbortController().signal,
      cache,
    );
    expect(result.converted).toBe(true);
    expect((await files()).includes(keys[0] + ".mp4")).toBe(true);
    const remaining = await files();
    expect(keys.slice(1).some((key) => !remaining.includes(key + ".mp4"))).toBe(
      true,
    );
  });
});

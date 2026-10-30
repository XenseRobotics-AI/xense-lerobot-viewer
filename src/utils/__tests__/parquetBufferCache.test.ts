import { describe, expect, test } from "bun:test";
import { ParquetBufferCache } from "../parquetBufferCache";
import { fetchParquetFile } from "../parquetUtils";

describe("bounded parquet buffer cache", () => {
  test("deduplicates file opens and equivalent suffix byte requests", async () => {
    let opens = 0,
      reads = 0;
    const cache = new ParquetBufferCache({
      smallFileBytes: 0,
      open: async () => {
        opens++;
        return {
          byteLength: 100,
          slice: async (a, b) => {
            reads++;
            await Bun.sleep(1);
            return new ArrayBuffer((b ?? 100) - a);
          },
        };
      },
    });
    const [a, b] = await Promise.all([cache.get("x"), cache.get("x")]);
    expect(a).toBe(b);
    const results = await Promise.all([
      a.slice(-8),
      b.slice(92, 100),
      b.slice(92),
    ]);
    expect(opens).toBe(1);
    expect(reads).toBe(1);
    expect(results.every((value) => value.byteLength === 8)).toBe(true);
  });

  test("limits total retained bytes and ranges across files", async () => {
    let reads = 0;
    const cache = new ParquetBufferCache({
      maxFiles: 4,
      maxBytes: 15,
      maxRanges: 2,
      smallFileBytes: 0,
      open: async () => ({
        byteLength: 100,
        slice: async (a, b) => {
          reads++;
          return new ArrayBuffer((b ?? 100) - a);
        },
      }),
    });
    const a = await cache.get("a"),
      b = await cache.get("b");
    await a.slice(0, 8);
    await b.slice(0, 8);
    expect(cache.stats.bytes).toBe(8);
    await a.slice(0, 8);
    expect(reads).toBe(3);
    await a.slice(0, 100);
    expect(cache.stats.bytes).toBe(8);
    for (let i = 0; i < 40; i++) {
      await b.slice(i, i + 1);
      expect(cache.stats.ranges).toBeLessThanOrEqual(2);
    }
  });

  test("file eviction releases its ranges without invalidating readers", async () => {
    let complete!: (value: ArrayBuffer) => void;
    const waiting = new Promise<ArrayBuffer>((resolve) => {
      complete = resolve;
    });
    const cache = new ParquetBufferCache({
      maxFiles: 1,
      smallFileBytes: 0,
      open: async () => ({ byteLength: 100, slice: () => waiting }),
    });
    const old = await cache.get("old");
    const read = old.slice(0, 8);
    await cache.get("new");
    complete(new ArrayBuffer(8));
    expect((await read).byteLength).toBe(8);
    expect(cache.stats).toEqual({ files: 1, ranges: 0, bytes: 0, pending: 0 });
    expect((await old.slice(0, 8)).byteLength).toBe(8);
    expect(cache.stats.bytes).toBe(0);
  });

  test("retries failed HEAD and range reads rather than retaining rejection", async () => {
    let opens = 0,
      reads = 0;
    const cache = new ParquetBufferCache({
      smallFileBytes: 0,
      open: async () => {
        if (++opens === 1) throw new Error("HEAD unavailable");
        return {
          byteLength: 100,
          slice: async () => {
            if (++reads === 1) throw new Error("offline");
            return new ArrayBuffer(8);
          },
        };
      },
    });
    await expect(cache.get("x")).rejects.toThrow("HEAD unavailable");
    const file = await cache.get("x");
    await expect(Promise.resolve(file.slice(0, 8))).rejects.toThrow("offline");
    expect((await file.slice(0, 8)).byteLength).toBe(8);
    expect(reads).toBe(2);
  });

  test("small metadata files share one full read and expire on inactivity", async () => {
    let now = 0,
      reads = 0;
    const cache = new ParquetBufferCache({
      now: () => now,
      open: async () => ({
        byteLength: 32,
        slice: async () => {
          reads++;
          return new Uint8Array(Array.from({ length: 32 }, (_, i) => i)).buffer;
        },
      }),
    });
    const file = await cache.get("metadata");
    expect([...new Uint8Array(await file.slice(-4))]).toEqual([28, 29, 30, 31]);
    expect((await file.slice(2, 6)).byteLength).toBe(4);
    expect(reads).toBe(1);
    now = 180_000;
    cache.prune();
    expect(cache.stats.bytes).toBe(32);
    expect(cache.stats.files).toBe(1);
    now = 300_000;
    cache.prune();
    expect(cache.stats.bytes).toBe(0);
    expect(cache.stats.files).toBe(0);
  });

  test("long sessions and retained old handles cannot grow the shared budget", async () => {
    const cache = new ParquetBufferCache({
      maxFiles: 3,
      maxBytes: 30,
      maxRanges: 5,
      smallFileBytes: 0,
      open: async () => ({
        byteLength: 100,
        slice: async (a, b) => new ArrayBuffer((b ?? 100) - a),
      }),
    });
    const old = await cache.get("old");
    for (let i = 0; i < 500; i++) {
      const file = await cache.get(String(i));
      await Promise.all([file.slice(0, 8), file.slice(8, 16), old.slice(0, 8)]);
      expect(cache.stats.files).toBeLessThanOrEqual(3);
      expect(cache.stats.bytes).toBeLessThanOrEqual(30);
      expect(cache.stats.ranges).toBeLessThanOrEqual(5);
    }
  });

  test("rejects invalid suffix combinations without I/O", async () => {
    const cache = new ParquetBufferCache({
      open: async () => ({
        byteLength: 100,
        slice: () => {
          throw new Error("must not run");
        },
      }),
    });
    const file = await cache.get("x");
    await expect(Promise.resolve(file.slice(-8, 100))).rejects.toThrow(
      "suffix",
    );
    await expect(Promise.resolve(file.slice(10, 2))).rejects.toThrow(
      "byte range",
    );
    expect((await file.slice(100, 100)).byteLength).toBe(0);
  });
});

describe("parquet HTTP range compatibility", () => {
  for (const supportsRange of [true, false])
    for (const length of [1024, 600 * 1024])
      test(
        "reads actual HTTP with Range support=" +
          supportsRange +
          " size=" +
          length,
        async () => {
          let reads = 0;
          const bytes = new Uint8Array(
            Array.from({ length }, (_, i) => i % 256),
          );
          const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch(req) {
              if (req.method === "HEAD")
                return new Response(null, {
                  headers: { "content-length": String(bytes.length) },
                });
              reads++;
              if (reads === 1)
                return new Response("temporary", { status: 503 });
              const match = req.headers
                .get("range")
                ?.match(/^bytes=(\d+)-(\d+)$/);
              return supportsRange && match
                ? new Response(
                    bytes.slice(Number(match[1]), Number(match[2]) + 1),
                    { status: 206 },
                  )
                : new Response(bytes);
            },
          });
          try {
            const file = await fetchParquetFile(server.url.toString());
            await expect(Promise.resolve(file.slice(10, 20))).rejects.toThrow(
              "503",
            );
            expect([...new Uint8Array(await file.slice(10, 20))]).toEqual([
              ...bytes.slice(10, 20),
            ]);
            expect([...new Uint8Array(await file.slice(-8))]).toEqual([
              ...bytes.slice(-8),
            ]);
            expect(reads).toBe(length === 1024 ? 2 : 3);
          } finally {
            server.stop(true);
          }
        },
      );
});

test("truncated HTTP data is retryable rather than poisoning the cache", async () => {
  let gets = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.method === "HEAD")
        return new Response(null, { headers: { "content-length": "16" } });
      gets++;
      return new Response(new Uint8Array(gets === 1 ? 4 : 16), { status: 206 });
    },
  });
  try {
    const file = await fetchParquetFile(server.url.toString());
    await expect(Promise.resolve(file.slice(0, 8))).rejects.toThrow(
      "Invalid parquet range response",
    );
    expect((await file.slice(0, 8)).byteLength).toBe(8);
    expect(gets).toBe(2);
  } finally {
    server.stop(true);
  }
});

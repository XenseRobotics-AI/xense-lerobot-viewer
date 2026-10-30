import { describe, expect, test } from "bun:test";
import { EpisodeDataCache, estimateEpisodeBytes } from "../episodeDataCache";

function deferred<T>() {
  let resolve!: (data: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const make = (
  extra: Partial<
    ConstructorParameters<typeof EpisodeDataCache<number>>[0]
  > = {},
) =>
  new EpisodeDataCache<number>({
    recentEntries: 3,
    recentBytes: 30,
    prefetchEntries: 3,
    prefetchBytes: 30,
    estimate: (data) => data,
    distance: (a, b) => Math.abs(Number(a) - Number(b)),
    ...extra,
  });

describe("episode data cache", () => {
  test("a foreground switch bypasses background work, and the same key adopts it", async () => {
    const cache = make();
    cache.setTargets(["1", "2"], "0");
    const wait = deferred<number>();
    let calls = 0;
    const bg = cache.prefetch("1", () => {
      calls++;
      return wait.promise;
    });
    expect(await cache.prefetch("2", async () => 9)).toEqual({});
    expect(await cache.get("2", async () => 8)).toEqual({ data: 8 });
    const fg = cache.get("1", async () => {
      calls++;
      return 99;
    });
    wait.resolve(7);
    expect(await fg).toEqual({ data: 7 });
    expect(await bg).toEqual({ data: 7 });
    expect(calls).toBe(1);
    expect(cache.backgroundBusy).toBe(false);
    expect(await cache.get("1", async () => 99)).toEqual({ data: 7 });
  });

  test("failed in-flight preloads recover once on the foreground path for all selectors", async () => {
    const cache = make();
    cache.setTargets(["1"], "0");
    const wait = deferred<number>();
    const bg = cache.prefetch("1", () => wait.promise);
    let calls = 0;
    const load = async () => {
      calls++;
      return 7;
    };
    const first = cache.get("1", load);
    const second = cache.get("1", load);
    wait.reject(new Error("Worker unavailable or result too large"));
    expect(await bg).toEqual({
      error: "Worker unavailable or result too large",
    });
    expect(await first).toEqual({ data: 7 });
    expect(await second).toEqual({ data: 7 });
    expect(calls).toBe(1);
    expect(cache.backgroundBusy).toBe(false);
    expect(cache.stats.pending).toBe(0);
  });

  test("foreground recovery reports actual data failure without a retry loop", async () => {
    const cache = make();
    cache.setTargets(["1"], "0");
    const wait = deferred<number>();
    const bg = cache.prefetch("1", () => wait.promise);
    let calls = 0;
    const first = cache.get("1", async () => {
      calls++;
      throw new Error("Corrupt data");
    });
    wait.reject(new Error("Background failed"));
    await bg;
    expect(await first).toEqual({ error: "Corrupt data" });
    expect(calls).toBe(1);
    expect(cache.stats.pending).toBe(0);
  });

  test("prefetch never displaces foreground history and promotion reuses the result", async () => {
    const cache = make();
    await cache.get("0", async () => 8);
    cache.setTargets(["1", "2", "3"], "0");
    for (const id of ["1", "2", "3"]) await cache.prefetch(id, async () => 8);
    expect(cache.stats.prefetchEntries).toBe(3);
    expect(await cache.get("0", async () => 99)).toEqual({ data: 8 });
    expect(await cache.get("2", async () => 99)).toEqual({ data: 8 });
    expect(cache.stats.prefetchEntries).toBe(2);
    expect(cache.stats.recentEntries).toBe(2);
  });

  test("failed speculative reads are silent, not cached, and foreground can retry", async () => {
    const cache = make();
    cache.setTargets(["1"], "0");
    expect(
      await cache.prefetch("1", async () => {
        throw new Error("offline");
      }),
    ).toEqual({ error: "offline" });
    expect(cache.canPrefetch("1")).toBe(false);
    expect(await cache.get("1", async () => 6)).toEqual({ data: 6 });
    expect(cache.stats.pending).toBe(0);
  });

  test("old scope completion and cleanup cannot populate or clear a new scope", async () => {
    const cache = make();
    const oldRelease = cache.setTargets(["1"], "0");
    const wait = deferred<number>();
    const bg = cache.prefetch("1", () => wait.promise);
    const release = cache.setTargets(["22"], "20");
    expect(oldRelease()).toBe(false);
    wait.resolve(5);
    await bg;
    expect(cache.stats.prefetchEntries).toBe(0);
    expect(cache.canPrefetch("22")).toBe(true);
    expect(release()).toBe(true);
    expect(cache.canPrefetch("22")).toBe(false);
  });

  test("count/byte bounds prevent repeated eviction and prefetch loops", async () => {
    const cache = make({ prefetchEntries: 2, prefetchBytes: 15 });
    cache.setTargets(["1", "2", "3"], "0");
    await cache.prefetch("1", async () => 8);
    await cache.prefetch("2", async () => 8);
    expect(cache.stats.prefetchBytes).toBe(8);
    expect(cache.canPrefetch("2")).toBe(false);
    expect(cache.canPrefetch("1")).toBe(false);
    expect(cache.stats.prefetchEntries).toBe(1);
  });

  test("oversized background results are released; the active episode may exceed the recent byte budget", async () => {
    const cache = make();
    cache.setTargets(["1"], "0");
    await cache.prefetch("1", async () => 90);
    expect(cache.stats.prefetchBytes).toBe(0);
    await cache.get("1", async () => 90);
    expect(cache.stats.recentEntries).toBe(1);
    expect(cache.stats.recentBytes).toBe(90);
  });

  test("late old foreground completions never evict the current episode", async () => {
    const cache = make({ recentEntries: 1 });
    const wait = deferred<number>();
    const old = cache.get("1", () => wait.promise);
    await cache.get("2", async () => 8);
    wait.resolve(7);
    await old;
    expect(cache.stats.recentEntries).toBe(1);
    expect(await cache.get("2", async () => 99)).toEqual({ data: 8 });
  });

  test("offscreen distance tiers expire after 60 / 240 / 600 seconds", async () => {
    let now = 0;
    const cache = make({ now: () => now });
    cache.setTargets(["1", "8", "80"], "0");
    for (const id of ["1", "8", "80"]) await cache.prefetch(id, async () => 5);
    now = 30_000;
    cache.setTargets([], "0");
    now += 59_999;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(3);
    now += 1;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(2);
    now += 179_999;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(2);
    now += 1;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(1);
    now += 359_999;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(1);
    now += 1;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(0);
  });

  test("revisiting within the extended grace period avoids fetching again", async () => {
    for (const [id, elapsed] of [
      ["1", 480_000],
      ["8", 180_000],
      ["80", 45_000],
    ] as const) {
      let now = 0;
      const cache = make({ now: () => now });
      cache.setTargets([id], "0");
      await cache.prefetch(id, async () => 8);
      cache.setTargets([], "0");
      now = elapsed;
      cache.prune();
      let reloads = 0;
      expect(
        await cache.get(id, async () => {
          reloads++;
          return 99;
        }),
      ).toEqual({ data: 8 });
      expect(reloads).toBe(0);
    }
  });

  test("visible and active data survive expiry; far offscreen entries make room first", async () => {
    let now = 0;
    const cache = make({ now: () => now });
    cache.setTargets(["1", "8", "80"], "0");
    for (const id of ["1", "8", "80"]) await cache.prefetch(id, async () => 5);
    cache.setTargets(["9"], "0");
    await cache.prefetch("9", async () => 5);
    expect(await cache.get("1", async () => 99)).toEqual({ data: 5 });
    expect(await cache.get("80", async () => 99)).toEqual({ data: 99 });
    cache.setTargets(["9"], "80");
    now = 900_000;
    cache.prune();
    expect(cache.stats.prefetchEntries).toBe(1);
    expect(cache.stats.recentEntries).toBe(1);
  });

  test("long switching sessions stay within count and byte budgets", async () => {
    let now = 0;
    const cache = make({ now: () => now });
    for (let step = 0; step < 1000; step++) {
      now += 1_000;
      const id = step * 10;
      cache.setTargets([String(id + 1), String(id + 2)], String(id));
      await cache.get(String(id), async () => 8);
      await cache.prefetch(String(id + 1), async () => 8);
      await cache.prefetch(String(id + 2), async () => 8);
      expect(cache.stats.recentEntries).toBeLessThanOrEqual(3);
      expect(cache.stats.recentBytes).toBeLessThanOrEqual(30);
      expect(cache.stats.prefetchEntries).toBeLessThanOrEqual(3);
      expect(cache.stats.prefetchBytes).toBeLessThanOrEqual(30);
    }
    cache.setTargets([])();
    now += 61_000;
    cache.prune();
    expect(cache.stats.recentEntries + cache.stats.prefetchEntries).toBe(0);
  });

  test("sampled size estimate counts unique row arrays and timestamps", () => {
    const rows = [{ timestamp: 1, state: { x: 2 } }];
    const data = {
      flatChartData: rows,
      chartDataGroups: [rows],
      velocityChartDataGroups: [],
    };
    expect(estimateEpisodeBytes(data)).toBe(
      estimateEpisodeBytes({ ...data, chartDataGroups: [] }),
    );
    expect(estimateEpisodeBytes({ ...data, frameTimestamps: [1, 2] })).toBe(
      estimateEpisodeBytes(data) + 32,
    );
  });
});

import { describe, it, expect } from "bun:test";
import { rememberInLru, touchLru } from "../lruCache";

describe("rememberInLru", () => {
  it("evicts the oldest entry once over capacity", () => {
    const cache = new Map<string, number>();
    rememberInLru(cache, "a", 1, 2);
    rememberInLru(cache, "b", 2, 2);
    rememberInLru(cache, "c", 3, 2);
    expect([...cache.keys()]).toEqual(["b", "c"]);
  });

  it("refreshes an existing key to the newest end instead of duplicating", () => {
    const cache = new Map<string, number>();
    rememberInLru(cache, "a", 1, 3);
    rememberInLru(cache, "b", 2, 3);
    rememberInLru(cache, "a", 10, 3);
    expect([...cache.keys()]).toEqual(["b", "a"]);
    expect(cache.get("a")).toBe(10);
  });

  it("evicts down to capacity when several entries are over", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    rememberInLru(cache, "e", 5, 2);
    expect([...cache.keys()]).toEqual(["d", "e"]);
  });

  it("holds nothing when capacity is below one", () => {
    const cache = new Map<string, number>();
    rememberInLru(cache, "a", 1, 0);
    expect(cache.size).toBe(0);
  });

  it("drops a previously cached key when capacity falls to zero", () => {
    const cache = new Map<string, number>([["a", 1]]);
    rememberInLru(cache, "a", 2, 0);
    expect(cache.has("a")).toBe(false);
  });

  it("keeps null and other falsy values as real entries", () => {
    const cache = new Map<string, number | null>();
    rememberInLru(cache, "miss", null, 2);
    expect(cache.has("miss")).toBe(true);
    expect(cache.get("miss")).toBeNull();
  });
});

describe("touchLru", () => {
  it("moves a hit to the newest end", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(touchLru(cache, "a")).toBe(1);
    expect([...cache.keys()]).toEqual(["b", "c", "a"]);
  });

  it("returns undefined and leaves order alone on a miss", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(touchLru(cache, "zz")).toBeUndefined();
    expect([...cache.keys()]).toEqual(["a", "b"]);
  });

  it("distinguishes a stored undefined from an absent key", () => {
    // `cache.get()` alone cannot tell these apart, which is why the
    // implementation probes with `has()`.
    const cache = new Map<string, number | undefined>([["set", undefined]]);
    expect(cache.has("set")).toBe(true);
    touchLru(cache, "set");
    expect([...cache.keys()]).toEqual(["set"]);
  });

  it("protects a touched entry from the next eviction", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    touchLru(cache, "a");
    rememberInLru(cache, "c", 3, 2);
    expect([...cache.keys()]).toEqual(["a", "c"]);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  isChunkLoadError,
  reloadOnceForChunkError,
} from "@/utils/lazyChunkRecovery";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const state = new Map<string, string>();
const reload = mock(() => {});

beforeEach(() => {
  state.clear();
  reload.mockClear();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "http://localhost/_local/example/episode_0", reload },
      sessionStorage: {
        getItem: (key: string) => state.get(key) ?? null,
        setItem: (key: string, value: string) => state.set(key, value),
      },
    },
  });
});

afterEach(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("lazy chunk recovery", () => {
  test("distinguishes chunk failures from application errors", () => {
    expect(
      isChunkLoadError(new Error("ChunkLoadError: Loading chunk 42 failed")),
    ).toBe(true);
    expect(
      isChunkLoadError(
        new Error("Failed to load chunk /_next/static/chunks/42.js"),
      ),
    ).toBe(true);
    expect(reloadOnceForChunkError("viewer", new Error("Invalid data"))).toBe(
      false,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads once and prevents loops for the same view", () => {
    const error = new Error("ChunkLoadError");
    expect(reloadOnceForChunkError("viewer", error)).toBe(true);
    expect(reloadOnceForChunkError("viewer", error)).toBe(false);
    expect(reloadOnceForChunkError("doctor", error)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("recovers from corrupt state but skips recovery when storage is blocked", () => {
    state.set("xense:chunk-reload", "invalid JSON");
    expect(reloadOnceForChunkError("viewer", new Error("ChunkLoadError"))).toBe(
      true,
    );
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new Error("blocked");
      },
    });
    expect(reloadOnceForChunkError("viewer", new Error("ChunkLoadError"))).toBe(
      false,
    );
  });
});

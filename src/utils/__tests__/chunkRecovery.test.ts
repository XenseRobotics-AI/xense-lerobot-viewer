import { describe, expect, test } from "bun:test";
import { chunkErrorKey, claimChunkReload } from "../chunkRecovery";

function storage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}
const url = "http://localhost:3000/_next/static/chunks/app/%255Flocal/page.js";
const error = {
  name: "ChunkLoadError",
  message: "Loading chunk app/local/page failed.",
  request: url,
};

describe("chunk recovery", () => {
  test("reloads once for one failed asset even after later compilations", () => {
    const saved = storage();
    expect(claimChunkReload(error, saved)).toBe(true);
    expect(claimChunkReload(error, saved)).toBe(false);
    expect(claimChunkReload({ ...error, request: url + "?v=123" }, saved)).toBe(
      false,
    );
    expect(claimChunkReload({ ...error, request: url + "?v=456" }, saved)).toBe(
      false,
    );
  });
  test("shares recovery state between a global rejection and route boundary", () => {
    const saved = storage();
    expect(
      claimChunkReload(
        {
          ...error,
          message: "Loading chunk app/local/page failed.\n(error: " + url + ")",
          request: undefined,
        },
        saved,
      ),
    ).toBe(true);
    expect(claimChunkReload(error, saved)).toBe(false);
  });
  test("allows recovery for a different asset after deployment", () => {
    const saved = storage();
    expect(claimChunkReload(error, saved)).toBe(true);
    expect(
      claimChunkReload(
        { ...error, request: url.replace("page.js", "new-page.js") },
        saved,
      ),
    ).toBe(true);
  });
  test("does not reload for unrelated errors or unavailable storage", () => {
    const saved = storage();
    expect(claimChunkReload(new Error("Dataset missing"), saved)).toBe(false);
    expect(chunkErrorKey(null)).toBeNull();
    expect(
      claimChunkReload(error, {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
      }),
    ).toBe(false);
    expect(
      claimChunkReload(error, {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
    expect(
      claimChunkReload(error, {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).toBe(false);
  });
  test("handles corrupted state and recognizes lazy CSS and module errors", () => {
    expect(claimChunkReload(error, storage("invalid JSON"))).toBe(true);
    expect(chunkErrorKey("Loading CSS chunk 12 failed.")).not.toBeNull();
    expect(
      chunkErrorKey("Failed to fetch dynamically imported module: " + url),
    ).toBe(url);
  });
});

import { describe, expect, test } from "bun:test";
import {
  ReviewPendingOperations,
  REVIEW_PENDING_STORAGE_KEY,
} from "../reviewPendingOperations";
const target = (episode_index = 0) => ({
  operation_id: crypto.randomUUID(),
  episode_index,
  reviewer: "Alice",
  source: "episodes" as const,
  reviewed: true,
});
function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) =>
      key === REVIEW_PENDING_STORAGE_KEY ? value : null,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}
describe("pending review recovery", () => {
  test("invalid scopes cannot create recovery data which fails on reload", () => {
    const disk = storage(),
      store = new ReviewPendingOperations(disk);
    expect(() => store.begin("", target())).toThrow();
    expect(() => store.begin("x".repeat(32769), target())).toThrow();
    expect(disk.getItem(REVIEW_PENDING_STORAGE_KEY)).toBeNull();
  });
  test("fresh instances restore the exact operation without replaying a write", () => {
    const disk = storage(),
      first = new ReviewPendingOperations(disk),
      operation = target();
    expect(first.begin("scope-a", operation)).toBe("started");
    expect(first.dispatch("scope-a", operation)).toBe(true);
    const restored = new ReviewPendingOperations(disk);
    expect(restored.list("scope-a")).toEqual([operation]);
    expect(restored.begin("scope-a", target())).toBe("blocked");
    restored.resolve("scope-a", operation);
    expect(new ReviewPendingOperations(disk).list("scope-a")).toEqual([]);
  });
  test("browse and dataset scopes are isolated and returned entries are copies", () => {
    const store = new ReviewPendingOperations(),
      operation = target();
    store.begin("scope-a", operation);
    expect(store.has("scope-b", 0, "Alice")).toBe(false);
    expect(store.begin("scope-b", target())).toBe("started");
    store.list("scope-a")[0].reviewed = false;
    expect(store.list("scope-a")[0].reviewed).toBe(true);
    store.resolve("scope-b", operation);
    expect(store.list("scope-b")).toHaveLength(1);
  });
  test("an old completion cannot clear a newer operation for the same target", () => {
    const store = new ReviewPendingOperations(),
      first = target(),
      second = target();
    store.begin("scope", first);
    store.resolve("scope", first);
    store.begin("scope", second);
    store.resolve("scope", first);
    expect(store.list("scope")).toEqual([second]);
  });
  test("capacity blocks new operations rather than dropping unresolved ones", () => {
    const store = new ReviewPendingOperations(storage(), 1),
      first = target();
    store.begin("scope", first);
    expect(store.begin("scope", target(1))).toBe("full");
    expect(store.list("scope")).toEqual([first]);
    store.resolve("scope", first);
    expect(store.begin("scope", target(1))).toBe("started");
  });
  test("storage quota failures retain in-page guards and recover on later writes", () => {
    const disk = storage();
    let fails = true;
    const store = new ReviewPendingOperations({
      getItem: disk.getItem,
      setItem(key, value) {
        if (fails) throw new Error("Quota");
        disk.setItem(key, value);
      },
    });
    const first = target();
    store.begin("scope", first);
    store.dispatch("scope", first);
    expect(store.persistent).toBe(false);
    expect(store.has("scope", 0, "Alice")).toBe(true);
    fails = false;
    const second = target(1);
    store.begin("scope", second);
    store.dispatch("scope", second);
    expect(store.persistent).toBe(true);
    expect(new ReviewPendingOperations(disk).list("scope")).toHaveLength(2);
  });
  test("unreadable recovery data is never overwritten by a later successful set", () => {
    let writes = 0;
    const store = new ReviewPendingOperations({
      getItem() {
        throw new Error("Unavailable");
      },
      setItem() {
        writes++;
      },
    });
    const operation = target();
    store.begin("scope", operation);
    store.dispatch("scope", operation);
    expect(store.persistent).toBe(false);
    expect(writes).toBe(0);
  });
  test("corrupted or oversized recovery data blocks submissions without erasing evidence", () => {
    for (const raw of [
      "{",
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({
        version: 1,
        entries: [{ scope: "scope", operation: {} }],
      }),
      JSON.stringify({
        version: 1,
        entries: [
          { scope: "scope", operation: target() },
          { scope: "scope", operation: target() },
        ],
      }),
    ]) {
      const disk = storage(raw),
        store = new ReviewPendingOperations(disk);
      expect(store.damaged).toBe(true);
      expect(store.begin("scope", target())).toBe("blocked");
      expect(disk.getItem(REVIEW_PENDING_STORAGE_KEY)).toBe(raw);
    }
    const disk = storage(
      JSON.stringify({
        version: 1,
        entries: [
          { scope: "scope", operation: target() },
          { scope: "scope", operation: target(1) },
        ],
      }),
    );
    expect(new ReviewPendingOperations(disk, 1).damaged).toBe(true);
  });
  test("recovery serialization retains only validated operation fields", () => {
    const disk = storage(),
      store = new ReviewPendingOperations(disk);
    const operation = { ...target(), private_note: "not stored" };
    store.begin("scope", operation);
    store.dispatch("scope", operation);
    expect(disk.getItem(REVIEW_PENDING_STORAGE_KEY)).not.toContain(
      "not stored",
    );
  });
  test("page exit cancels only unsent work and cannot dispatch it later", () => {
    const disk = storage(),
      store = new ReviewPendingOperations(disk),
      queued = target(),
      sent = target(1);
    store.begin("scope", queued);
    store.begin("scope", sent);
    store.dispatch("scope", sent);
    expect(new ReviewPendingOperations(disk).list("scope")).toEqual([sent]);
    store.cancelQueued();
    expect(store.dispatch("scope", queued)).toBe(false);
    expect(store.dispatch("scope", sent)).toBe(false);
    expect(store.list("scope")).toEqual([sent]);
  });
});

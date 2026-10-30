import { describe, test, expect } from "bun:test";
import { ReviewSaveQueue, reviewSaveKey } from "../reviewSaveQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("background review saves", () => {
  test("orders snapshots while immediately accepting other episode/person marks", async () => {
    const queue = new ReviewSaveQueue();
    const gate = deferred();
    const writes: string[] = [];
    const a = queue.enqueue(reviewSaveKey(0, "甲"), async () => {
      writes.push("0甲");
      await gate.promise;
    });
    const b = queue.enqueue(reviewSaveKey(1, "甲"), async () => {
      writes.push("1甲");
    });
    const c = queue.enqueue(reviewSaveKey(1, "乙"), async () => {
      writes.push("1乙");
    });
    expect(queue.size).toBe(3);
    expect(queue.has(reviewSaveKey(2, "甲"))).toBe(false);
    await Promise.resolve();
    expect(writes).toEqual(["0甲"]);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(writes).toEqual(["0甲", "1甲", "1乙"]);
    expect(queue.size).toBe(0);
  });
  test("deduplicates the same person's mark across both viewing entry points", async () => {
    const queue = new ReviewSaveQueue();
    const gate = deferred();
    let writes = 0;
    const key = reviewSaveKey(4, " 甲 ");
    const a = queue.enqueue(key, async () => {
      writes++;
      await gate.promise;
    });
    const b = queue.enqueue(reviewSaveKey(4, "甲"), async () => {
      writes++;
    });
    expect(b).toBe(a);
    gate.resolve();
    await a;
    expect(writes).toBe(1);
  });
  test("a failed record does not stop later saves or prevent its own retry", async () => {
    const queue = new ReviewSaveQueue();
    const error = new Error("disk unavailable");
    const a = queue.enqueue("a", async () => {
      throw error;
    });
    let saved = false;
    const b = queue.enqueue("b", async () => {
      saved = true;
    });
    await expect(a).rejects.toBe(error);
    await b;
    expect(saved).toBe(true);
    await queue.enqueue("a", async () => {});
    expect(queue.size).toBe(0);
  });
  test("a different dataset queue does not wait for the old dataset write", async () => {
    const old = new ReviewSaveQueue();
    const current = new ReviewSaveQueue();
    const gate = deferred();
    const pending = old.enqueue("record", () => gate.promise);
    let saved = false;
    await current.enqueue("record", async () => {
      saved = true;
    });
    expect(saved).toBe(true);
    expect(old.size).toBe(1);
    gate.resolve();
    await pending;
  });
});

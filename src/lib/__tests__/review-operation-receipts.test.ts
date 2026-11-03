import { describe, expect, test } from "bun:test";
import { ReviewOperationReceipts } from "../review-operation-receipts";

const operation = () => ({
  operation_id: crypto.randomUUID(),
  episode_index: 1,
  reviewer: "Alice",
  source: "episodes" as const,
  reviewed: true,
});
describe("bounded review operation receipts", () => {
  test("only the owning request may move pending to a terminal outcome", () => {
    const registry = new ReviewOperationReceipts(),
      update = operation();
    const ticket = registry.begin("scope", update);
    expect(ticket.state).toBe("started");
    expect(registry.get("scope", update.operation_id)?.state).toBe("pending");
    expect(registry.begin("scope", update).state).toBe("duplicate");
    expect(registry.begin("scope", { ...update, reviewed: false }).state).toBe(
      "conflict",
    );
    if (ticket.state !== "started") throw new Error("Missing ticket");
    ticket.finish("succeeded");
    ticket.finish("failed");
    expect(registry.get("scope", update.operation_id)?.state).toBe("succeeded");
    const copy = registry.get("scope", update.operation_id)!;
    copy.state = "failed";
    expect(registry.get("scope", update.operation_id)?.state).toBe("succeeded");
  });
  test("different browse and dataset scopes cannot see each other's receipts", () => {
    const registry = new ReviewOperationReceipts(),
      update = operation();
    registry.begin("scope-a", update);
    expect(registry.get("scope-b", update.operation_id)).toBeUndefined();
    expect(
      registry.begin("scope-b", { ...update, reviewed: false }).state,
    ).toBe("started");
  });
  test("capacity never evicts a running request and terminal receipts expire", () => {
    let now = 0;
    const registry = new ReviewOperationReceipts({
      capacity: 1,
      retentionMs: 10,
      now: () => now,
    });
    const update = operation(),
      ticket = registry.begin("scope", update);
    expect(registry.begin("scope", operation()).state).toBe("unavailable");
    now = 100;
    expect(registry.get("scope", update.operation_id)?.state).toBe("pending");
    if (ticket.state !== "started") throw new Error("Missing ticket");
    ticket.finish("failed");
    now = 111;
    expect(registry.get("scope", update.operation_id)).toBeUndefined();
    expect(registry.status()).toMatchObject({
      tracked: 0,
      unavailable: 1,
      capacity: 1,
    });
  });
  test("capacity pressure evicts terminal evidence conservatively", () => {
    const registry = new ReviewOperationReceipts({ capacity: 1 }),
      first = operation(),
      ticket = registry.begin("scope", first);
    if (ticket.state !== "started") throw new Error("Missing ticket");
    ticket.finish("succeeded");
    expect(registry.begin("scope", operation()).state).toBe("started");
    expect(registry.get("scope", first.operation_id)).toBeUndefined();
    expect(registry.status().tracked).toBe(1);
  });
});

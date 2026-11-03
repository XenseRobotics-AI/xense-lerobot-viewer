import { parseReviewUpdate } from "@/types/episode-review.types";
import type { PendingReviewOperation } from "@/types/review-operation.types";
import { reviewSaveKey } from "./reviewSaveQueue";

export const REVIEW_PENDING_STORAGE_KEY = "xense-review-pending:v1";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
type Entry = {
  scope: string;
  operation: PendingReviewOperation;
  phase: "queued" | "sent";
};

/** Tab-local recovery evidence, not an automatic retry queue. Never evict pending work. */
export class ReviewPendingOperations {
  private entries = new Map<string, Entry>();
  private available: boolean;
  private readable = true;
  readonly damaged: boolean;
  constructor(
    private readonly storage?: StorageAccess,
    private readonly capacity = 256,
  ) {
    this.available = !!storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(REVIEW_PENDING_STORAGE_KEY) ?? null;
    } catch {
      this.available = false;
      this.readable = false;
    }
    try {
      if (raw !== null) {
        const input = JSON.parse(raw);
        if (
          input?.version !== 1 ||
          !Array.isArray(input.entries) ||
          input.entries.length > capacity
        )
          throw new Error("Invalid recovery data");
        for (const item of input.entries) {
          if (
            typeof item?.scope !== "string" ||
            !item.scope ||
            item.scope.length > 32768
          )
            throw new Error("Invalid recovery scope");
          const operation = parseReviewUpdate(item.operation);
          if (!operation.operation_id)
            throw new Error("Missing recovery operation");
          const key = this.key(item.scope, operation);
          if (this.entries.has(key))
            throw new Error("Duplicate recovery target");
          this.entries.set(key, {
            scope: item.scope,
            operation: operation as PendingReviewOperation,
            phase: "sent",
          });
        }
      }
      this.damaged = false;
    } catch {
      // Preserve the original value and block writes: corruption cannot prove completion.
      this.entries.clear();
      this.damaged = true;
    }
  }
  private key(
    scope: string,
    operation: Pick<PendingReviewOperation, "episode_index" | "reviewer">,
  ) {
    return JSON.stringify([
      scope,
      reviewSaveKey(operation.episode_index, operation.reviewer),
    ]);
  }
  private persist() {
    if (!this.storage || !this.readable) return;
    try {
      this.storage.setItem(
        REVIEW_PENDING_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          entries: [...this.entries.values()]
            .filter((entry) => entry.phase === "sent")
            .map(({ scope, operation }) => ({ scope, operation })),
        }),
      );
      this.available = true;
    } catch {
      this.available = false;
    }
  }
  get persistent() {
    return this.available;
  }
  list(scope: string): PendingReviewOperation[] {
    return [...this.entries.values()]
      .filter((entry) => entry.scope === scope)
      .map((entry) => ({ ...entry.operation }));
  }
  has(scope: string, episode: number, reviewer: string) {
    return this.entries.has(
      this.key(scope, { episode_index: episode, reviewer }),
    );
  }
  begin(
    scope: string,
    input: PendingReviewOperation,
  ): "started" | "blocked" | "full" {
    if (!scope || scope.length > 32768)
      throw new Error("Invalid recovery scope");
    if (this.damaged || this.has(scope, input.episode_index, input.reviewer))
      return "blocked";
    if (this.entries.size >= this.capacity) return "full";
    const operation = parseReviewUpdate(input) as PendingReviewOperation;
    if (!operation.operation_id) throw new Error("Missing pending operation");
    this.entries.set(this.key(scope, operation), {
      scope,
      operation,
      phase: "queued",
    });
    return "started";
  }
  dispatch(scope: string, target: PendingReviewOperation): boolean {
    const entry = this.entries.get(this.key(scope, target));
    if (
      entry?.operation.operation_id !== target.operation_id ||
      entry.phase !== "queued"
    )
      return false;
    entry.phase = "sent";
    this.persist();
    return true;
  }
  cancelQueued(): void {
    for (const [key, entry] of this.entries)
      if (entry.phase === "queued") this.entries.delete(key);
  }
  resolve(scope: string, target: PendingReviewOperation): void {
    const key = this.key(scope, target);
    if (this.entries.get(key)?.operation.operation_id !== target.operation_id)
      return;
    this.entries.delete(key);
    this.persist();
  }
}

let browserStore: ReviewPendingOperations | undefined;
export function reviewPendingOperations(): ReviewPendingOperations {
  if (!browserStore) {
    let storage: StorageAccess | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Memory still guards scope navigation. */
    }
    browserStore = new ReviewPendingOperations(storage);
    window.addEventListener("pagehide", () => browserStore?.cancelQueued());
  }
  return browserStore;
}

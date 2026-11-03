import type {
  ReviewOperationReceipt,
  PendingReviewOperation,
} from "@/types/review-operation.types";

interface Entry {
  signature: string;
  receipt: ReviewOperationReceipt;
  finishedAt?: number;
}
export class ReviewOperationReceipts {
  private entries = new Map<string, Entry>();
  private unavailable = 0;
  constructor(
    private readonly options: {
      capacity?: number;
      retentionMs?: number;
      now?: () => number;
    } = {},
  ) {}
  private prune() {
    const now = (this.options.now ?? Date.now)();
    for (const [key, entry] of this.entries)
      if (
        entry.finishedAt !== undefined &&
        now - entry.finishedAt >= (this.options.retentionMs ?? 600000)
      )
        this.entries.delete(key);
  }
  begin(
    scope: string,
    update: PendingReviewOperation,
  ):
    | { state: "started"; finish: (state: "succeeded" | "failed") => void }
    | { state: "duplicate"; receipt: ReviewOperationReceipt }
    | { state: "conflict" | "unavailable" } {
    this.prune();
    const key = JSON.stringify([scope, update.operation_id]);
    const signature = JSON.stringify([
      update.episode_index,
      update.reviewer,
      update.reviewed,
      update.source,
      update.stay_ms,
      update.episode_duration_ms,
    ]);
    const existing = this.entries.get(key);
    if (existing)
      return existing.signature === signature
        ? { state: "duplicate", receipt: { ...existing.receipt } }
        : { state: "conflict" };
    if (this.entries.size >= (this.options.capacity ?? 1024)) {
      const terminal = [...this.entries].find(
        ([, value]) => value.finishedAt !== undefined,
      );
      if (terminal) this.entries.delete(terminal[0]);
      else {
        this.unavailable++;
        return { state: "unavailable" };
      }
    }
    const entry: Entry = {
      signature,
      receipt: {
        operation_id: update.operation_id,
        episode_index: update.episode_index,
        reviewer: update.reviewer,
        reviewed: update.reviewed,
        state: "pending",
      },
    };
    this.entries.set(key, entry);
    return {
      state: "started",
      finish: (state) => {
        if (this.entries.get(key) !== entry || entry.finishedAt !== undefined)
          return;
        entry.receipt.state = state;
        entry.finishedAt = (this.options.now ?? Date.now)();
      },
    };
  }
  get(scope: string, operationId: string): ReviewOperationReceipt | undefined {
    this.prune();
    const entry = this.entries.get(JSON.stringify([scope, operationId]));
    return entry ? { ...entry.receipt } : undefined;
  }
  status() {
    this.prune();
    return {
      tracked: this.entries.size,
      pending: [...this.entries.values()].filter(
        (entry) => entry.finishedAt === undefined,
      ).length,
      unavailable: this.unavailable,
      capacity: this.options.capacity ?? 1024,
    };
  }
}

const processState = globalThis as typeof globalThis & {
  __reviewOperationReceipts?: ReviewOperationReceipts;
};
export function reviewOperationReceipts(): ReviewOperationReceipts {
  return (processState.__reviewOperationReceipts ??=
    new ReviewOperationReceipts());
}
export function reviewOperationScope(
  browsePath: string,
  datasetKey: string,
): string {
  return JSON.stringify([browsePath, datasetKey]);
}

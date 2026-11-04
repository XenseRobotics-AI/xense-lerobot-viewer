import { isReviewOperationId } from "./review-diagnostics.types";
import type { EpisodeReviewsFile, ReviewUpdate } from "./episode-review.types";

export interface ReviewOperationReceipt {
  operation_id: string;
  episode_index: number;
  reviewer: string;
  reviewed: boolean;
  source?: ReviewUpdate["source"];
  stay_ms?: number;
  episode_duration_ms?: number;
  state: "pending" | "succeeded" | "failed";
}
export type PendingReviewOperation = ReviewUpdate & { operation_id: string };
export type DurableReviewOperationReceipt = ReviewOperationReceipt & {
  source: ReviewUpdate["source"];
  state: "succeeded" | "failed";
};
export const MAX_DURABLE_REVIEW_RECEIPTS = 4096;

export function reviewReceiptMatches(
  receipt: ReviewOperationReceipt,
  target: PendingReviewOperation,
): boolean {
  return (
    receipt.operation_id === target.operation_id &&
    receipt.episode_index === target.episode_index &&
    receipt.reviewer === target.reviewer &&
    receipt.reviewed === target.reviewed &&
    // Older servers sent identity-only transient receipts.
    (receipt.source === undefined ||
      (receipt.source === target.source &&
        receipt.stay_ms === target.stay_ms &&
        receipt.episode_duration_ms === target.episode_duration_ms))
  );
}
export function parseReviewOperationReceipt(
  input: unknown,
): ReviewOperationReceipt | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (
    !isReviewOperationId(value.operation_id) ||
    !Number.isSafeInteger(value.episode_index) ||
    (value.episode_index as number) < 0 ||
    typeof value.reviewer !== "string" ||
    !value.reviewer ||
    value.reviewer !== value.reviewer.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.reviewer) ||
    value.reviewer.length > 80 ||
    typeof value.reviewed !== "boolean" ||
    (value.source !== undefined &&
      value.source !== "episodes" &&
      value.source !== "urdf") ||
    (value.stay_ms === undefined) !==
      (value.episode_duration_ms === undefined) ||
    (value.stay_ms !== undefined &&
      (!Number.isSafeInteger(value.stay_ms) ||
        (value.stay_ms as number) < 0 ||
        !Number.isSafeInteger(value.episode_duration_ms) ||
        (value.episode_duration_ms as number) < 0 ||
        !Number.isSafeInteger(2 * (value.episode_duration_ms as number)) ||
        (value.stay_ms as number) > 2 * (value.episode_duration_ms as number) ||
        !value.reviewed)) ||
    !["pending", "succeeded", "failed"].includes(value.state as string)
  )
    return undefined;
  return {
    operation_id: value.operation_id,
    episode_index: value.episode_index as number,
    reviewer: value.reviewer,
    reviewed: value.reviewed,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.stay_ms === undefined
      ? {}
      : {
          stay_ms: value.stay_ms as number,
          episode_duration_ms: value.episode_duration_ms as number,
        }),
    state: value.state as ReviewOperationReceipt["state"],
  };
}

/** A missing record alone never proves that an unmark has completed. */
export function reviewOperationResolution(
  file: EpisodeReviewsFile,
  target: PendingReviewOperation,
  receipt?: ReviewOperationReceipt,
): "succeeded" | "failed" | "pending" | "unknown" {
  const durable = file.operation_receipts?.find((entry) =>
    reviewReceiptMatches(entry, target),
  );
  if (durable) return durable.state;
  if (
    target.reviewed &&
    file.episodes[String(target.episode_index)]?.some(
      (entry) =>
        entry.reviewer === target.reviewer &&
        entry.operation_id === target.operation_id &&
        entry.source === target.source &&
        entry.stay_ms === target.stay_ms &&
        entry.episode_duration_ms === target.episode_duration_ms,
    )
  )
    return "succeeded";
  if (!receipt || !reviewReceiptMatches(receipt, target)) return "unknown";
  return receipt.state;
}

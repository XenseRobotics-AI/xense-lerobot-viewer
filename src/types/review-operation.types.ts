import { isReviewOperationId } from "./review-diagnostics.types";
import type { EpisodeReviewsFile, ReviewUpdate } from "./episode-review.types";

export interface ReviewOperationReceipt {
  operation_id: string;
  episode_index: number;
  reviewer: string;
  reviewed: boolean;
  state: "pending" | "succeeded" | "failed";
}
export type PendingReviewOperation = ReviewUpdate & { operation_id: string };
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
    value.reviewer.length > 80 ||
    typeof value.reviewed !== "boolean" ||
    !["pending", "succeeded", "failed"].includes(value.state as string)
  )
    return undefined;
  return {
    operation_id: value.operation_id,
    episode_index: value.episode_index as number,
    reviewer: value.reviewer,
    reviewed: value.reviewed,
    state: value.state as ReviewOperationReceipt["state"],
  };
}

/** A missing record alone never proves that an unmark has completed. */
export function reviewOperationResolution(
  file: EpisodeReviewsFile,
  target: PendingReviewOperation,
  receipt?: ReviewOperationReceipt,
): "succeeded" | "failed" | "pending" | "unknown" {
  if (
    target.reviewed &&
    file.episodes[String(target.episode_index)]?.some(
      (entry) =>
        entry.reviewer === target.reviewer &&
        entry.operation_id === target.operation_id,
    )
  )
    return "succeeded";
  if (
    receipt?.operation_id !== target.operation_id ||
    receipt.episode_index !== target.episode_index ||
    receipt.reviewer !== target.reviewer ||
    receipt.reviewed !== target.reviewed
  )
    return "unknown";
  return receipt.state;
}

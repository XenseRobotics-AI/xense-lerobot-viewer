import { reviewTimestamp } from "@/utils/reviewTime";

export const REVIEW_FILENAME = "episode-reviews.json";
export const MAX_REVIEWER_LENGTH = 80;

export type ReviewerRole = "inspector" | "admin" | "developer";
export interface ReviewerProfile {
  name: string;
  role: ReviewerRole;
}
export const REVIEWER_ROLES: ReviewerRole[] = [
  "inspector",
  "admin",
  "developer",
];
export type ReviewFilter =
  | "all"
  | "reviewed"
  | "unreviewed"
  | "pending"
  | "crossReviewed"
  | "pendingMine"
  | "mine";

export type ReviewSource = "episodes" | "urdf";

export interface EpisodeReview {
  reviewer: string;
  reviewed_at: string;
  role?: ReviewerRole;
  source: ReviewSource;
}

export interface EpisodeReviewsFile {
  version: 1;
  episodes: Record<string, EpisodeReview[]>;
  updated_at?: string;
}

export interface ReviewCollectionFile {
  version: 1;
  datasets: Record<string, EpisodeReviewsFile>;
  updated_at?: string;
}

export interface EpisodeReviewsResponse {
  file: EpisodeReviewsFile;
  reviewers: string[];
  profiles: ReviewerProfile[];
  storage_path: string;
  dataset_key: string;
}

export interface ReviewUpdate {
  episode_index: number;
  reviewer: string;
  source: ReviewSource;
  reviewed: boolean;
  role?: ReviewerRole;
}

export function parseReviewUpdate(input: unknown): ReviewUpdate {
  if (!input || typeof input !== "object") {
    throw new Error("A review object is required");
  }
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.episode_index !== "number" ||
    !Number.isSafeInteger(raw.episode_index) ||
    raw.episode_index < 0
  ) {
    throw new Error("episode_index must be a non-negative safe integer");
  }
  if (
    typeof raw.reviewer !== "string" ||
    !raw.reviewer.trim() ||
    raw.reviewer.trim().length > MAX_REVIEWER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(raw.reviewer)
  ) {
    throw new Error(
      `reviewer must contain 1–${MAX_REVIEWER_LENGTH} characters without control characters`,
    );
  }
  if (raw.source !== "episodes" && raw.source !== "urdf") {
    throw new Error("source must be episodes or urdf");
  }
  if (typeof raw.reviewed !== "boolean") {
    throw new Error("reviewed must be a boolean");
  }
  return {
    episode_index: raw.episode_index,
    reviewer: raw.reviewer.trim(),
    source: raw.source,
    reviewed: raw.reviewed,
  };
}

/** Reject a damaged sidecar instead of silently overwriting existing reviews. */
export function parseReviewsFile(input: unknown): EpisodeReviewsFile {
  if (!input || typeof input !== "object")
    throw new Error("Invalid review file");
  const raw = input as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !raw.episodes ||
    typeof raw.episodes !== "object" ||
    Array.isArray(raw.episodes)
  )
    throw new Error("Invalid review file schema");
  const episodes: EpisodeReviewsFile["episodes"] = {};
  for (const [key, records] of Object.entries(raw.episodes)) {
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index) !== key ||
      !Array.isArray(records)
    ) {
      throw new Error("Invalid episode in review file");
    }
    const reviewers = new Set<string>();
    episodes[key] = records.map((record: unknown) => {
      if (!record || typeof record !== "object")
        throw new Error("Invalid review record");
      const entry = record as Record<string, unknown>;
      const validated = parseReviewUpdate({
        ...entry,
        episode_index: index,
        reviewed: true,
      });
      if (
        typeof entry.reviewed_at !== "string" ||
        !Number.isFinite(Date.parse(entry.reviewed_at)) ||
        reviewers.has(validated.reviewer)
      ) {
        throw new Error(
          "Invalid timestamp or duplicate reviewer in review file",
        );
      }
      if (
        entry.role !== undefined &&
        !REVIEWER_ROLES.includes(entry.role as ReviewerRole)
      )
        throw new Error("Invalid reviewer role in review file");
      reviewers.add(validated.reviewer);
      return {
        reviewer: validated.reviewer,
        source: validated.source,
        reviewed_at: reviewTimestamp(entry.reviewed_at),
        ...(entry.role ? { role: entry.role as ReviewerRole } : {}),
      };
    });
  }
  return {
    version: 1,
    episodes,
    ...(typeof raw.updated_at === "string"
      ? { updated_at: reviewTimestamp(raw.updated_at) }
      : {}),
  };
}

export function reviewerCounts(file: EpisodeReviewsFile): [string, number][] {
  const counts = new Map<string, number>();
  for (const reviews of Object.values(file.episodes)) {
    for (const review of reviews)
      counts.set(review.reviewer, (counts.get(review.reviewer) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

/** A second check only counts when it is made by a different person. */
export function reviewStatus(records: EpisodeReview[]) {
  const count = new Set(records.map((record) => record.reviewer)).size;
  return count === 0 ? "unchecked" : count === 1 ? "pending" : "crossReviewed";
}

export function matchesReviewFilter(
  records: EpisodeReview[],
  filter: ReviewFilter,
  reviewer: string,
): boolean {
  const status = reviewStatus(records);
  const mine = records.some((record) => record.reviewer === reviewer);
  switch (filter) {
    case "all":
      return true;
    case "reviewed":
      return status !== "unchecked";
    case "unreviewed":
      return status === "unchecked";
    case "pending":
      return status === "pending";
    case "crossReviewed":
      return status === "crossReviewed";
    case "pendingMine":
      return !!reviewer && status !== "unchecked" && !mine;
    case "mine":
      return mine;
  }
}

export function reviewCollectionSummary(collection: ReviewCollectionFile) {
  let inspected = 0,
    pending = 0,
    crossReviewed = 0,
    records = 0;
  const people = new Map<
    string,
    { reviewer: string; inspected: number; crossReviewed: number }
  >();
  let datasets = 0;
  for (const file of Object.values(collection.datasets)) {
    if (Object.values(file.episodes).some((entries) => entries.length))
      datasets++;
    for (const entries of Object.values(file.episodes)) {
      const status = reviewStatus(entries);
      if (status === "unchecked") continue;
      inspected++;
      if (status === "pending") pending++;
      else crossReviewed++;
      records += entries.length;
      for (const entry of entries) {
        const person = people.get(entry.reviewer) ?? {
          reviewer: entry.reviewer,
          inspected: 0,
          crossReviewed: 0,
        };
        person.inspected++;
        if (status === "crossReviewed") person.crossReviewed++;
        people.set(entry.reviewer, person);
      }
    }
  }
  return {
    datasets,
    inspected,
    pending,
    crossReviewed,
    records,
    people: [...people.values()].sort((a, b) =>
      a.reviewer.localeCompare(b.reviewer),
    ),
  };
}

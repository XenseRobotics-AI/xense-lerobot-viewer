import { reviewTimestamp } from "@/utils/reviewTime";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireReviewWriteLock,
  ReviewWriteLockError,
} from "@/lib/review-write-lock";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import {
  REVIEW_FILENAME,
  REVIEWER_ROLES,
  parseReviewsFile,
  parseReviewUpdate,
  type EpisodeReviewsFile,
  type ReviewCollectionFile,
  type ReviewUpdate,
} from "@/types/episode-review.types";

export class ReviewStoreError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function reviewsFilePath(browsePath: string): string {
  return path.join(browsePath, ".xense-viewer", REVIEW_FILENAME);
}

export async function reviewDatasetKey(
  browsePath: string,
  datasetPath: string,
): Promise<string> {
  const [root, dataset] = await Promise.all([
    fs.realpath(browsePath),
    fs.realpath(datasetPath),
  ]);
  if (dataset !== root && !isInsideRoot(root, dataset))
    throw new ReviewStoreError(
      "Dataset is outside the selected browse directory; open it from the dataset list",
      400,
    );
  const info = await fs.realpath(path.join(dataset, "meta", "info.json"));
  if (!isInsideRoot(dataset, info) || !(await fs.stat(info)).isFile())
    throw new ReviewStoreError("Invalid dataset metadata path", 400);
  return path.relative(root, dataset).split(path.sep).join("/") || ".";
}

async function reviewPath(
  browsePath: string,
  create: boolean,
): Promise<string> {
  const root = await fs.realpath(browsePath);
  const dir = path.join(root, ".xense-viewer");
  if (create) await fs.mkdir(dir, { recursive: true });
  try {
    if (!isInsideRoot(root, await fs.realpath(dir)))
      throw new ReviewStoreError(
        "Review storage escapes browse directory",
        400,
      );
    try {
      if ((await fs.lstat(path.join(dir, REVIEW_FILENAME))).isSymbolicLink())
        throw new ReviewStoreError("Review file cannot be a symlink", 400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path.join(dir, REVIEW_FILENAME);
}

async function readFile(target: string): Promise<ReviewCollectionFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, datasets: Object.create(null) };
    throw error;
  }
  const input = raw as Partial<ReviewCollectionFile> | null;
  if (
    !input ||
    input.version !== 1 ||
    !input.datasets ||
    typeof input.datasets !== "object" ||
    Array.isArray(input.datasets)
  )
    throw new Error("Invalid review collection file");
  const datasets: ReviewCollectionFile["datasets"] = Object.create(null);
  for (const [key, file] of Object.entries(input.datasets)) {
    if (
      key !== "." &&
      (!key ||
        path.isAbsolute(key) ||
        key.split("/").some((part) => !part || part === ".." || part === "."))
    )
      throw new Error("Invalid dataset key in review collection");
    datasets[key] = parseReviewsFile(file);
  }
  return {
    version: 1,
    datasets,
    ...(typeof input.updated_at === "string"
      ? { updated_at: reviewTimestamp(input.updated_at) }
      : {}),
  };
}

export async function readReviewCollection(
  browsePath: string,
): Promise<ReviewCollectionFile> {
  return readFile(await reviewPath(browsePath, false));
}

export async function readEpisodeReviews(
  browsePath: string,
  datasetPath: string,
): Promise<EpisodeReviewsFile> {
  const key = await reviewDatasetKey(browsePath, datasetPath);
  return (
    (await readReviewCollection(browsePath)).datasets[key] ?? {
      version: 1,
      episodes: {},
    }
  );
}

export async function updateEpisodeReview(
  browsePath: string,
  datasetPath: string,
  input: ReviewUpdate,
): Promise<EpisodeReviewsFile> {
  const update = parseReviewUpdate(input);
  if (input.role !== undefined && !REVIEWER_ROLES.includes(input.role))
    throw new ReviewStoreError("Invalid reviewer role", 400);
  const datasetKey = await reviewDatasetKey(browsePath, datasetPath);
  const target = await reviewPath(browsePath, true);
  let lock;
  try {
    lock = await acquireReviewWriteLock(target);
  } catch (error) {
    if (error instanceof ReviewWriteLockError)
      throw new ReviewStoreError(error.message, error.status);
    throw error;
  }
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    const collection = await readFile(target);
    const file = collection.datasets[datasetKey] ?? {
      version: 1,
      episodes: {},
    };
    const key = String(update.episode_index);
    const records = file.episodes[key] ?? [];
    const existing = records.some(
      (entry) => entry.reviewer === update.reviewer,
    );
    // Repeating the same action is idempotent; keep the original check time.
    if (existing === update.reviewed) return file;
    const now = reviewTimestamp();
    const next = records.filter((entry) => entry.reviewer !== update.reviewer);
    if (update.reviewed)
      next.push({
        reviewer: update.reviewer,
        reviewed_at: now,
        source: update.source,
        ...(input.role ? { role: input.role } : {}),
      });
    if (next.length) file.episodes[key] = next;
    else delete file.episodes[key];
    file.updated_at = now;
    collection.datasets[datasetKey] = file;
    collection.updated_at = now;
    await fs.writeFile(tmp, JSON.stringify(collection, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    lock.assertHeld();
    await fs.rename(tmp, target);
    return file;
  } finally {
    await fs.rm(tmp, { force: true }).finally(() => lock.release());
  }
}

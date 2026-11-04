import { reviewTimestamp } from "@/utils/reviewTime";
import type {
  ReviewStoreStage,
  ReviewStoreTrace,
} from "@/types/review-diagnostics.types";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireReviewWriteLock,
  ReviewWriteLockError,
} from "@/lib/review-write-lock";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import {
  MAX_DURABLE_REVIEW_RECEIPTS,
  findReviewOperation,
  reviewReceiptMatches,
} from "@/types/review-operation.types";
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
    public code?: string,
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
  let receiptCount = 0;
  for (const [key, file] of Object.entries(input.datasets)) {
    if (
      key !== "." &&
      (!key ||
        path.isAbsolute(key) ||
        key.split("/").some((part) => !part || part === ".." || part === "."))
    )
      throw new Error("Invalid dataset key in review collection");
    datasets[key] = parseReviewsFile(file);
    receiptCount += datasets[key].operation_receipts?.length ?? 0;
    if (receiptCount > MAX_DURABLE_REVIEW_RECEIPTS)
      throw new Error("Review collection operation history exceeds capacity");
  }
  return {
    version: 1,
    datasets,
    ...(typeof input.updated_at === "string"
      ? { updated_at: reviewTimestamp(input.updated_at) }
      : {}),
  };
}

function storeOperationReceipt(
  collection: ReviewCollectionFile,
  datasetKey: string,
  file: EpisodeReviewsFile,
  update: ReviewUpdate,
  state: "succeeded" | "failed",
): void {
  if (!update.operation_id) return;
  const receipts = (file.operation_receipts ?? []).filter(
    (receipt) => receipt.operation_id !== update.operation_id,
  );
  receipts.push({
    operation_id: update.operation_id,
    episode_index: update.episode_index,
    reviewer: update.reviewer,
    reviewed: update.reviewed,
    source: update.source,
    ...(update.stay_ms === undefined
      ? {}
      : {
          stay_ms: update.stay_ms,
          episode_duration_ms: update.episode_duration_ms,
        }),
    state,
  });
  file.operation_receipts = receipts.slice(-MAX_DURABLE_REVIEW_RECEIPTS);
  collection.datasets[datasetKey] = file;
  let excess =
    Object.values(collection.datasets).reduce(
      (count, dataset) => count + (dataset.operation_receipts?.length ?? 0),
      0,
    ) - MAX_DURABLE_REVIEW_RECEIPTS;
  // Keep the active dataset's newest evidence. Other datasets are visited in
  // persisted key order; this is bounded retention, not a global time FIFO.
  for (const [key, dataset] of Object.entries(collection.datasets)) {
    if (excess <= 0) break;
    if (key === datasetKey || !dataset.operation_receipts?.length) continue;
    const remove = Math.min(excess, dataset.operation_receipts.length);
    dataset.operation_receipts = dataset.operation_receipts.slice(remove);
    excess -= remove;
  }
}

function matchingReceipt(file: EpisodeReviewsFile, update: ReviewUpdate) {
  return findReviewOperation(file, update.operation_id);
}

function sameOperation(
  receipt: NonNullable<EpisodeReviewsFile["operation_receipts"]>[number],
  update: ReviewUpdate,
): boolean {
  return (
    !!update.operation_id &&
    reviewReceiptMatches(receipt, {
      ...update,
      operation_id: update.operation_id,
    })
  );
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
  trace?: ReviewStoreTrace,
): Promise<EpisodeReviewsFile> {
  const phase = async <T>(
    stage: ReviewStoreStage,
    work: () => Promise<T>,
  ): Promise<T> => {
    const started = performance.now();
    if (trace) trace.phase = stage;
    try {
      return await work();
    } catch (error) {
      if (trace && !trace.failed_phase) trace.failed_phase = stage;
      throw error;
    } finally {
      if (trace)
        trace.timings[stage] =
          Math.round((performance.now() - started) * 100) / 100;
    }
  };
  const update = parseReviewUpdate(input);
  if (input.role !== undefined && !REVIEWER_ROLES.includes(input.role))
    throw new ReviewStoreError("Invalid reviewer role", 400);
  const datasetKey = await reviewDatasetKey(browsePath, datasetPath);
  const target = await reviewPath(browsePath, true);
  let lock;
  try {
    lock = await phase("lock_wait", () => acquireReviewWriteLock(target));
  } catch (error) {
    if (error instanceof ReviewWriteLockError)
      throw new ReviewStoreError(error.message, error.status, error.code);
    throw error;
  }
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    const collection = await phase("read", () => readFile(target));
    const file = collection.datasets[datasetKey] ?? {
      version: 1,
      episodes: {},
    };
    const previousReceipt = matchingReceipt(file, update);
    if (previousReceipt) {
      if (!sameOperation(previousReceipt, update))
        throw new ReviewStoreError(
          "operation_id already belongs to another action",
          409,
        );
      if (previousReceipt.state === "failed")
        throw new ReviewStoreError(
          "Operation already ended with an error; verify its outcome",
          409,
        );
      if (trace) trace.unchanged = true;
      return file;
    }
    const key = String(update.episode_index);
    const records = file.episodes[key] ?? [];
    const existingRecord = records.find(
      (entry) => entry.reviewer === update.reviewer,
    );
    const existing = !!existingRecord;
    // Repeating the same action is idempotent; keep the original check time.
    if (existing === update.reviewed) {
      if (
        !existingRecord ||
        existingRecord.stay_ms !== undefined ||
        update.stay_ms === undefined
      ) {
        if (trace) trace.unchanged = true;
        if (!update.operation_id) return file;
        storeOperationReceipt(
          collection,
          datasetKey,
          file,
          update,
          "succeeded",
        );
        collection.datasets[datasetKey] = file;
        await phase("write", () =>
          fs.writeFile(tmp, JSON.stringify(collection, null, 2) + "\n", {
            encoding: "utf8",
            flag: "wx",
          }),
        );
        await phase("commit", async () => {
          await lock.assertHeld();
          await fs.rename(tmp, target);
          if (trace) trace.committed = true;
        });
        return file;
      }
      file.episodes[key] = records.map((entry) =>
        entry.reviewer === update.reviewer
          ? {
              ...entry,
              stay_ms: update.stay_ms,
              episode_duration_ms: update.episode_duration_ms,
              ...(update.operation_id
                ? { operation_id: update.operation_id }
                : {}),
            }
          : entry,
      );
      storeOperationReceipt(collection, datasetKey, file, update, "succeeded");
      const now = reviewTimestamp();
      file.updated_at = now;
      collection.datasets[datasetKey] = file;
      collection.updated_at = now;
      await phase("write", () =>
        fs.writeFile(tmp, JSON.stringify(collection, null, 2) + "\n", {
          encoding: "utf8",
          flag: "wx",
        }),
      );
      await phase("commit", async () => {
        await lock.assertHeld();
        await fs.rename(tmp, target);
        if (trace) trace.committed = true;
      });
      return file;
    }
    const now = reviewTimestamp();
    const next = records.filter((entry) => entry.reviewer !== update.reviewer);
    if (update.reviewed)
      next.push({
        reviewer: update.reviewer,
        reviewed_at: now,
        source: update.source,
        ...(update.operation_id ? { operation_id: update.operation_id } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(update.stay_ms !== undefined
          ? {
              stay_ms: update.stay_ms,
              episode_duration_ms: update.episode_duration_ms,
            }
          : {}),
      });
    if (next.length) file.episodes[key] = next;
    else delete file.episodes[key];
    storeOperationReceipt(collection, datasetKey, file, update, "succeeded");
    file.updated_at = now;
    collection.datasets[datasetKey] = file;
    collection.updated_at = now;
    await phase("write", () =>
      fs.writeFile(tmp, JSON.stringify(collection, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
      }),
    );
    await phase("commit", async () => {
      await lock.assertHeld();
      await fs.rename(tmp, target);
      if (trace) trace.committed = true;
    });
    return file;
  } finally {
    await phase("cleanup", () =>
      fs.rm(tmp, { force: true }).finally(() => lock.release()),
    );
  }
}

/** Persist a terminal rejection without changing review records. */
export async function persistFailedReviewOperation(
  browsePath: string,
  datasetPath: string,
  input: ReviewUpdate,
): Promise<void> {
  const update = parseReviewUpdate(input);
  if (!update.operation_id) return;
  const datasetKey = await reviewDatasetKey(browsePath, datasetPath);
  const target = await reviewPath(browsePath, true);
  const lock = await acquireReviewWriteLock(target);
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    const collection = await readFile(target);
    const file = collection.datasets[datasetKey] ?? {
      version: 1,
      episodes: {},
    };
    const existing = matchingReceipt(file, update);
    if (existing) {
      if (!sameOperation(existing, update))
        throw new ReviewStoreError(
          "operation_id already belongs to another action",
          409,
        );
      return;
    }
    storeOperationReceipt(collection, datasetKey, file, update, "failed");
    collection.datasets[datasetKey] = file;
    await fs.writeFile(tmp, JSON.stringify(collection, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await lock.assertHeld();
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).finally(() => lock.release());
  }
}

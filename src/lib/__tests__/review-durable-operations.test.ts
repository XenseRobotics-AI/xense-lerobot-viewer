import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/local-datasets/[encodedPath]/reviews/route";
import {
  ReviewOperationReceipts,
  reviewOperationScope,
} from "../review-operation-receipts";
import {
  readEpisodeReviews,
  reviewsFilePath,
  updateEpisodeReview,
  persistFailedReviewOperation,
  reviewDatasetKey,
} from "../episode-reviews-store";
import { writeLocations } from "../dataset-locations-store";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import {
  clientReviewDiagnostics,
  saveReviewWithDeadline,
} from "@/utils/reviewDiagnosticsClient";
import {
  parseReviewsFile,
  type ReviewCollectionFile,
  type ReviewUpdate,
} from "@/types/episode-review.types";
import { reviewOperationResolution } from "@/types/review-operation.types";

const processState = globalThis as typeof globalThis & {
  __reviewOperationReceipts?: ReviewOperationReceipts;
};
let root: string,
  dataset: string,
  other: string,
  previousRoot: string | undefined;
let previousReceipts: ReviewOperationReceipts | undefined;
const action = (reviewed = true) => ({
  episode_index: 0,
  reviewer: "Alice",
  source: "episodes" as const,
  reviewed,
  operation_id: crypto.randomUUID(),
});
const restart = () => {
  processState.__reviewOperationReceipts = new ReviewOperationReceipts();
};
const context = (target = dataset) => ({
  params: Promise.resolve({ encodedPath: encodeLocalDatasetPath(target) }),
});
function request(method = "GET", body?: unknown, query = "") {
  return new NextRequest(
    "http://localhost/api/reviews?browsePath=" +
      encodeURIComponent(root) +
      query,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    },
  );
}
const send = (body: ReviewUpdate) => PUT(request("PUT", body), context());
const readProof = (operationId: string, target = dataset) =>
  GET(
    request("GET", undefined, "&verify=1&operation_id=" + operationId),
    context(target),
  );
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-durable-"));
  dataset = path.join(root, "nested", "one");
  other = path.join(root, "nested", "two");
  for (const target of [dataset, other]) {
    await fs.mkdir(path.join(target, "meta"), { recursive: true });
    await fs.writeFile(
      path.join(target, "meta", "info.json"),
      JSON.stringify({ total_episodes: 4 }),
    );
  }
  await fs.mkdir(path.join(root, ".xense-viewer"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".xense-viewer", "reviewers.json"),
    JSON.stringify(["Alice", "Bob"]),
  );
  await writeLocations(root, []);
  previousRoot = process.env.LOCAL_DATASET_ROOT;
  process.env.LOCAL_DATASET_ROOT = root;
  previousReceipts = processState.__reviewOperationReceipts;
  restart();
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  processState.__reviewOperationReceipts = previousReceipts;
  await fs.rm(root, { recursive: true, force: true });
});

describe("durable review outcomes", () => {
  test("lost unmark responses reconcile after restart without replaying PUT", async () => {
    expect((await send(action())).status).toBe(200);
    const body = {
      ...action(false),
      diagnostics: clientReviewDiagnostics("unmark"),
    };
    let writes = 0;
    const fetcher = (async (url, init) => {
      const req = new NextRequest(String(url), init);
      if (init?.method === "PUT") {
        writes++;
        expect((await PUT(req, context())).status).toBe(200);
        restart();
        throw new TypeError("Lost response followed by process restart");
      }
      return GET(req, context());
    }) as typeof fetch;
    const file = await saveReviewWithDeadline(
      "http://localhost/api/reviews?browsePath=" + encodeURIComponent(root),
      body,
      { fetcher },
    );
    expect(file.episodes).toEqual({});
    expect(writes).toBe(1);
    const proof = await (await readProof(body.operation_id)).json();
    expect(proof.operation.state).toBe("succeeded");
    expect(reviewOperationResolution(file, body)).toBe("succeeded");
  });
  test("a no-op mark has its own durable outcome without replacing the original check", async () => {
    const original = action(),
      repeated = action();
    expect((await send(original)).status).toBe(200);
    expect((await send(repeated)).status).toBe(200);
    restart();
    const proof = await (await readProof(repeated.operation_id)).json();
    expect(proof.file.episodes["0"][0].operation_id).toBe(
      original.operation_id,
    );
    expect(proof.operation?.state).toBe("succeeded");
    expect(reviewOperationResolution(proof.file, repeated)).toBe("succeeded");
  });
  test("replaying a completed unmark after restart cannot delete a later mark", async () => {
    const unmark = action(false),
      later = action();
    expect((await send(action())).status).toBe(200);
    expect((await send(unmark)).status).toBe(200);
    expect((await send(later)).status).toBe(200);
    const before = await fs.readFile(reviewsFilePath(root), "utf8");
    restart();
    expect((await send(unmark)).status).toBe(200);
    expect(await fs.readFile(reviewsFilePath(root), "utf8")).toBe(before);
    expect(
      (await readEpisodeReviews(root, dataset)).episodes["0"][0].operation_id,
    ).toBe(later.operation_id);
  });
  test("restart cannot turn operation ID reuse into a different action or snapshot", async () => {
    const original = { ...action(), stay_ms: 0, episode_duration_ms: 1000 };
    expect((await send(original)).status).toBe(200);
    const before = await fs.readFile(reviewsFilePath(root), "utf8");
    for (const changed of [
      { ...original, source: "urdf" as const },
      { ...original, reviewer: "Bob" },
      { ...original, episode_index: 1 },
      { ...original, stay_ms: 1 },
      { ...original, episode_duration_ms: 2000 },
      { ...action(false), operation_id: original.operation_id },
    ]) {
      restart();
      expect((await send(changed)).status).toBe(409);
      expect(await fs.readFile(reviewsFilePath(root), "utf8")).toBe(before);
    }
  });
  test("concurrent stores with conflicting operation IDs commit only one action", async () => {
    const first = action(),
      second = { ...first, reviewed: false };
    const results = await Promise.allSettled([
      updateEpisodeReview(root, dataset, first),
      updateEpisodeReview(root, dataset, second),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? first : second;
    const loser = results[0].status === "fulfilled" ? second : first;
    const before = await fs.readFile(reviewsFilePath(root), "utf8");
    await persistFailedReviewOperation(root, dataset, winner);
    await expect(
      persistFailedReviewOperation(root, dataset, loser),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(reviewsFilePath(root), "utf8")).toBe(before);
    const stale = processState.__reviewOperationReceipts!.begin(
      reviewOperationScope(root, await reviewDatasetKey(root, dataset)),
      winner,
    );
    if (stale.state !== "started")
      throw new Error("Missing stale process fixture");
    stale.finish("failed");
    const proof = await (await readProof(first.operation_id)).json();
    expect(proof.operation?.state).toBe("succeeded");
    expect(!!proof.file.episodes["0"]?.length).toBe(proof.operation.reviewed);
  });
  test("roster failures remain terminal across restart without changing review records", async () => {
    const original = action();
    expect((await send(original)).status).toBe(200);
    const before = await readEpisodeReviews(root, dataset);
    await fs.writeFile(
      path.join(root, ".xense-viewer", "reviewers.json"),
      "{broken",
    );
    const failed = action(false);
    expect((await send(failed)).status).toBe(500);
    restart();
    const proof = await (await readProof(failed.operation_id)).json();
    expect(proof.operation?.state).toBe("failed");
    expect(proof.file.episodes).toEqual(before.episodes);
    expect(proof.file.updated_at).toBe(before.updated_at);
    expect((await GET(request(), context())).status).toBe(500);
    expect((await readProof(failed.operation_id, other)).status).toBe(200);
    expect(
      (await (await readProof(failed.operation_id, other)).json()).operation,
    ).toBeUndefined();
  });
  test("cache saturation still persists a terminal request failure across restart", async () => {
    processState.__reviewOperationReceipts = new ReviewOperationReceipts({
      capacity: 0,
    });
    await fs.writeFile(
      path.join(root, ".xense-viewer", "reviewers.json"),
      "{broken",
    );
    const failed = action(false);
    expect((await send(failed)).status).toBe(500);
    restart();
    const proof = await (await readProof(failed.operation_id)).json();
    expect(proof.operation?.state).toBe("failed");
    expect(proof.file.episodes).toEqual({});
    const persisted = await fs.readFile(reviewsFilePath(root), "utf8");
    expect((await send(failed)).status).toBe(409);
    expect(await fs.readFile(reviewsFilePath(root), "utf8")).toBe(persisted);
  });
  test("corrupt durable history is rejected rather than erased by a subsequent save", async () => {
    const body = action();
    const receipt = { ...body, state: "succeeded" };
    for (const operation_receipts of [
      [{ ...receipt, state: "pending" }],
      [{ ...receipt, source: "invalid" }],
      [{ ...receipt, reviewer: " Alice " }],
      [{ ...receipt, stay_ms: 1 }],
      [{ ...receipt, stay_ms: 3, episode_duration_ms: 1 }],
      [{ ...receipt, reviewed: false, stay_ms: 0, episode_duration_ms: 1 }],
      [receipt, receipt],
      Array(4097).fill(receipt),
    ]) {
      const raw = JSON.stringify({
        version: 1,
        datasets: {
          "nested/one": { version: 1, episodes: {}, operation_receipts },
        },
      });
      await fs.writeFile(reviewsFilePath(root), raw);
      await expect(
        updateEpisodeReview(root, dataset, action()),
      ).rejects.toThrow();
      expect(await fs.readFile(reviewsFilePath(root), "utf8")).toBe(raw);
    }
  });
  test.each(["succeeded", "failed"] as const)(
    "collection history stays bounded when a %s receipt is added across datasets",
    async (state) => {
      const history = () =>
        Array.from({ length: 2048 }, () => ({
          ...action(false),
          state: "succeeded" as const,
        }));
      const updated_at = "2026-11-03T08:00:00.000+08:00";
      const file = () => ({
        version: 1,
        updated_at,
        episodes: {
          "1": [
            { reviewer: "Bob", reviewed_at: updated_at, source: "episodes" },
          ],
        },
        operation_receipts: history(),
      });
      const datasets = { "nested/one": file(), "nested/two": file() };
      await fs.writeFile(
        reviewsFilePath(root),
        JSON.stringify({ version: 1, updated_at, datasets }),
      );
      const before = await readEpisodeReviews(root, other);
      const oldest = before.operation_receipts![0];
      const newest = action(false);
      if (state === "succeeded")
        await updateEpisodeReview(root, dataset, newest);
      else await persistFailedReviewOperation(root, dataset, newest);
      const collection = JSON.parse(
        await fs.readFile(reviewsFilePath(root), "utf8"),
      ) as ReviewCollectionFile;
      expect(
        Object.values(collection.datasets).reduce(
          (count, entry) => count + (entry.operation_receipts?.length ?? 0),
          0,
        ),
      ).toBe(4096);
      expect(collection.updated_at).toBe(updated_at);
      const after = await readEpisodeReviews(root, other);
      expect(after.episodes).toEqual(before.episodes);
      expect(after.updated_at).toBe(before.updated_at);
      expect(reviewOperationResolution(after, oldest)).toBe("unknown");
      const current = await readEpisodeReviews(root, dataset);
      expect(current.episodes).toEqual(datasets["nested/one"].episodes);
      expect(current.updated_at).toBe(updated_at);
      expect(reviewOperationResolution(current, newest)).toBe(state);
    },
  );
  test("oversized collection history is rejected without overwriting existing evidence", async () => {
    const history = () =>
      Array.from({ length: 2049 }, () => ({
        ...action(false),
        state: "succeeded",
      }));
    const raw = JSON.stringify({
      version: 1,
      datasets: {
        "nested/one": {
          version: 1,
          episodes: {},
          operation_receipts: history(),
        },
        "nested/two": {
          version: 1,
          episodes: {},
          operation_receipts: history(),
        },
      },
    });
    await fs.writeFile(reviewsFilePath(root), raw);
    await expect(
      updateEpisodeReview(root, dataset, action()),
    ).rejects.toThrow();
    await expect(
      persistFailedReviewOperation(root, dataset, action()),
    ).rejects.toThrow();
    expect(await fs.readFile(reviewsFilePath(root), "utf8")).toBe(raw);
  });
  test("history capacity preserves current records and evicted evidence stays unknown", async () => {
    const operation_receipts = Array.from({ length: 4096 }, () => ({
      ...action(false),
      state: "succeeded" as const,
    }));
    const oldest = operation_receipts[0];
    const file = { version: 1, episodes: {}, operation_receipts };
    expect(parseReviewsFile(file).operation_receipts).toHaveLength(4096);
    await fs.writeFile(
      reviewsFilePath(root),
      JSON.stringify({ version: 1, datasets: { "nested/one": file } }),
    );
    const newest = action();
    await updateEpisodeReview(root, dataset, newest);
    const after = await readEpisodeReviews(root, dataset);
    expect(after.operation_receipts).toHaveLength(4096);
    expect(
      after.operation_receipts?.some(
        (receipt) => receipt.operation_id === oldest.operation_id,
      ),
    ).toBe(false);
    expect(after.episodes["0"][0].operation_id).toBe(newest.operation_id);
    expect(reviewOperationResolution(after, oldest)).toBe("unknown");
  });
});

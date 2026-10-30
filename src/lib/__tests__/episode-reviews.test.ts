import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/local-datasets/[encodedPath]/reviews/route";
import {
  readReviewers,
  readReviewerProfiles,
  resolveReviewBrowsePath,
} from "../episode-review-scope";
import {
  readEpisodeReviews,
  readReviewCollection,
  reviewsFilePath,
  updateEpisodeReview,
} from "../episode-reviews-store";
import { writeLocations } from "../dataset-locations-store";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import {
  reviewStatus,
  matchesReviewFilter,
  reviewCollectionSummary,
  parseReviewsFile,
  parseReviewUpdate,
  reviewerCounts,
  type ReviewUpdate,
} from "@/types/episode-review.types";

import { GET as collectionGET } from "@/app/api/local-datasets/reviews/route";
import { reviewCollectionCsv } from "../episode-reviews-export";

let tmp: string;
let defaultRoot: string;
let browse: string;
let datasetA: string;
let datasetB: string;
let previousRoot: string | undefined;
let previousReviewers: string | undefined;
const mark: ReviewUpdate = {
  episode_index: 0,
  reviewer: "Alice",
  source: "episodes",
  reviewed: true,
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xense-reviews-"));
  defaultRoot = path.join(tmp, "default-root");
  browse = path.join(tmp, "selected-archive");
  datasetA = path.join(browse, "source", "dataset-a");
  datasetB = path.join(browse, "source", "dataset-b");
  for (const dataset of [datasetA, datasetB]) {
    await fs.mkdir(path.join(dataset, "meta"), { recursive: true });
    await fs.writeFile(
      path.join(dataset, "meta", "info.json"),
      JSON.stringify({ total_episodes: 300 }),
    );
  }
  await fs.mkdir(defaultRoot, { recursive: true });
  await writeLocations(defaultRoot, [
    { path: browse, addedAt: new Date().toISOString() },
  ]);
  previousRoot = process.env.LOCAL_DATASET_ROOT;
  previousReviewers = process.env.EPISODE_REVIEWERS;
  process.env.LOCAL_DATASET_ROOT = defaultRoot;
  process.env.EPISODE_REVIEWERS = "Ignored environment name";
  await roster([
    { name: "Alice", role: "inspector" },
    { name: "Bob", role: "admin" },
  ]);
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousReviewers === undefined) delete process.env.EPISODE_REVIEWERS;
  else process.env.EPISODE_REVIEWERS = previousReviewers;
  await fs.rm(tmp, { recursive: true, force: true });
});

function request(method = "GET", body?: unknown, extra = "") {
  return new NextRequest(
    "http://localhost/api/reviews?browsePath=" +
      encodeURIComponent(browse) +
      extra,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        cookie: "xense-browse-path=" + encodeURIComponent(defaultRoot),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
function context(dataset = datasetA) {
  return {
    params: Promise.resolve({ encodedPath: encodeLocalDatasetPath(dataset) }),
  };
}
async function roster(names: unknown) {
  await fs.mkdir(path.join(browse, ".xense-viewer"), { recursive: true });
  await fs.writeFile(
    path.join(browse, ".xense-viewer", "reviewers.json"),
    JSON.stringify(names),
  );
}

describe("collection review persistence", () => {
  test("reads empty state without creating a file or dataset sidecar", async () => {
    expect((await readEpisodeReviews(browse, datasetA)).episodes).toEqual({});
    expect(await fs.exists(reviewsFilePath(browse))).toBe(false);
    expect(await fs.readdir(path.join(datasetA, "meta"))).toEqual([
      "info.json",
    ]);
  });

  test("saves names, UTC+8 time and source under selected browse directory", async () => {
    const result = await updateEpisodeReview(browse, datasetA, mark);
    expect(result.episodes["0"][0]).toMatchObject({
      reviewer: "Alice",
      source: "episodes",
    });
    expect(result.episodes["0"][0].reviewed_at).toMatch(/^\d{4}-.*\+08:00$/);
    expect(Object.keys((await readReviewCollection(browse)).datasets)).toEqual([
      "source/dataset-a",
    ]);
    expect(await fs.exists(reviewsFilePath(defaultRoot))).toBe(false);
    expect(await fs.readdir(path.join(datasetA, "meta"))).toEqual([
      "info.json",
    ]);
    expect(await fs.exists(path.join(datasetA, ".xense-viewer"))).toBe(false);
  });

  test("same episode index in different datasets stays independent", async () => {
    await updateEpisodeReview(browse, datasetA, mark);
    await updateEpisodeReview(browse, datasetB, {
      ...mark,
      reviewer: "Bob",
      source: "urdf",
    });
    expect(
      (await readEpisodeReviews(browse, datasetA)).episodes["0"].map(
        (r) => r.reviewer,
      ),
    ).toEqual(["Alice"]);
    expect(
      (await readEpisodeReviews(browse, datasetB)).episodes["0"].map(
        (r) => r.reviewer,
      ),
    ).toEqual(["Bob"]);
  });

  test("shares a mark across tabs and repeated marks preserve original timestamp", async () => {
    const first = await updateEpisodeReview(browse, datasetA, mark);
    const replay = await updateEpisodeReview(browse, datasetA, {
      ...mark,
      source: "urdf",
    });
    expect(replay).toEqual(first);
    expect(replay.episodes["0"]).toHaveLength(1);
  });

  test("undo removes only selected inspector and keeps other episodes and datasets", async () => {
    await updateEpisodeReview(browse, datasetA, mark);
    await updateEpisodeReview(browse, datasetA, {
      ...mark,
      reviewer: "Bob",
      source: "urdf",
    });
    await updateEpisodeReview(browse, datasetA, { ...mark, episode_index: 1 });
    await updateEpisodeReview(browse, datasetB, mark);
    const result = await updateEpisodeReview(browse, datasetA, {
      ...mark,
      reviewed: false,
    });
    expect(result.episodes["0"].map((r) => r.reviewer)).toEqual(["Bob"]);
    expect(result.episodes["1"]).toHaveLength(1);
    expect(
      (await readEpisodeReviews(browse, datasetB)).episodes["0"],
    ).toHaveLength(1);
    const undone = await updateEpisodeReview(browse, datasetA, {
      ...mark,
      reviewer: "Bob",
      reviewed: false,
    });
    expect(undone.episodes["0"]).toBeUndefined();
  });

  test("concurrent writes merge inspectors across multiple datasets", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        updateEpisodeReview(browse, index % 2 ? datasetA : datasetB, {
          ...mark,
          reviewer: "Inspector " + index,
        }),
      ),
    );
    const collection = await readReviewCollection(browse);
    expect(collection.datasets["source/dataset-a"].episodes["0"]).toHaveLength(
      6,
    );
    expect(collection.datasets["source/dataset-b"].episodes["0"]).toHaveLength(
      6,
    );
    expect(
      (await fs.readdir(path.dirname(reviewsFilePath(browse)))).filter(
        (name) => name.includes(".tmp-") || name.endsWith(".lock"),
      ),
    ).toEqual([]);
  });

  test("corrupt JSON is preserved and a failed write releases the lock", async () => {
    await fs.mkdir(path.dirname(reviewsFilePath(browse)), { recursive: true });
    await fs.writeFile(reviewsFilePath(browse), "{broken");
    await expect(updateEpisodeReview(browse, datasetA, mark)).rejects.toThrow();
    expect(await fs.readFile(reviewsFilePath(browse), "utf8")).toBe("{broken");
    expect(await fs.exists(reviewsFilePath(browse) + ".lock")).toBe(false);
  });

  test("rejects datasets outside selected directory and escaping symlinks", async () => {
    await expect(
      updateEpisodeReview(defaultRoot, datasetA, mark),
    ).rejects.toThrow("outside");
    await fs.rm(path.join(browse, ".xense-viewer"), { recursive: true });
    await fs.symlink(defaultRoot, path.join(browse, ".xense-viewer"));
    await expect(updateEpisodeReview(browse, datasetA, mark)).rejects.toThrow(
      "escapes",
    );
    expect(
      await fs.exists(path.join(defaultRoot, "episode-reviews.json")),
    ).toBe(false);
  });

  test("rejects a symlinked review file without touching its target", async () => {
    await fs.mkdir(path.dirname(reviewsFilePath(browse)), { recursive: true });
    const external = path.join(defaultRoot, "untouched.json");
    await fs.writeFile(external, "unchanged");
    await fs.symlink(external, reviewsFilePath(browse));
    await expect(updateEpisodeReview(browse, datasetA, mark)).rejects.toThrow(
      "symlink",
    );
    expect(await fs.readFile(external, "utf8")).toBe("unchanged");
  });
});

describe("preset inspectors and selected scope", () => {
  test("reads collection roster afresh and normalizes names", async () => {
    expect(await readReviewers(browse)).toEqual(["Alice", "Bob"]);
    await roster([" 李明 ", "王芳", "李明"]);
    expect(await readReviewers(browse)).toEqual(["李明", "王芳"]);
  });
  test("refuses malformed rosters and control characters without inventing names", async () => {
    await roster(["Alice\nBob"]);
    await expect(readReviewers(browse)).rejects.toThrow();
    await roster({ reviewers: ["Alice"] });
    await expect(readReviewers(browse)).rejects.toThrow();
    await roster([]);
    expect(await readReviewers(browse)).toEqual([]);
  });
  test("pins registered browse selection and refuses stale paths rather than using default", async () => {
    expect(await resolveReviewBrowsePath(browse)).toBe(browse);
    expect(await resolveReviewBrowsePath()).toBe(defaultRoot);
    await expect(
      resolveReviewBrowsePath(path.join(tmp, "unregistered")),
    ).rejects.toThrow("no longer registered");
  });
});

describe("review API", () => {
  test("GET returns presets, record path and dataset key; explicit scope wins over cookie", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      reviewers: ["Alice", "Bob"],
      storage_path: reviewsFilePath(browse),
      dataset_key: "source/dataset-a",
      file: { version: 1, episodes: {} },
    });
  });
  test("PUT persists a preset inspector and GET sees it from either entry", async () => {
    const saved = await PUT(
      request("PUT", { ...mark, source: "urdf" }),
      context(),
    );
    expect(saved.status).toBe(200);
    const response = await GET(request(), context());
    const payload = await response.json();
    expect(payload.file.episodes["0"][0]).toMatchObject({
      reviewer: "Alice",
      source: "urdf",
    });
  });
  test("rejects arbitrary inspectors and invalid payloads without creating records", async () => {
    for (const body of [
      null,
      [],
      { ...mark, reviewer: "Unknown" },
      { ...mark, reviewer: "" },
      { ...mark, episode_index: -1 },
      { ...mark, episode_index: 1.2 },
      { ...mark, source: "unknown" },
      { ...mark, reviewed: "true" },
    ]) {
      expect((await PUT(request("PUT", body), context())).status).toBe(400);
    }
    expect(await fs.exists(reviewsFilePath(browse))).toBe(false);
  });
  test("empty roster disables writing", async () => {
    await roster([]);
    expect((await PUT(request("PUT", mark), context())).status).toBe(400);
  });
  test("exports the entire selected collection with separate dataset keys", async () => {
    await updateEpisodeReview(browse, datasetA, mark);
    await updateEpisodeReview(browse, datasetB, { ...mark, source: "urdf" });
    const response = await GET(
      request("GET", undefined, "&download=1"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(Object.keys((await response.json()).datasets)).toEqual([
      "source/dataset-a",
      "source/dataset-b",
    ]);
  });
  test("storage errors are reported instead of returning success", async () => {
    await fs.mkdir(path.dirname(reviewsFilePath(browse)), { recursive: true });
    await fs.writeFile(reviewsFilePath(browse), "broken");
    expect((await PUT(request("PUT", mark), context())).status).toBe(500);
    expect((await GET(request(), context())).status).toBe(500);
  });
});

describe("review schema and counts", () => {
  test("rejects unsafe indices, empty names and oversized names", () => {
    for (const input of [
      { ...mark, episode_index: Number.MAX_SAFE_INTEGER + 1 },
      { ...mark, reviewer: " " },
      { ...mark, reviewer: "a".repeat(81) },
      { ...mark, reviewer: "Alice\nBob" },
    ])
      expect(() => parseReviewUpdate(input)).toThrow();
    expect(parseReviewUpdate({ ...mark, reviewer: " Alice " }).reviewer).toBe(
      "Alice",
    );
  });
  test("rejects corrupt records and counts unique episode checks per inspector", () => {
    const record = {
      reviewer: "Alice",
      reviewed_at: "2026-10-29T08:00:00.000Z",
      source: "episodes",
    };
    const file = parseReviewsFile({
      version: 1,
      episodes: {
        "0": [record],
        "1": [record, { ...record, reviewer: "Bob", source: "urdf" }],
      },
    });
    expect(reviewerCounts(file)).toEqual([
      ["Alice", 2],
      ["Bob", 1],
    ]);
    expect(() =>
      parseReviewsFile({ version: 1, episodes: { "0": [record, record] } }),
    ).toThrow();
    expect(() =>
      parseReviewsFile({
        version: 1,
        episodes: { "0": [{ ...record, reviewed_at: "invalid" }] },
      }),
    ).toThrow();
  });
});

describe("local roster and cross-person review", () => {
  test("missing local roster does not use code defaults or environment fallback", async () => {
    await fs.unlink(path.join(browse, ".xense-viewer", "reviewers.json"));
    expect(await readReviewerProfiles(browse)).toEqual([]);
    expect((await PUT(request("PUT", mark), context())).status).toBe(400);
    expect((await GET(request(), context())).status).toBe(200);
  });
  test("each request uses its own directory and observes edited/deleted configuration", async () => {
    await fs.writeFile(
      path.join(defaultRoot, ".xense-viewer", "reviewers.json"),
      JSON.stringify([{ name: "Root person", role: "developer" }]),
    );
    expect(await readReviewers(defaultRoot)).toEqual(["Root person"]);
    expect(await readReviewers(browse)).toEqual(["Alice", "Bob"]);
    await roster([{ name: "Replacement", role: "admin" }]);
    const next = await GET(request(), context());
    expect((await next.json()).profiles).toEqual([
      { name: "Replacement", role: "admin" },
    ]);
    expect((await PUT(request("PUT", mark), context())).status).toBe(400);
    await fs.unlink(path.join(browse, ".xense-viewer", "reviewers.json"));
    expect(await readReviewers(browse)).toEqual([]);
    expect(await readReviewers(defaultRoot)).toEqual(["Root person"]);
  });
  test("accepts role objects and legacy lists, rejecting conflicting or invalid roles", async () => {
    await roster([
      { name: "Bob", role: "admin" },
      { name: "新质检员", role: "inspector" },
    ]);
    expect((await readReviewerProfiles(browse))[0]).toEqual({
      name: "Bob",
      role: "admin",
    });
    await roster(["Bob", "New"]);
    expect(await readReviewerProfiles(browse)).toEqual([
      { name: "Bob", role: "inspector" },
      { name: "New", role: "inspector" },
    ]);
    for (const bad of [
      [{ name: "Alice", role: "owner" }],
      [
        { name: "Alice", role: "admin" },
        { name: "Alice", role: "inspector" },
      ],
      [null],
      [7],
    ]) {
      await roster(bad);
      await expect(readReviewerProfiles(browse)).rejects.toThrow();
    }
  });
  test("server records roster role and ignores a forged client role", async () => {
    delete process.env.EPISODE_REVIEWERS;
    const response = await PUT(
      request("PUT", { ...mark, reviewer: "Alice", role: "admin" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).episodes["0"][0]).toMatchObject({
      reviewer: "Alice",
      role: "inspector",
    });
    const second = await PUT(
      request("PUT", { ...mark, reviewer: "Bob", source: "urdf" }),
      context(),
    );
    const file = await second.json();
    expect(file.episodes["0"][1].role).toBe("admin");
    expect(reviewStatus(file.episodes["0"])).toBe("crossReviewed");
    const undo = await PUT(
      request("PUT", { ...mark, reviewer: "Bob", reviewed: false }),
      context(),
    );
    expect(reviewStatus((await undo.json()).episodes["0"])).toBe("pending");
  });
  test("distinct people determine status, own-review filters, and collection statistics", async () => {
    const one = (await updateEpisodeReview(browse, datasetA, mark)).episodes[
      "0"
    ];
    expect(reviewStatus([])).toBe("unchecked");
    expect(reviewStatus([one[0], one[0]])).toBe("pending");
    expect(matchesReviewFilter(one, "pendingMine", "Bob")).toBe(true);
    expect(matchesReviewFilter(one, "pendingMine", "Alice")).toBe(false);
    expect(matchesReviewFilter(one, "pendingMine", "")).toBe(false);
    expect(matchesReviewFilter(one, "mine", "Alice")).toBe(true);
    expect(matchesReviewFilter(one, "pending", "Alice")).toBe(true);
    expect(matchesReviewFilter(one, "crossReviewed", "Alice")).toBe(false);
    await updateEpisodeReview(browse, datasetA, {
      ...mark,
      reviewer: "Bob",
      source: "urdf",
    });
    await updateEpisodeReview(browse, datasetB, mark);
    const summary = reviewCollectionSummary(await readReviewCollection(browse));
    expect(summary).toMatchObject({
      datasets: 2,
      inspected: 2,
      pending: 1,
      crossReviewed: 1,
      records: 3,
    });
    expect(summary.people).toEqual([
      { reviewer: "Alice", inspected: 2, crossReviewed: 1 },
      { reviewer: "Bob", inspected: 1, crossReviewed: 1 },
    ]);
  });
  test("reads old records without a role and rejects damaged role fields", () => {
    const record = {
      reviewer: "Alice",
      source: "episodes",
      reviewed_at: "2026-10-29T08:00:00Z",
    };
    expect(
      parseReviewsFile({ version: 1, episodes: { "0": [record] } }).episodes[
        "0"
      ][0],
    ).toEqual({ ...record, reviewed_at: "2026-10-29T16:00:00.000+08:00" });
    expect(() =>
      parseReviewsFile({
        version: 1,
        episodes: { "0": [{ ...record, role: "owner" }] },
      }),
    ).toThrow();
  });
});

describe("homepage collection exports", () => {
  test("empty overview requires no dataset and creates no record file", async () => {
    const response = await collectionGET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      storage_path: reviewsFilePath(browse),
      summary: { datasets: 0, inspected: 0, records: 0 },
    });
    expect(await fs.exists(reviewsFilePath(browse))).toBe(false);
  });
  test("homepage exports JSON and CSV from the explicit current browse directory", async () => {
    await updateEpisodeReview(browse, datasetA, mark);
    await updateEpisodeReview(browse, datasetA, {
      ...mark,
      reviewer: "Bob",
      source: "urdf",
      role: "admin",
    });
    await updateEpisodeReview(browse, datasetB, mark);
    const json = await collectionGET(request("GET", undefined, "&format=json"));
    expect(json.headers.get("Content-Disposition")).toContain("attachment");
    expect(Object.keys((await json.json()).datasets)).toEqual([
      "source/dataset-a",
      "source/dataset-b",
    ]);
    const csv = await collectionGET(request("GET", undefined, "&format=csv"));
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain('"管理员"');
    expect(text).toContain("检查时间（UTC+8）");
    expect(text).toContain("+08:00");
    expect(text).toContain('"3D REPLAY"');
    expect(text).toContain('"已交叉复检"');
    expect(text.trim().split("\r\n")).toHaveLength(4);
    expect(await fs.exists(reviewsFilePath(defaultRoot))).toBe(false);
  });
  test("exports escape CSV and neutralize spreadsheet formula injection", () => {
    const csv = reviewCollectionCsv({
      version: 1,
      datasets: {
        '=DATA,"set"': {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: " @SUM(A1)",
                source: "episodes",
                reviewed_at: "2026-10-29T08:00:00Z",
              },
            ],
          },
        },
      },
    });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"\'=DATA,""set"""');
    expect(csv).toContain('"\' @SUM(A1)"');
  });
  test("stale directories and corrupt records report failure without fallback exports", async () => {
    const stale = new NextRequest(
      "http://localhost/api/local-datasets/reviews?browsePath=" +
        encodeURIComponent(tmp + "/unregistered"),
    );
    expect((await collectionGET(stale)).ok).toBe(false);
    await fs.mkdir(path.dirname(reviewsFilePath(browse)), { recursive: true });
    await fs.writeFile(reviewsFilePath(browse), "{corrupt");
    expect(
      (await collectionGET(request("GET", undefined, "&format=csv"))).status,
    ).toBe(500);
    expect(await fs.readFile(reviewsFilePath(browse), "utf8")).toBe("{corrupt");
  });
});

test("historical UTC records and JSON exports use UTC+8 without rewriting on read", async () => {
  const old = {
    version: 1,
    datasets: {
      "source/dataset-a": {
        version: 1,
        episodes: {
          "0": [
            {
              reviewer: "Alice",
              source: "episodes",
              reviewed_at: "2026-10-29T20:30:00.125Z",
            },
          ],
        },
        updated_at: "2026-10-29T20:30:00.125Z",
      },
    },
    updated_at: "2026-10-29T20:30:00.125Z",
  };
  const original = JSON.stringify(old);
  await fs.writeFile(reviewsFilePath(browse), original);
  const response = await collectionGET(
    request("GET", undefined, "&format=json"),
  );
  const exported = await response.json();
  expect(exported.updated_at).toBe("2026-10-30T04:30:00.125+08:00");
  const entry = exported.datasets["source/dataset-a"].episodes["0"][0];
  expect(entry.reviewed_at).toBe("2026-10-30T04:30:00.125+08:00");
  expect(Date.parse(entry.reviewed_at)).toBe(Date.parse(old.updated_at));
  expect(await fs.readFile(reviewsFilePath(browse), "utf8")).toBe(original);
});

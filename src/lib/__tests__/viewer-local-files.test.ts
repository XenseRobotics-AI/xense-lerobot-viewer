import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  GET,
  HEAD,
} from "@/app/api/local-datasets/[encodedPath]/[...filePath]/route";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import { fetchJson, fetchParquetFile } from "@/utils/parquetUtils";
import { EMPTY_FACETS } from "@/lib/dataset-facets";
import { EMPTY_TAGS } from "@/lib/dataset-tags";
import {
  serializeLocalDatasetsResponseForClient,
  type LocalDatasetSummary,
  type LocalDatasetsResponse,
} from "@/lib/local-datasets-discovery";

let root: string;
let outside: string;
let encodedPath: string;
// Exceed hyparquet's 512 KiB whole-file cache so slices hit the file adapter.
const content = "0123456789".repeat(65536);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "viewer-local-files-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "viewer-outside-files-"));
  await fs.writeFile(path.join(outside, "secret.json"), "private");
  encodedPath = encodeLocalDatasetPath(root);
  await fs.mkdir(path.join(root, "meta"));
  await fs.writeFile(path.join(root, "meta", "info.json"), '{"fps":30}');
  await fs.writeFile(path.join(root, "sample.parquet"), content);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

function context(filePath = ["sample.parquet"]) {
  return { params: Promise.resolve({ encodedPath, filePath }) };
}

describe("local file streaming", () => {
  test("serves full files and honours byte ranges", async () => {
    const full = await GET(new NextRequest("http://localhost/file"), context());
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(content.length));
    expect(await full.text()).toBe(content);

    const range = await GET(
      new NextRequest("http://localhost/file", {
        headers: { range: "bytes=11-25" },
      }),
      context(),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 11-25/${content.length}`,
    );
    expect(range.headers.get("content-length")).toBe("15");
    expect(await range.text()).toBe(content.slice(11, 26));
  });

  test("rejects unsatisfiable ranges and keeps HEAD bodyless", async () => {
    const invalid = await GET(
      new NextRequest("http://localhost/file", {
        headers: { range: `bytes=${content.length}-` },
      }),
      context(),
    );
    expect(invalid.status).toBe(416);
    const head = await HEAD(
      new NextRequest("http://localhost/file"),
      context(),
    );
    expect(head.headers.get("content-length")).toBe(String(content.length));
    expect(head.body).toBeNull();
  });

  test("does not follow file symlinks outside the dataset", async () => {
    await fs.symlink(path.join(root, "meta"), path.join(root, "inside"));
    await fs.symlink(outside, path.join(root, "outside"));
    const result = await GET(
      new NextRequest("http://localhost/file"),
      context(["inside", "info.json"]),
    );
    // A link resolving back into the dataset is allowed.
    expect(result.status).toBe(200);
    await result.text();
    const denied = await GET(
      new NextRequest("http://localhost/file"),
      context(["outside", "secret.json"]),
    );
    expect(denied.status).toBe(404);
  });
});

describe("server local reads", () => {
  test("reads local JSON without an HTTP server", async () => {
    expect(
      await fetchJson(
        `http://127.0.0.1:1/api/local-datasets/${encodedPath}/meta/info.json`,
      ),
    ).toEqual({ fps: 30 });
  });

  test("reads local Parquet bytes without an HTTP server", async () => {
    const file = await fetchParquetFile(
      `http://127.0.0.1:1/api/local-datasets/${encodedPath}/sample.parquet`,
    );
    expect(file.byteLength).toBe(content.length);
    expect(new TextDecoder().decode(await file.slice(11, 26))).toBe(
      content.slice(11, 26),
    );
    expect(new TextDecoder().decode(await file.slice(-8))).toBe(
      content.slice(-8),
    );
    expect((await file.slice(20, 20)).byteLength).toBe(0);
    expect(new TextDecoder().decode(await file.slice(content.length - 5))).toBe(
      content.slice(-5),
    );
  });
});

test("client summaries omit internal properties and retain interrupted conversions", () => {
  const dataset: LocalDatasetSummary = {
    relativePath: "example",
    encodedPath: "example",
    codebase_version: "v3.0",
    robot_type: null,
    total_episodes: 1,
    total_frames: 30,
    fps: 30,
    sizeBytes: 10,
    thumbnailVideoUrl: null,
    integrity: {
      hasData: true,
      hasVideos: true,
      hasEpisodes: true,
      status: "ok",
    },
    tags: { ...EMPTY_TAGS, objects: ["cup"] },
    facets: { ...EMPTY_FACETS },
  };
  Object.defineProperty(dataset, "internalFields", {
    value: new Set(["fps"]),
    enumerable: true,
  });
  const input: LocalDatasetsResponse = {
    root: "/datasets",
    browsePath: "/datasets",
    locations: ["/datasets"],
    datasets: [dataset],
    interrupted: [
      {
        relativePath: "unfinished",
        sizeBytes: 100,
        episodesConverted: 2,
        updatedDay: null,
      },
    ],
    errors: [],
  };
  const result = serializeLocalDatasetsResponseForClient(input);
  expect("internalFields" in result.datasets[0]).toBe(false);
  expect(result.interrupted).toEqual(input.interrupted);
  expect(result.interrupted[0]).not.toBe(input.interrupted[0]);
  result.datasets[0].tags.objects.push("bowl");
  expect(dataset.tags.objects).toEqual(["cup"]);
});

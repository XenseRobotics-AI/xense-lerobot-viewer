import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildV2EpisodeDataPath,
  listV3EpisodeMetadataFiles,
} from "../parquet-server";

const V2_INFO = {
  codebase_version: "v2.1",
  data_path:
    "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
  chunks_size: 1000,
};

describe("buildV2EpisodeDataPath", () => {
  it("pads the chunk and episode index", () => {
    expect(buildV2EpisodeDataPath(V2_INFO, 0)).toBe(
      "data/chunk-000/episode_000000.parquet",
    );
    expect(buildV2EpisodeDataPath(V2_INFO, 42)).toBe(
      "data/chunk-000/episode_000042.parquet",
    );
  });

  it("rolls over to the next chunk past chunks_size", () => {
    expect(buildV2EpisodeDataPath(V2_INFO, 1000)).toBe(
      "data/chunk-001/episode_001000.parquet",
    );
    expect(buildV2EpisodeDataPath(V2_INFO, 2500)).toBe(
      "data/chunk-002/episode_002500.parquet",
    );
  });

  it("honours a non-default chunks_size", () => {
    expect(buildV2EpisodeDataPath({ ...V2_INFO, chunks_size: 50 }, 120)).toBe(
      "data/chunk-002/episode_000120.parquet",
    );
  });

  it("falls back to the lerobot default layout when info is incomplete", () => {
    expect(buildV2EpisodeDataPath({}, 7)).toBe(
      "data/chunk-000/episode_000007.parquet",
    );
    expect(buildV2EpisodeDataPath({ chunks_size: 0 }, 1500)).toBe(
      "data/chunk-001/episode_001500.parquet",
    );
  });

  it("follows a custom data_path from info.json", () => {
    expect(
      buildV2EpisodeDataPath(
        { ...V2_INFO, data_path: "episodes/{episode_index:06d}.parquet" },
        3,
      ),
    ).toBe("episodes/000003.parquet");
  });
});

describe("listV3EpisodeMetadataFiles", () => {
  let datasetRoot: string;

  beforeAll(async () => {
    datasetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v3-shards-"));
    for (const file of [
      "meta/episodes/chunk-4/file-12.parquet",
      "meta/episodes/chunk-4/file-2.parquet",
      "meta/episodes/chunk-9/file-0.parquet",
      "meta/episodes/chunk-4/file-7.txt",
      "meta/episodes/chunk-x/file-0.parquet",
    ]) {
      const absolutePath = path.join(datasetRoot, file);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "");
    }
  });

  afterAll(async () => {
    await fs.rm(datasetRoot, { recursive: true, force: true });
  });

  it("enumerates only existing parquet shards in numeric order", async () => {
    expect(await listV3EpisodeMetadataFiles(datasetRoot)).toEqual([
      "meta/episodes/chunk-4/file-2.parquet",
      "meta/episodes/chunk-4/file-12.parquet",
      "meta/episodes/chunk-9/file-0.parquet",
    ]);
  });

  it("returns an empty list when the metadata tree is missing", async () => {
    expect(await listV3EpisodeMetadataFiles(os.tmpdir())).toEqual([]);
  });
});

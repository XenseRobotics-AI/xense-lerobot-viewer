import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildV2EpisodeDataPath,
  listV3EpisodeMetadataFiles,
  listV3EpisodeIndices,
} from "../parquet-server";
import { EPISODE_ONE, EPISODE_SEVEN } from "./fixtures/episode-metadata";

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

describe("listV3EpisodeIndices", () => {
  let root: string;
  const shard = (file: number) =>
    path.join(
      root,
      "meta/episodes/chunk-000",
      `file-${file.toString().padStart(3, "0")}.parquet`,
    );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "v3-episode-indices-"));
    await fs.mkdir(path.dirname(shard(1)), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns sorted unique indices from nonzero and non-contiguous shards", async () => {
    await fs.writeFile(shard(1), EPISODE_SEVEN);
    await fs.writeFile(shard(3), EPISODE_ONE);
    await fs.writeFile(shard(5), EPISODE_SEVEN);
    expect(await listV3EpisodeIndices(root)).toEqual([1, 7]);
    const result = await listV3EpisodeIndices(root);
    result.push(99);
    expect(await listV3EpisodeIndices(root)).toEqual([1, 7]);
  });

  it("refreshes after an existing shard changes and after a shard is removed", async () => {
    await fs.writeFile(shard(1), EPISODE_ONE);
    expect(await listV3EpisodeIndices(root)).toEqual([1]);
    await fs.writeFile(shard(1), EPISODE_SEVEN);
    const later = new Date(Date.now() + 5000);
    await fs.utimes(shard(1), later, later);
    expect(await listV3EpisodeIndices(root)).toEqual([7]);
    await fs.rm(shard(1));
    expect(await listV3EpisodeIndices(root)).toEqual([]);
    await fs.writeFile(shard(3), EPISODE_ONE);
    expect(await listV3EpisodeIndices(root)).toEqual([1]);
  });

  it("keeps readable episodes when another shard is damaged", async () => {
    await fs.writeFile(shard(1), "damaged synthetic fixture");
    await fs.writeFile(shard(3), EPISODE_SEVEN);
    expect(await listV3EpisodeIndices(root)).toEqual([7]);
  });
});

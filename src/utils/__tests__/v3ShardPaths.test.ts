import { describe, expect, it } from "bun:test";
import {
  matchesFixedV3EpisodeMetadataProbing,
  parseV3EpisodeMetadataShard,
  sortV3EpisodeMetadataShards,
} from "@/utils/v3ShardPaths";

describe("v3 episode metadata shard paths", () => {
  it("parses numeric chunk and file identifiers", () => {
    expect(
      parseV3EpisodeMetadataShard("meta/episodes/chunk-12/file-4.parquet"),
    ).toEqual({
      relPath: "meta/episodes/chunk-12/file-4.parquet",
      chunkIndex: 12,
      fileIndex: 4,
    });
  });

  it("rejects unrelated paths and unsafe numeric identifiers", () => {
    expect(
      parseV3EpisodeMetadataShard("meta/episodes/chunk-x/file-0.parquet"),
    ).toBeNull();
    expect(
      parseV3EpisodeMetadataShard(
        "meta/episodes/chunk-9007199254740992/file-0.parquet",
      ),
    ).toBeNull();
  });

  it("sorts existing shards numerically without requiring zero-based sequences", () => {
    expect(
      sortV3EpisodeMetadataShards([
        "meta/episodes/chunk-2/file-10.parquet",
        "meta/episodes/chunk-11/file-0.parquet",
        "meta/episodes/chunk-2/file-3.parquet",
        "meta/episodes/chunk-2/file-1.parquet",
        "meta/episodes/chunk-0/file-0.parquet",
        "meta/episodes/chunk-2/file-3.txt",
      ]),
    ).toEqual([
      "meta/episodes/chunk-0/file-0.parquet",
      "meta/episodes/chunk-2/file-1.parquet",
      "meta/episodes/chunk-2/file-3.parquet",
      "meta/episodes/chunk-2/file-10.parquet",
      "meta/episodes/chunk-11/file-0.parquet",
    ]);
  });

  it("detects layouts the fixed zero-based probe would miss", () => {
    expect(
      matchesFixedV3EpisodeMetadataProbing([
        "meta/episodes/chunk-0/file-0.parquet",
        "meta/episodes/chunk-0/file-1.parquet",
        "meta/episodes/chunk-1/file-0.parquet",
      ]),
    ).toBe(true);
    expect(
      matchesFixedV3EpisodeMetadataProbing([
        "meta/episodes/chunk-2/file-0.parquet",
        "meta/episodes/chunk-2/file-3.parquet",
      ]),
    ).toBe(false);
  });

  it.each([
    ["nonzero first file", ["meta/episodes/chunk-000/file-001.parquet"]],
    [
      "file gap",
      [
        "meta/episodes/chunk-000/file-000.parquet",
        "meta/episodes/chunk-000/file-002.parquet",
      ],
    ],
    [
      "chunk gap",
      [
        "meta/episodes/chunk-000/file-000.parquet",
        "meta/episodes/chunk-002/file-000.parquet",
      ],
    ],
    ["nonzero first chunk", ["meta/episodes/chunk-001/file-000.parquet"]],
  ])(
    "requires a layout notice for %s even when an episode is readable",
    (_reason, paths) => {
      expect(matchesFixedV3EpisodeMetadataProbing(paths)).toBe(false);
    },
  );
});

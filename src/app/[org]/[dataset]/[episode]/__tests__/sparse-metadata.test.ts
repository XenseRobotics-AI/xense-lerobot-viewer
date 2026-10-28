import { describe, expect, it, spyOn } from "bun:test";
import { loadAllEpisodeLengthsV3 } from "../fetch-data";
import {
  EPISODE_ONE,
  EPISODE_SEVEN,
} from "@/lib/__tests__/fixtures/episode-metadata";
import { makeLocalRepoId } from "@/utils/datasetRoute";

describe("sparse v3 episode metadata statistics", () => {
  for (const reportedCount of [1, 20]) {
    it(`uses every enumerated shard exactly once when info.json reports ${reportedCount} episodes`, async () => {
      const requests: string[] = [];
      const files = new Map([
        ["meta/episodes/chunk-000/file-000.parquet", EPISODE_ONE],
        ["meta/episodes/chunk-000/file-003.parquet", EPISODE_SEVEN],
      ]);
      const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
        async (input, init) => {
          const url = String(input);
          requests.push(url);
          if (url.endsWith("meta/info.json")) {
            return Response.json({
              codebase_version: "v3.0",
              total_episodes: reportedCount,
              features: {},
            });
          }
          if (url.endsWith("/shards?kind=episode-metadata")) {
            return Response.json({ paths: [...files.keys()] });
          }
          for (const [file, bytes] of files) {
            if (url.endsWith(file)) {
              return new Response(init?.method === "HEAD" ? null : bytes, {
                headers: { "content-length": String(bytes.length) },
              });
            }
          }
          throw new Error(`Unexpected metadata probe: ${url}`);
        },
      );
      try {
        const stats = await loadAllEpisodeLengthsV3(
          makeLocalRepoId(`/synthetic/sparse-${reportedCount}`),
          "v3.0",
          30,
        );
        expect(stats?.allEpisodeLengths).toEqual([
          { episodeIndex: 1, frames: 30, lengthSeconds: 1 },
          { episodeIndex: 7, frames: 210, lengthSeconds: 7 },
        ]);
        expect(requests.filter((url) => url.endsWith(".parquet"))).toHaveLength(
          4, // One HEAD and one GET per shard.
        );
      } finally {
        fetchMock.mockRestore();
      }
    });
  }
});

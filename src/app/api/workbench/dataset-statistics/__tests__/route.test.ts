import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GET } from "@/app/api/workbench/dataset-statistics/route";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousLog = process.env.TACVERSE_WORKBENCH_DATASET_LOG;

async function writeLocalDataset(relativePath: string): Promise<void> {
  const directory = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.join(directory, "meta"), { recursive: true });
  await fs.mkdir(path.join(directory, "data"), { recursive: true });
  await fs.mkdir(path.join(directory, "videos"), { recursive: true });
  await fs.writeFile(path.join(directory, "data", "part.parquet"), "data");
  await fs.writeFile(path.join(directory, "videos", "camera.mp4"), "video");
  await fs.writeFile(
    path.join(directory, "meta", "info.json"),
    JSON.stringify({
      codebase_version: "v3.0",
      robot_type: "local-robot",
      total_episodes: 99,
      total_frames: 99,
      fps: 30,
    }),
  );
}

async function writeCatalog(value: Record<string, unknown>): Promise<void> {
  const directory = path.join(root, ".xense-viewer", "hf-catalog");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "TacVerse.json"),
    JSON.stringify(value),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tacverse-statistics-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  delete process.env.TACVERSE_WORKBENCH_DATASET_LOG;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousLog === undefined)
    delete process.env.TACVERSE_WORKBENCH_DATASET_LOG;
  else process.env.TACVERSE_WORKBENCH_DATASET_LOG = previousLog;
  await fs.rm(root, { recursive: true, force: true });
});

describe("TacVerse dataset statistics route", () => {
  test("uses only raw TacVerse Hub catalog membership and retains rows without info", async () => {
    await writeLocalDataset("TacVerse/released/taccap-g1-valid-task-0905");
    await writeLocalDataset("TacVerse/local-only-0905");
    const history = path.join(root, "dataset-log.json");
    process.env.TACVERSE_WORKBENCH_DATASET_LOG = history;
    await fs.writeFile(
      history,
      JSON.stringify({
        datasets: {
          "TacVerse/history-only-0905": {
            uploader: "legacy",
            last_modified: "2026-09-05T00:00:00Z",
          },
        },
      }),
    );
    await writeCatalog({
      org: "TacVerse",
      refreshedAt: "2026-09-05T08:00:00Z",
      failures: [{ repoId: "TacVerse/no-info", error: "missing info" }],
      datasets: [
        {
          repoId: "TacVerse/taccap-g1-valid-task-0905",
          robotType: "g1",
          totalEpisodes: 12,
          totalFrames: 43_200,
          fps: 30,
          durationHours: 0.4,
          createdAt: "2026-09-01T00:00:00Z",
          lastModified: "2026-09-05T06:00:00Z",
          downloads: 17,
          sha: "abc",
          localState: "missing",
        },
        {
          repoId: "TacVerse/no-info",
          robotType: null,
          totalEpisodes: null,
          totalFrames: null,
          durationHours: null,
          createdAt: "2026-09-02T00:00:00Z",
          lastModified: null,
          downloads: 3,
          sha: "def",
          localState: "missing",
          metadataState: "error",
        },
        {
          repoId: "OtherOrg/not-tacverse",
          totalEpisodes: 500,
          downloads: 500,
        },
      ],
    });

    const response = await GET(
      new Request("http://localhost/api/workbench/dataset-statistics"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      organization: "TacVerse",
      refreshedAt: "2026-09-05T08:00:00Z",
      hubTotal: 2,
    });
    expect(
      payload.datasets.map((row: { repoId: string }) => row.repoId),
    ).toEqual(["TacVerse/taccap-g1-valid-task-0905", "TacVerse/no-info"]);
    expect(payload.datasets[0]).toMatchObject({
      repoId: "TacVerse/taccap-g1-valid-task-0905",
      robotType: "g1",
      episodes: 12,
      frames: 43_200,
      hours: 0.4,
      localStatus: "downloaded",
      issuesStatus: "ok",
      createdAt: "2026-09-01T00:00:00Z",
      lastModified: "2026-09-05T06:00:00Z",
      downloads: 17,
    });
    expect(payload.datasets[1]).toMatchObject({
      repoId: "TacVerse/no-info",
      robotType: null,
      episodes: null,
      frames: null,
      hours: null,
      localStatus: "missing",
      issuesStatus: "fail",
      downloads: 3,
    });
    expect(payload.catalogFailures).toHaveLength(1);
  });

  test("returns an empty fixed-organization response before the first refresh", async () => {
    const response = await GET(
      new Request("http://localhost/api/workbench/dataset-statistics"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organization: "TacVerse",
      refreshedAt: null,
      categoryFilter: [],
      hubTotal: 0,
      categoryTotal: 0,
      categoryCounts: {
        "taccap-g1": 0,
        "xtac-umi-g1": 0,
        "taccap-g1-merged": 0,
        folder: 0,
        other: 0,
      },
      datasets: [],
    });
  });

  test("filters all metrics by category and rejects invalid values", async () => {
    await writeCatalog({
      org: "TacVerse",
      refreshedAt: "2026-09-05T08:00:00Z",
      datasets: [
        {
          repoId: "TacVerse/taccap-g1-first-party-0905",
          totalEpisodes: 2,
          totalFrames: 7200,
          fps: 10,
          downloads: 11,
        },
        {
          repoId: "TacVerse/xtac-umi-g1-other-0905",
          totalEpisodes: 3,
          totalFrames: 10800,
          fps: 10,
          downloads: 13,
        },
        {
          repoId: "TacVerse/taccap-g1",
          totalEpisodes: 5,
          totalFrames: 18000,
          fps: 10,
          downloads: 17,
        },
      ],
    });

    const allResponse = await GET(
      new Request("http://localhost/api/workbench/dataset-statistics"),
    );
    const all = await allResponse.json();
    expect(all).toMatchObject({
      categoryFilter: [],
      hubTotal: 3,
      categoryTotal: 3,
      categoryCounts: {
        "taccap-g1": 1,
        "xtac-umi-g1": 1,
        "taccap-g1-merged": 0,
        folder: 0,
        other: 1,
      },
    });

    const firstPartyResponse = await GET(
      new Request(
        "http://localhost/api/workbench/dataset-statistics?category=taccap-g1",
      ),
    );
    const firstParty = await firstPartyResponse.json();
    expect(firstParty).toMatchObject({
      categoryFilter: ["taccap-g1"],
      hubTotal: 3,
      categoryTotal: 1,
      categoryCounts: {
        "taccap-g1": 1,
        "xtac-umi-g1": 1,
        "taccap-g1-merged": 0,
        folder: 0,
        other: 1,
      },
    });
    expect(firstParty.datasets).toEqual([
      expect.objectContaining({
        repoId: "TacVerse/taccap-g1-first-party-0905",
        episodes: 2,
        downloads: 11,
      }),
    ]);

    const unionResponse = await GET(
      new Request(
        "http://localhost/api/workbench/dataset-statistics?category=xtac-umi-g1,taccap-g1",
      ),
    );
    const union = await unionResponse.json();
    expect(union.categoryFilter).toEqual(["taccap-g1", "xtac-umi-g1"]);
    expect(union.categoryTotal).toBe(2);
    expect(union.datasets.map((row: { repoId: string }) => row.repoId)).toEqual(
      [
        "TacVerse/taccap-g1-first-party-0905",
        "TacVerse/xtac-umi-g1-other-0905",
      ],
    );

    const otherResponse = await GET(
      new Request(
        "http://localhost/api/workbench/dataset-statistics?category=other",
      ),
    );
    const other = await otherResponse.json();
    expect(other.categoryTotal).toBe(1);
    expect(other.datasets.map((row: { repoId: string }) => row.repoId)).toEqual(
      ["TacVerse/taccap-g1"],
    );

    const xtacResponse = await GET(
      new Request(
        "http://localhost/api/workbench/dataset-statistics?category=xtac-umi-g1",
      ),
    );
    const xtac = await xtacResponse.json();
    expect(xtac.categoryTotal).toBe(1);
    expect(xtac.datasets[0].repoId).toBe("TacVerse/xtac-umi-g1-other-0905");

    const invalid = await GET(
      new Request(
        "http://localhost/api/workbench/dataset-statistics?category=unknown",
      ),
    );
    expect(invalid.status).toBe(400);
  });
  test("counts a Folder once and exposes only structural child names", async () => {
    await writeLocalDataset("TacVerse/sampledata/child-a");
    await writeLocalDataset("TacVerse/sampledata/child-b");
    await writeCatalog({
      catalogVersion: 2,
      org: "TacVerse",
      refreshedAt: "2026-09-05T08:00:00Z",
      datasets: [
        {
          repoId: "TacVerse/sampledata",
          layout: "folder",
          downloads: 21,
          children: [
            {
              name: "child-a",
              path: "child-a",
              robotType: "robot-a",
              totalEpisodes: 2,
              totalFrames: 7200,
              fps: 10,
              durationHours: 0.2,
              metadataState: "ok",
            },
            {
              name: "child-b",
              path: "child-b",
              robotType: "robot-b",
              totalEpisodes: 3,
              totalFrames: 10800,
              fps: 10,
              durationHours: 0.3,
              metadataState: "ok",
            },
            {
              name: "broken",
              path: "broken",
              metadataState: "error",
              metadataError: "invalid JSON",
            },
          ],
          metadataState: "partial",
        },
      ],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/workbench/dataset-statistics?category=folder",
      ),
    );
    const payload = await response.json();
    expect(payload).toMatchObject({
      hubTotal: 1,
      categoryTotal: 1,
      categoryCounts: { folder: 1 },
    });
    expect(payload.datasets).toHaveLength(1);
    expect(payload.datasets[0]).toMatchObject({
      rowType: "folder",
      repoId: "TacVerse/sampledata",
      hubRepoId: "TacVerse/sampledata",
      hubPath: null,
      downloads: 21,
      episodes: null,
      frames: null,
      hours: null,
      metricsState: "unavailable",
      robotType: null,
      robotTypes: [],
    });
    expect(payload.datasets[0].children).toHaveLength(3);
    expect(payload.datasets[0].children[0]).toMatchObject({
      rowType: "child",
      name: "child-a",
      hubRepoId: "TacVerse/sampledata",
      hubPath: "child-a",
      downloads: null,
      episodes: null,
      frames: null,
      hours: null,
      robotType: null,
    });
    expect(payload.datasets[0].children[0].hubUrl).toEndWith(
      "/TacVerse/sampledata/tree/main/child-a",
    );
    expect(payload.datasets[0].children[2]).toMatchObject({
      name: "broken",
      metricsState: "unavailable",
      categoryWarning: null,
      episodes: null,
    });
  });
});

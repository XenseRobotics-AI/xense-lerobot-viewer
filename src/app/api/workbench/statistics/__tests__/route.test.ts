import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GET } from "@/app/api/workbench/statistics/route";
import { WORKBENCH_PERSONNEL_BASELINE_DAY } from "@/components/workbench-personnel-mapping-editor";
import { writeWorkbenchWorkstationMappings } from "@/lib/workbench-config-store";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousWorkbenchLog = process.env.TACVERSE_WORKBENCH_DATASET_LOG;
const previousChangeHistory = process.env.TACVERSE_WORKBENCH_CHANGE_HISTORY;

async function writeDataset(
  repoId: string,
  info: Record<string, unknown> = {},
  hardware: Record<string, unknown> | null = null,
  options: { payload?: boolean } = {},
): Promise<void> {
  const dir = path.join(root, ...repoId.split("/"));
  await fs.mkdir(path.join(dir, "meta"), { recursive: true });
  if (options.payload !== false) {
    await fs.mkdir(path.join(dir, "data"), { recursive: true });
    await fs.mkdir(path.join(dir, "videos"), { recursive: true });
    await fs.writeFile(path.join(dir, "data", "chunk-000.parquet"), "");
    await fs.writeFile(path.join(dir, "videos", "camera.mp4"), "");
  }
  await fs.writeFile(
    path.join(dir, "meta", "info.json"),
    JSON.stringify({
      codebase_version: "v3.0",
      robot_type: "g1",
      total_episodes: 10,
      total_frames: 36_000,
      fps: 10,
      ...info,
    }),
  );
  if (hardware) {
    await fs.writeFile(
      path.join(dir, "meta", "hardware.json"),
      JSON.stringify(hardware),
    );
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-workbench-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  delete process.env.TACVERSE_WORKBENCH_DATASET_LOG;
  delete process.env.TACVERSE_WORKBENCH_CHANGE_HISTORY;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousWorkbenchLog === undefined) {
    delete process.env.TACVERSE_WORKBENCH_DATASET_LOG;
  } else {
    process.env.TACVERSE_WORKBENCH_DATASET_LOG = previousWorkbenchLog;
  }
  if (previousChangeHistory === undefined) {
    delete process.env.TACVERSE_WORKBENCH_CHANGE_HISTORY;
  } else {
    process.env.TACVERSE_WORKBENCH_CHANGE_HISTORY = previousChangeHistory;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("Workbench statistics route", () => {
  test("matches bucketed local paths to their unbucketed Hub repo ids", async () => {
    await writeDataset("TacVerse/released/example-0902", {
      total_episodes: 1,
      total_frames: 3_600,
      fps: 10,
    });
    const cacheDir = path.join(root, ".xense-viewer", "hf-catalog");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "TacVerse.json"),
      JSON.stringify({
        org: "TacVerse",
        datasets: [
          {
            repoId: "TacVerse/example-0902",
            uploader: "alice",
            totalEpisodes: 12,
            totalFrames: 43_200,
            fps: 10,
            lastModified: "2026-09-02T12:00:00Z",
          },
        ],
      }),
    );

    const response = await GET(
      new Request("http://localhost/api/workbench/statistics?org=TacVerse"),
    );
    const payload = (await response.json()) as {
      datasets: Array<{
        relativePath: string;
        total_episodes: number;
        uploader: string | null;
        lastModified: string | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.datasets).toEqual([
      expect.objectContaining({
        relativePath: "TacVerse/released/example-0902",
        total_episodes: 12,
        uploader: "alice",
        lastModified: "2026-09-02T12:00:00Z",
      }),
    ]);
  });

  test("returns HF metadata fields and stable lastModified order", async () => {
    await writeDataset("TacVerse/older-0817", {
      total_episodes: 1,
      total_frames: 3_600,
      fps: 10,
    });
    await writeDataset(
      "TacVerse/newer-0818",
      {
        total_episodes: 5,
        total_frames: 18_000,
        fps: 10,
      },
      {
        epochs: [
          {
            from_episode: 0,
            to_episode: 20,
            units: [
              {
                side: "right",
                gripper_sn: "TCGU-right",
                robot_id: "robot-older",
              },
              {
                side: "left",
                gripper_sn: "TCGU01A28Z0041m",
                robot_id: "robot-older",
              },
            ],
          },
          {
            from_episode: 20,
            to_episode: 40,
            units: [
              {
                side: "right",
                gripper_sn: "TCGU-right",
                robot_id: "robot-newer",
              },
              {
                side: "left",
                gripper_sn: "TCGU01A28Z0069m",
                robot_id: "robot-newer",
              },
            ],
          },
        ],
      },
    );
    await writeDataset(
      "TacVerse/metadata-only-0818",
      {
        total_episodes: 100,
        total_frames: 360_000,
        fps: 10,
      },
      null,
      { payload: false },
    );
    const cacheDir = path.join(root, ".xense-viewer", "hf-catalog");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "TacVerse.json"),
      JSON.stringify({
        org: "TacVerse",
        datasets: [
          {
            repoId: "TacVerse/older-0817",
            uploader: "XR-Bot3",
            totalEpisodes: 11,
            totalFrames: 54_000,
            fps: 30,
            durationHours: 0.5,
            lastModified: "2026-08-17T10:00:00Z",
          },
          {
            repoId: "TacVerse/newer-0818",
            uploader: "alice",
            uploaderDisplayName: "Alice",
            totalEpisodes: 25,
            totalFrames: 90_000,
            fps: 30,
            durationHours: 0.833333,
            lastModified: "2026-08-18T10:00:00Z",
          },
          {
            repoId: "TacVerse/metadata-only-0818",
            uploader: "bob",
            totalEpisodes: 100,
            totalFrames: 360_000,
            fps: 10,
            durationHours: 10,
            lastModified: "2026-08-18T11:00:00Z",
          },
        ],
      }),
    );
    const changeHistoryPath = path.join(root, "hf_change_history.local.json");
    process.env.TACVERSE_WORKBENCH_CHANGE_HISTORY = changeHistoryPath;
    await fs.writeFile(
      changeHistoryPath,
      JSON.stringify({
        version: 1,
        repos: {
          "TacVerse/newer-0818": {
            last_modified: "2026-08-18T10:00:00Z",
            changes: [
              {
                dataset_name: "TacVerse/newer-0818",
                created_at: "2026-08-18T02:00:00Z",
                episodes: 10,
                frames: 36_000,
                hours: 0.333,
              },
              {
                dataset_name: "TacVerse/newer-0818",
                created_at: "2026-08-18T16:30:00Z",
                episodes: 5,
                frames: 18_000,
                hours: 0.167,
              },
              {
                dataset_name: "TacVerse/newer-0818",
                created_at: "2026-08-18T17:00:00Z",
                episodes: 0,
                frames: 0,
                hours: 0,
              },
            ],
          },
          "OtherOrg/ignored": {
            changes: [
              {
                created_at: "2026-08-18T02:00:00Z",
                episodes: 99,
                frames: 99,
                hours: 99,
              },
            ],
          },
        },
      }),
    );

    await writeWorkbenchWorkstationMappings(
      "TacVerse",
      { TCGU01A28Z0069m: "D2" },
      root,
    );

    const response = await GET(
      new Request("http://localhost/api/workbench/statistics?org=TacVerse"),
    );
    const payload = (await response.json()) as {
      workstationMappings: {
        source: string;
        mappings: Record<string, string>;
        defaults: Record<string, string>;
      };
      personnelConfig: {
        org: string;
        people: Array<{ id: string; displayName: string; email: string }>;
        schedules: Record<string, unknown>;
      };
      datasets: Array<{
        relativePath: string;
        total_episodes: number;
        total_frames: number;
        fps: number;
        lastModified: string | null;
        uploader: string | null;
        uploaderDisplayName: string | null;
        leftGripperSn: string | null;
        robotId: string | null;
        dailyAdditions: Array<{
          day: string;
          episodes: number;
          frames: number;
          hours: number;
        }>;
        hf: {
          lastModified: string | null;
          uploader: string | null;
          uploaderDisplayName: string | null;
        };
      }>;
      dataUpdatedAt: string | null;
    };

    expect(response.status).toBe(200);
    expect(payload.dataUpdatedAt).toBe("2026-08-18T11:00:00.000Z");
    expect(payload.workstationMappings).toMatchObject({
      source: "stored",
      mappings: { "robot-newer": "D2" },
      legacyMappings: { TCGU01A28Z0069m: "D2" },
    });
    expect(payload.workstationMappings.defaults.TCGU01A28Z0033m).toBe("N0");
    expect(payload.personnelConfig.org).toBe("TacVerse");
    expect(payload.personnelConfig.people.length).toBeGreaterThan(0);
    expect(
      payload.personnelConfig.schedules[WORKBENCH_PERSONNEL_BASELINE_DAY],
    ).toBeArray();
    expect(
      payload.personnelConfig.people.every(
        (person) => typeof person.email === "string",
      ),
    ).toBeTrue();
    const baselinePersonnelMapping = payload.personnelConfig.schedules[
      WORKBENCH_PERSONNEL_BASELINE_DAY
    ] as Array<{ workstation: string; members: unknown[] }>;
    expect(
      baselinePersonnelMapping.every(
        (assignment) =>
          typeof assignment.workstation === "string" &&
          Array.isArray(assignment.members),
      ),
    ).toBeTrue();
    expect(payload.datasets.map((dataset) => dataset.relativePath)).toEqual([
      "TacVerse/metadata-only-0818",
      "TacVerse/newer-0818",
      "TacVerse/older-0817",
    ]);
    const newer = payload.datasets.find(
      (dataset) => dataset.relativePath === "TacVerse/newer-0818",
    );
    const metadataOnly = payload.datasets.find(
      (dataset) => dataset.relativePath === "TacVerse/metadata-only-0818",
    );
    expect(newer).toMatchObject({
      total_episodes: 25,
      total_frames: 90_000,
      fps: 30,
      lastModified: "2026-08-18T10:00:00Z",
      uploader: "alice",
      uploaderDisplayName: "Alice",
      leftGripperSn: "TCGU01A28Z0069m",
      robotId: "robot-newer",
      dailyAdditions: [
        {
          day: "2026-08-18",
          episodes: 25,
          frames: 90_000,
          hours: 0.833,
        },
      ],
      hf: {
        lastModified: "2026-08-18T10:00:00Z",
        uploader: "alice",
        uploaderDisplayName: "Alice",
      },
    });
    expect(metadataOnly).toMatchObject({
      relativePath: "TacVerse/metadata-only-0818",
      total_episodes: 100,
      total_frames: 360_000,
      dailyAdditions: [],
    });
    expect(payload.datasets[2]).toMatchObject({
      total_episodes: 11,
      total_frames: 54_000,
      fps: 30,
      lastModified: "2026-08-17T10:00:00Z",
      uploader: "XR-Bot3",
      uploaderDisplayName: "洪锐",
    });
  });
  test("includes legacy left-SN-only datasets in daily additions", async () => {
    await writeDataset(
      "TacVerse/taccap-g1-insert-hook-assembly-0901",
      {
        total_episodes: 7,
        total_frames: 25_200,
        fps: 10,
      },
      {
        units: [{ side: "left", gripper_sn: "TCGU01A28Z0041m" }],
      },
    );

    const cacheDir = path.join(root, ".xense-viewer", "hf-catalog");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "TacVerse.json"),
      JSON.stringify({
        org: "TacVerse",
        datasets: [
          {
            repoId: "TacVerse/taccap-g1-insert-hook-assembly-0901",
            lastModified: "2026-09-01T12:00:00Z",
          },
        ],
      }),
    );

    const response = await GET(
      new Request("http://localhost/api/workbench/statistics?org=TacVerse"),
    );
    const payload = (await response.json()) as {
      datasets: Array<{
        relativePath: string;
        leftGripperSn: string | null;
        robotId: string | null;
        lastModified: string | null;
        dailyAdditions: Array<{
          day: string;
          episodes: number;
          frames: number;
          hours: number;
        }>;
      }>;
    };

    const legacy = payload.datasets.find(
      (dataset) =>
        dataset.relativePath === "TacVerse/taccap-g1-insert-hook-assembly-0901",
    );
    expect(legacy).toBeDefined();
    expect(legacy).toMatchObject({
      lastModified: "2026-09-01T12:00:00Z",
      leftGripperSn: "TCGU01A28Z0041m",
      robotId: null,
      dailyAdditions: [
        {
          day: "2026-09-01",
          episodes: 7,
          frames: 25_200,
          hours: 0.7,
        },
      ],
    });
  });

  test("does not date-bind datasets without an MMDD suffix", async () => {
    await writeDataset(
      "TacVerse/taccap-g1-wipe-mirror",
      {
        total_episodes: 9,
        total_frames: 32_400,
        fps: 10,
      },
      {
        units: [
          {
            side: "left",
            gripper_sn: "TCGU01A28Z0071m",
            robot_id: "bi_taccap_8",
          },
        ],
      },
    );

    const cacheDir = path.join(root, ".xense-viewer", "hf-catalog");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "TacVerse.json"),
      JSON.stringify({
        org: "TacVerse",
        datasets: [
          {
            repoId: "TacVerse/taccap-g1-wipe-mirror",
            lastModified: "2026-09-01T12:00:00Z",
          },
        ],
      }),
    );
    const changeHistoryPath = path.join(root, "hf_change_history.local.json");
    process.env.TACVERSE_WORKBENCH_CHANGE_HISTORY = changeHistoryPath;
    await fs.writeFile(
      changeHistoryPath,
      JSON.stringify({
        version: 1,
        repos: {
          "TacVerse/taccap-g1-wipe-mirror": {
            changes: [
              {
                dataset_name: "TacVerse/taccap-g1-wipe-mirror",
                created_at: "2026-09-01T10:00:00Z",
                episodes: 9,
                frames: 32_400,
                hours: 0.9,
              },
            ],
          },
        },
      }),
    );

    const response = await GET(
      new Request("http://localhost/api/workbench/statistics?org=TacVerse"),
    );
    const payload = (await response.json()) as {
      datasets: Array<{
        relativePath: string;
        dailyAdditions: Array<{
          day: string;
          episodes: number;
          frames: number;
          hours: number;
        }>;
      }>;
    };

    const datasetWithoutSuffix = payload.datasets.find(
      (dataset) => dataset.relativePath === "TacVerse/taccap-g1-wipe-mirror",
    );
    expect(datasetWithoutSuffix).toBeDefined();
    expect(datasetWithoutSuffix?.dailyAdditions).toEqual([]);
  });

  test("excludes merged post-processing datasets and reports the rule", async () => {
    await writeDataset("TacVerse/merged/taccap-g1-arrange-desk-items-09902");
    await writeDataset("TacVerse/merged/taccap-g1-operate-shoe-box-0812");
    await writeDataset("TacVerse/taccap-g1-arrange-desk-items-0902");

    const response = await GET(
      new Request("http://localhost/api/workbench/statistics?org=TacVerse"),
    );
    const payload = (await response.json()) as {
      datasets: Array<{ relativePath: string }>;
      statisticsFilter: {
        rule: string;
        excludedDatasets: Array<{
          relativePath: string;
          reason: string;
        }>;
      };
      displayReplayDataset: { relativePath: string } | null;
    };

    expect(response.status).toBe(200);
    expect(payload.datasets.map((dataset) => dataset.relativePath)).toEqual([
      "TacVerse/taccap-g1-arrange-desk-items-0902",
    ]);
    expect(payload.statisticsFilter).toEqual({
      rule: expect.stringContaining("exact path segment"),
      excludedDatasets: [
        {
          relativePath: "TacVerse/merged/taccap-g1-arrange-desk-items-09902",
          reason: "post-processing-merged-output",
        },
        {
          relativePath: "TacVerse/merged/taccap-g1-operate-shoe-box-0812",
          reason: "post-processing-merged-output",
        },
      ],
    });
    expect(payload.displayReplayDataset?.relativePath).toBe(
      "TacVerse/merged/taccap-g1-operate-shoe-box-0812",
    );
  });
});

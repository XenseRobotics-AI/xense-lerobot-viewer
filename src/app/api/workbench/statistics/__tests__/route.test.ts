import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GET } from "@/app/api/workbench/statistics/route";
import { writeWorkbenchWorkstationMappings } from "@/lib/workbench-config-store";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousWorkbenchLog = process.env.TACVERSE_WORKBENCH_DATASET_LOG;

async function writeDataset(
  repoId: string,
  info: Record<string, unknown> = {},
  hardware: Record<string, unknown> | null = null,
): Promise<void> {
  const dir = path.join(root, ...repoId.split("/"));
  await fs.mkdir(path.join(dir, "meta"), { recursive: true });
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.mkdir(path.join(dir, "videos"), { recursive: true });
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
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousWorkbenchLog === undefined) {
    delete process.env.TACVERSE_WORKBENCH_DATASET_LOG;
  } else {
    process.env.TACVERSE_WORKBENCH_DATASET_LOG = previousWorkbenchLog;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("Workbench statistics route", () => {
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
        units: [
          { side: "right", gripper_sn: "TCGU-right" },
          { side: "left", gripper_sn: "TCGU01A28Z0069m" },
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
        ],
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
      datasets: Array<{
        relativePath: string;
        total_episodes: number;
        total_frames: number;
        fps: number;
        lastModified: string | null;
        uploader: string | null;
        uploaderDisplayName: string | null;
        leftGripperSn: string | null;
        hf: {
          lastModified: string | null;
          uploader: string | null;
          uploaderDisplayName: string | null;
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.workstationMappings).toMatchObject({
      source: "stored",
      mappings: { TCGU01A28Z0069m: "D2" },
    });
    expect(payload.workstationMappings.defaults.TCGU01A28Z0033m).toBe("N0");
    expect(payload.datasets.map((dataset) => dataset.relativePath)).toEqual([
      "TacVerse/newer-0818",
      "TacVerse/older-0817",
    ]);
    expect(payload.datasets[0]).toMatchObject({
      total_episodes: 25,
      total_frames: 90_000,
      fps: 30,
      lastModified: "2026-08-18T10:00:00Z",
      uploader: "alice",
      uploaderDisplayName: "Alice",
      leftGripperSn: "TCGU01A28Z0069m",
      hf: {
        lastModified: "2026-08-18T10:00:00Z",
        uploader: "alice",
        uploaderDisplayName: "Alice",
      },
    });
    expect(payload.datasets[1]).toMatchObject({
      total_episodes: 11,
      total_frames: 54_000,
      fps: 30,
      lastModified: "2026-08-17T10:00:00Z",
      uploader: "XR-Bot3",
      uploaderDisplayName: "洪锐",
    });
  });
});

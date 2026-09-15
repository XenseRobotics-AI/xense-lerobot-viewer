import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/modelscope/catalog/route";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "modelscope-catalog-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  requestedUrls = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/openapi/v1/datasets?")) {
      return Response.json({
        success: true,
        data: {
          datasets: [
            {
              id: "XenseRobotics/TacVerse",
              file_size: 4096,
              downloads: 12,
              created_at: "2026-09-01T00:00:00Z",
              last_modified: "2026-09-05T06:00:00Z",
            },
          ],
          total_count: 1,
        },
      });
    }
    if (
      url.includes(
        "Root=nested%2Fcollection%2Fxtac-umi-g1-install-wire-harness-260915",
      )
    ) {
      return Response.json({
        Code: 200,
        Data: {
          Files: [
            {
              Name: "meta",
              Type: "tree",
              Path: "nested/collection/xtac-umi-g1-install-wire-harness-260915/meta",
              CommittedDate: 1788609600,
              Revision: "tree-sha",
            },
          ],
          TotalCount: 1,
        },
      });
    }
    if (url.includes("/repo/tree?")) {
      if (url.includes("Root=nested%2Fcollection")) {
        return Response.json({
          Code: 200,
          Data: {
            Files: [
              {
                Name: "xtac-umi-g1-install-wire-harness-260915",
                Type: "tree",
                Path: "nested/collection/xtac-umi-g1-install-wire-harness-260915",
              },
            ],
            TotalCount: 1,
          },
        });
      }
      if (url.includes("Root=nested")) {
        return Response.json({
          Code: 200,
          Data: {
            Files: [
              {
                Name: "collection",
                Type: "tree",
                Path: "nested/collection",
              },
            ],
            TotalCount: 1,
          },
        });
      }
      return Response.json({
        Code: 200,
        Data: {
          Files: [
            {
              Name: "nested",
              Type: "tree",
              Path: "nested",
              CommittedDate: 1788609600,
              Revision: "tree-sha",
            },
          ],
          TotalCount: 1,
        },
      });
    }
    if (
      url.includes(
        "FilePath=nested/collection/xtac-umi-g1-install-wire-harness-260915/meta/info.json",
      )
    ) {
      return Response.json({
        total_episodes: 4,
        total_frames: 7200,
        fps: 10,
        robot_type: "xtac_umi_g1",
      });
    }
    if (
      url.includes(
        "FilePath=nested/collection/xtac-umi-g1-install-wire-harness-260915/meta/xumi_collection_devices.json",
      )
    ) {
      return Response.json({
        version: 1,
        episodes: [
          {
            devices: {
              collector: { serial_number: "TCGU01A31Z0015B" },
              grippers: {
                left: { serial_number: "TCGU01A28Z0069m" },
              },
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected ModelScope request: ${url}`);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe("ModelScope catalog route", () => {
  test("lists datasets, reads LeRobot metadata, and writes the cache", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/modelscope/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org: "XenseRobotics/TacVerse" }),
      }),
    );
    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requestedUrls).toContain(
      "https://modelscope.cn/openapi/v1/datasets?owner=XenseRobotics&page_number=1&page_size=50&sort=last_modified",
    );
    expect(requestedUrls).toContain(
      "https://modelscope.cn/api/v1/datasets/XenseRobotics/TacVerse/repo/tree?Root=&PageNumber=1&PageSize=50&Revision=master",
    );
    expect(requestedUrls).toContain(
      "https://modelscope.cn/api/v1/datasets/XenseRobotics/TacVerse/repo/tree?Root=nested%2Fcollection&PageNumber=1&PageSize=50&Revision=master",
    );
    expect(requestedUrls).toContain(
      "https://modelscope.cn/api/v1/datasets/XenseRobotics/TacVerse/repo?Revision=master&FilePath=nested/collection/xtac-umi-g1-install-wire-harness-260915/meta/info.json",
    );
    expect(requestedUrls).toContain(
      "https://modelscope.cn/api/v1/datasets/XenseRobotics/TacVerse/repo?Revision=master&FilePath=nested/collection/xtac-umi-g1-install-wire-harness-260915/meta/xumi_collection_devices.json",
    );
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: {
        org: "TacVerse",
        datasets: [
          expect.objectContaining({
            repoId:
              "TacVerse/nested/collection/xtac-umi-g1-install-wire-harness-260915",
            totalEpisodes: 4,
            totalFrames: 7200,
            durationHours: 0.2,
            robotType: "xtac_umi_g1",
            collectorSerialNumber: "TCGU01A31Z0015B",
            leftGripperSn: "TCGU01A28Z0069m",
            metadataState: "ok",
            hubRepoId: "XenseRobotics/TacVerse",
            hubPath:
              "nested/collection/xtac-umi-g1-install-wire-harness-260915",
          }),
        ],
      },
    });

    const cache = path.join(
      root,
      ".xense-viewer",
      "modelscope-catalog",
      "TacVerse.json",
    );
    expect(JSON.parse(await fs.readFile(cache, "utf8"))).toMatchObject({
      org: "TacVerse",
      hubRepoId: "XenseRobotics/TacVerse",
      datasets: [{ downloads: null, storageBytes: null }],
    });
  });
});

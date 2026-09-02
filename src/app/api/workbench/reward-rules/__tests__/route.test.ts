import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/workbench/reward-rules/route";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;

beforeEach(async () => {
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "xense-workbench-reward-api-"),
  );
  process.env.LOCAL_DATASET_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function putRequest(org: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/workbench/reward-rules?org=${encodeURIComponent(org)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: body }),
    },
  );
}

describe("Workbench reward rules route", () => {
  test("returns default reward rules when no org config exists", async () => {
    const response = await GET(
      new Request("http://localhost/api/workbench/reward-rules?org=TacVerse"),
    );
    const payload = (await response.json()) as {
      source: string;
      enabled: boolean;
      dailyTargetHours: number;
      levels: Array<{ id: string }>;
      defaults: { enabled: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.source).toBe("defaults");
    expect(payload.enabled).toBe(true);
    expect(payload.dailyTargetHours).toBe(6);
    expect(payload.levels).toHaveLength(4);
    expect(payload.defaults.enabled).toBe(true);
  });

  test("saves rules independently for each organization", async () => {
    const firstSave = await PUT(
      putRequest("TacVerse", {
        enabled: true,
        dailyTargetHours: 7,
        levels: [
          {
            id: "low",
            label: "Low",
            minPercent: 0,
            maxPercent: 100,
            amount: 0,
          },
          {
            id: "high",
            label: "High",
            minPercent: 100,
            maxPercent: null,
            amount: 200,
          },
        ],
      }),
    );
    const secondSave = await PUT(
      putRequest("OtherOrg", {
        enabled: false,
        dailyTargetHours: 8,
        levels: [
          {
            id: "low",
            label: "Low",
            minPercent: 0,
            maxPercent: null,
            amount: 0,
          },
        ],
      }),
    );

    expect(firstSave.status).toBe(200);
    expect(secondSave.status).toBe(200);

    await expect(
      GET(
        new Request("http://localhost/api/workbench/reward-rules?org=TacVerse"),
      ).then((response) => response.json()),
    ).resolves.toMatchObject({
      source: "stored",
      dailyTargetHours: 7,
      enabled: true,
    });
  });

  test("rejects browser cross-origin writes", async () => {
    const response = await PUT(
      new NextRequest(
        "http://localhost/api/workbench/reward-rules?org=TacVerse",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://evil.example",
            "Sec-Fetch-Site": "cross-site",
          },
          body: JSON.stringify({
            rules: {
              enabled: true,
              dailyTargetHours: 6,
              levels: [
                {
                  id: "ok",
                  label: "OK",
                  minPercent: 0,
                  maxPercent: null,
                  amount: 0,
                },
              ],
            },
          }),
        },
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      code: "ORIGIN_REJECTED",
    });
    expect(response.status).toBe(403);
  });
});

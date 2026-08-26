import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/workbench/workstation-mappings/route";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-workbench-api-"));
  process.env.LOCAL_DATASET_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function putRequest(
  org: string,
  mappings: Record<string, string>,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/workbench/workstation-mappings?org=${encodeURIComponent(
      org,
    )}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings }),
    },
  );
}

describe("Workbench workstation mappings route", () => {
  test("returns default mappings when no org config exists", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workbench/workstation-mappings?org=TacVerse",
      ),
    );
    const payload = (await response.json()) as {
      source: string;
      mappings: Record<string, string>;
      defaults: Record<string, string>;
    };

    expect(response.status).toBe(200);
    expect(payload.source).toBe("defaults");
    expect(payload.mappings.TCGU01A28Z0033m).toBe("N0");
    expect(payload.defaults.TCGU01A28Z0071m).toBe("E4");
  });

  test("returns empty defaults for organizations without repo defaults", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workbench/workstation-mappings?org=OtherOrg",
      ),
    );
    const payload = (await response.json()) as {
      source: string;
      mappings: Record<string, string>;
      defaults: Record<string, string>;
    };

    expect(response.status).toBe(200);
    expect(payload.source).toBe("defaults");
    expect(payload.mappings).toEqual({});
    expect(payload.defaults).toEqual({});
  });

  test("saves mappings independently for each organization", async () => {
    const firstSave = await PUT(
      putRequest("TacVerse", { TCGU01A28Z0069m: "D2" }),
    );
    const secondSave = await PUT(
      putRequest("OtherOrg", { TCGU01A28Z0069m: "A1" }),
    );
    const tacverse = await GET(
      new Request(
        "http://localhost/api/workbench/workstation-mappings?org=TacVerse",
      ),
    );
    const other = await GET(
      new Request(
        "http://localhost/api/workbench/workstation-mappings?org=OtherOrg",
      ),
    );

    expect(firstSave.status).toBe(200);
    expect(secondSave.status).toBe(200);
    await expect(tacverse.json()).resolves.toMatchObject({
      source: "stored",
      mappings: { TCGU01A28Z0069m: "D2" },
    });
    await expect(other.json()).resolves.toMatchObject({
      source: "stored",
      mappings: { TCGU01A28Z0069m: "A1" },
    });
  });

  test("rejects browser cross-origin writes", async () => {
    const response = await PUT(
      new NextRequest(
        "http://localhost/api/workbench/workstation-mappings?org=TacVerse",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://evil.example",
            "Sec-Fetch-Site": "cross-site",
          },
          body: JSON.stringify({ mappings: { TCGU01A28Z0069m: "D2" } }),
        },
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      code: "ORIGIN_REJECTED",
    });
    expect(response.status).toBe(403);
  });
});

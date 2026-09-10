import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  GET,
  POST as CHECK,
} from "@/app/api/workbench/hf-download/check/route";
import { POST as DOWNLOAD } from "@/app/api/workbench/hf-download/download/route";
import {
  beginDatasetWrite,
  finishDatasetWrite,
  resetDatasetWriteLockForTests,
} from "@/lib/dataset-write-lock";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;

function request(url: string, body: unknown, origin?: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  source: "TacVerse/example",
  destinationRoot: "/tmp/lerobot",
  scope: "all",
  endpoint: "https://huggingface.co",
  token: "hf_test_only",
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-hf-download-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
});

afterAll(async () => {
  resetDatasetWriteLockForTests();
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe("HF download routes", () => {
  test("reports the configured default root without hard-coding a user", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).destinationRoot).toBe(path.resolve(root));
  });

  test("rejects unsafe sources before launching Python", async () => {
    for (const source of [
      "https://huggingface.co/TacVerse/example",
      "TacVerse/../example",
      "TacVerse/opendata/child/extra",
      "TacVerse\\example",
    ]) {
      const response = await CHECK(
        request("http://localhost/api/workbench/hf-download/check", {
          ...valid,
          source,
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  test("rejects endpoints outside the closed allowlist", async () => {
    const response = await CHECK(
      request("http://localhost/api/workbench/hf-download/check", {
        ...valid,
        endpoint: "https://attacker.example",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("rejects cross-origin checks and downloads", async () => {
    const check = await CHECK(
      request(
        "http://localhost/api/workbench/hf-download/check",
        valid,
        "https://attacker.example",
      ),
    );
    const download = await DOWNLOAD(
      request(
        "http://localhost/api/workbench/hf-download/download",
        { ...valid, revisionSha: "a".repeat(40) },
        "https://attacker.example",
      ),
    );
    expect(check.status).toBe(403);
    expect(download.status).toBe(403);
  });

  test("requires the checked SHA before resolving a download runtime", async () => {
    const response = await DOWNLOAD(
      request("http://localhost/api/workbench/hf-download/download", valid),
    );
    expect(response.status).toBe(400);
  });

  test("rejects a concurrent dataset writer before launching Python", async () => {
    const lease = beginDatasetWrite("metadata-sync", "TacVerse");
    try {
      const response = await DOWNLOAD(
        request("http://localhost/api/workbench/hf-download/download", {
          ...valid,
          revisionSha: "a".repeat(40),
        }),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("TacVerse");
    } finally {
      finishDatasetWrite(lease);
    }
  });
});

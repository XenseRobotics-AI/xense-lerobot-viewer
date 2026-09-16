import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  GET,
  POST as CHECK,
} from "@/app/api/workbench/modelscope-download/check/route";
import { POST as DOWNLOAD } from "@/app/api/workbench/modelscope-download/download/route";
import {
  beginDatasetWrite,
  finishDatasetWrite,
  resetDatasetWriteLockForTests,
} from "@/lib/dataset-write-lock";

let root: string;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousToken = process.env.MODELSCOPE_API_TOKEN;
const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];

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
  source: "TacVerse/nested/example",
  destinationRoot: "/tmp/lerobot-modelscope",
  scope: "all",
  concurrency: 2,
  token: "ms_test_only",
};

const fileBodies = new Map([
  ["nested/example/README.md", "readme"],
  ["nested/example/data/chunk-000.parquet", "parquet"],
  ["nested/example/meta/episodes/episode_000000.jsonl", '{"episode":0}\n'],
  ["nested/example/meta/info.json", '{"total_episodes":1}\n'],
]);

function tree(rootPath: string) {
  if (rootPath === "nested/example") {
    return [
      { Name: "data", Type: "tree", Path: "nested/example/data" },
      { Name: "meta", Type: "tree", Path: "nested/example/meta" },
      {
        Name: "README.md",
        Type: "blob",
        Path: "nested/example/README.md",
        Revision: "1111111111111111111111111111111111111111",
        Size: fileBodies.get("nested/example/README.md")?.length,
        Sha256: "readme-sha",
      },
    ];
  }
  if (rootPath === "nested/example/data") {
    return [
      {
        Name: "chunk-000.parquet",
        Type: "blob",
        Path: "nested/example/data/chunk-000.parquet",
        Revision: "2222222222222222222222222222222222222222",
        Size: fileBodies.get("nested/example/data/chunk-000.parquet")?.length,
        Sha256: "parquet-sha",
      },
    ];
  }
  if (rootPath === "nested/example/meta") {
    return [
      {
        Name: "episodes",
        Type: "tree",
        Path: "nested/example/meta/episodes",
      },
      {
        Name: "info.json",
        Type: "blob",
        Path: "nested/example/meta/info.json",
        Revision: "3333333333333333333333333333333333333333",
        Size: fileBodies.get("nested/example/meta/info.json")?.length,
        Sha256: "info-sha",
      },
    ];
  }
  if (rootPath === "nested/example/meta/episodes") {
    return [
      {
        Name: "episode_000000.jsonl",
        Type: "blob",
        Path: "nested/example/meta/episodes/episode_000000.jsonl",
        Revision: "3333333333333333333333333333333333333333",
        Size: fileBodies.get(
          "nested/example/meta/episodes/episode_000000.jsonl",
        )?.length,
        Sha256: "episode-sha",
      },
    ];
  }
  return [];
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-ms-download-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  delete process.env.MODELSCOPE_API_TOKEN;
  requestedUrls = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/repo/tree?")) {
      const parsed = new URL(url);
      const rootPath = parsed.searchParams.get("Root") ?? "";
      const files = tree(rootPath);
      return Response.json({
        Code: 200,
        Message: "success",
        Data: {
          Files: files,
          TotalCount: files.length,
        },
      });
    }
    if (url.includes("/repo?")) {
      const parsed = new URL(url);
      const filePath = parsed.searchParams.get("FilePath") ?? "";
      const body = fileBodies.get(filePath);
      if (body === undefined) {
        return new Response("missing", { status: 404 });
      }
      return new Response(body, {
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }
    throw new Error(`Unexpected ModelScope request: ${url}`);
  }) as typeof fetch;
});

afterEach(async () => {
  resetDatasetWriteLockForTests();
  globalThis.fetch = originalFetch;
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousToken === undefined) delete process.env.MODELSCOPE_API_TOKEN;
  else process.env.MODELSCOPE_API_TOKEN = previousToken;
  await fs.rm(root, { recursive: true, force: true });
});

describe("ModelScope download routes", () => {
  test("reports the configured default root", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).destinationRoot).toBe(path.resolve(root));
  });

  test("rejects unsafe sources", async () => {
    for (const source of [
      "https://modelscope.cn/datasets/TacVerse/example",
      "TacVerse/../example",
      "TacVerse\\example",
      "TacVerse",
    ]) {
      const response = await CHECK(
        request("http://localhost/api/workbench/modelscope-download/check", {
          ...valid,
          source,
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  test("rejects invalid download concurrency", async () => {
    for (const concurrency of [0, 9, 1.5, "fast", true]) {
      const response = await CHECK(
        request("http://localhost/api/workbench/modelscope-download/check", {
          ...valid,
          concurrency,
        }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("concurrency");
    }
  });

  test("rejects cross-origin checks and downloads", async () => {
    const check = await CHECK(
      request(
        "http://localhost/api/workbench/modelscope-download/check",
        valid,
        "https://attacker.example",
      ),
    );
    const download = await DOWNLOAD(
      request(
        "http://localhost/api/workbench/modelscope-download/download",
        { ...valid, revisionSha: "a".repeat(64) },
        "https://attacker.example",
      ),
    );
    expect(check.status).toBe(403);
    expect(download.status).toBe(403);
  });

  test("checks a nested dataset and normalizes physical ModelScope paths", async () => {
    const response = await CHECK(
      request("http://localhost/api/workbench/modelscope-download/check", {
        ...valid,
        source: "XenseRobotics/TacVerse/nested/example",
        destinationRoot: root,
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      source: "TacVerse/nested/example",
      repoId: "TacVerse/nested/example",
      hubRepoId: "XenseRobotics/TacVerse",
      repoPath: "nested/example",
      targetPath: path.join(root, "TacVerse", "nested", "example"),
      fileCount: 4,
      sizeBytes: 48,
      unknownSizeFiles: 0,
      scopeExists: false,
      matchesRevision: false,
    });
    expect(payload.revisionSha).toMatch(/^[a-f0-9]{64}$/);
  });

  test("downloads and promotes the checked dataset", async () => {
    const checkResponse = await CHECK(
      request("http://localhost/api/workbench/modelscope-download/check", {
        ...valid,
        destinationRoot: root,
      }),
    );
    const check = await checkResponse.json();
    const response = await DOWNLOAD(
      request("http://localhost/api/workbench/modelscope-download/download", {
        ...valid,
        destinationRoot: root,
        revisionSha: check.revisionSha,
      }),
    );
    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.type === "progress")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: {
        source: "TacVerse/nested/example",
        hubRepoId: "XenseRobotics/TacVerse",
        repoPath: "nested/example",
        fileCount: 4,
        concurrency: 2,
      },
    });
    const target = path.join(root, "TacVerse", "nested", "example");
    await expect(
      fs.readFile(path.join(target, "meta", "info.json"), "utf8"),
    ).resolves.toBe(fileBodies.get("nested/example/meta/info.json"));
    await expect(
      fs.readFile(path.join(target, "data", "chunk-000.parquet"), "utf8"),
    ).resolves.toBe(fileBodies.get("nested/example/data/chunk-000.parquet"));
    const state = JSON.parse(
      await fs.readFile(
        path.join(
          root,
          ".xense-viewer",
          "modelscope-download-state",
          "TacVerse",
          "nested",
          "example.json",
        ),
        "utf8",
      ),
    );
    expect(state).toMatchObject({
      source: "TacVerse/nested/example",
      hubRepoId: "XenseRobotics/TacVerse",
      repoPath: "nested/example",
      fullSha: check.revisionSha,
      metaSha: check.revisionSha,
    });
  });

  test("rejects nested target writers before downloading", async () => {
    const lease = beginDatasetWrite(
      "modelscope-download",
      "TacVerse/nested/example",
      path.resolve(root, "TacVerse", "nested"),
    );
    try {
      const response = await DOWNLOAD(
        request("http://localhost/api/workbench/modelscope-download/download", {
          ...valid,
          destinationRoot: root,
          revisionSha: "a".repeat(64),
        }),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain(
        "TacVerse/nested/example",
      );
    } finally {
      finishDatasetWrite(lease);
    }
  });
});

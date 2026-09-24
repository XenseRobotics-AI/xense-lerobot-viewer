import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/tacverse-impact/route";

const originalFetch = globalThis.fetch;
const originalProxyEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
};

beforeEach(() => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/collections/TacVerse/tacverse")) {
      throw new Error("fetch failed");
    }
    if (url.includes("/api/datasets/TacVerse/opendata/tree/")) {
      return Response.json([]);
    }
    if (url.includes("/api/datasets/TacVerse/opendata/discussions")) {
      return Response.json({ count: 0, discussions: [] });
    }
    if (url.includes("/api/datasets/TacVerse/opendata")) {
      return Response.json({
        likes: 7,
        downloads: 12,
        downloadsAllTime: 42,
        lastModified: "2026-09-20T00:00:00Z",
        siblings: [],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("TacVerse Impact route", () => {
  test("keeps public opendata accessible when the collection request fails", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/tacverse-impact?scope=public"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      schemaVersion: 6,
      accessMode: "public",
      repository: {
        id: "TacVerse/opendata",
        likes: 7,
        downloads: 12,
      },
      sourceStatus: {
        collection: "unavailable",
        metadata: "live",
      },
    });
    expect(payload.repositories).toEqual([
      expect.objectContaining({
        id: "TacVerse/opendata",
        downloads: 42,
        scope: "standalone",
      }),
    ]);
    expect(payload.sourceViews.opendata.metrics.totalDownloads).toBe(42);
    expect(payload.sourceStatus.message).toContain("collection request failed");
  });
});

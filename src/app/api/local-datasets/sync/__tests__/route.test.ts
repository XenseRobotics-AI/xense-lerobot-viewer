import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/local-datasets/sync/route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/local-datasets/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("local dataset sync route", () => {
  test("keeps full-dataset sync disabled", async () => {
    const response = await POST(request({ source: "TacVerse" }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(503);
    expect(payload.error).toContain("Hugging Face sync is disabled");
  });

  test("allows metadata-only requests through the full-sync guard", async () => {
    // An invalid source stops after target validation, before filesystem or
    // Python setup. Reaching that 400 proves metadataOnly bypassed the 503.
    const response = await POST(
      request({ source: "../invalid", metadataOnly: true }),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe(
      "`source` must be a plain Hugging Face org name.",
    );
  });
});

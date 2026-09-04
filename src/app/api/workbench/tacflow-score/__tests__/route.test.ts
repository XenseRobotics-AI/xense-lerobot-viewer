import { describe, expect, test } from "bun:test";
import { POST } from "@/app/api/workbench/tacflow-score/route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/workbench/tacflow-score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Workbench TACFLOW batch score route", () => {
  test("rejects invalid organization and date ranges before touching datasets", async () => {
    const invalidOrg = await POST(
      post({
        organization: "TacVerse/../escape",
        startDate: "2026-09-03",
        endDate: "2026-09-04",
      }) as never,
    );
    expect(invalidOrg.status).toBe(400);
    const invalidDate = await POST(
      post({
        organization: "TacVerse",
        startDate: "2026-02-30",
        endDate: "2026-09-04",
      }) as never,
    );
    expect(invalidDate.status).toBe(400);
  });

  test("rejects invalid Doctor check weights", async () => {
    const response = await POST(
      post({
        organization: "TacVerse",
        startDate: "2026-09-03",
        endDate: "2026-09-04",
        weights: { metadata: -1 },
      }) as never,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("weights"),
    });
  });
});

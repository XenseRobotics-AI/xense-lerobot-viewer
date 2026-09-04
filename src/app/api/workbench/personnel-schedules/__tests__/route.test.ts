import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/workbench/personnel-schedules/route";
import { WORKBENCH_PERSONNEL_BASELINE_DAY } from "@/components/workbench-personnel-mapping-editor";

function putRequest(body: unknown, headers?: HeadersInit): NextRequest {
  return new NextRequest(
    "http://localhost/api/workbench/personnel-schedules?org=TacVerse",
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
}

describe("workbench personnel schedules route", () => {
  test("requires an organization", async () => {
    const response = await GET(
      new Request("http://localhost/api/workbench/personnel-schedules"),
    );
    expect(response.status).toBe(400);
  });

  test("reads the repository config without response caching", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workbench/personnel-schedules?org=TacVerse",
      ),
    );
    const payload = (await response.json()) as {
      org: string;
      people: Array<{ id: string }>;
      schedules: Record<string, unknown>;
    };
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.org).toBe("TacVerse");
    expect(payload.people.length).toBeGreaterThan(0);
    expect(payload.schedules[WORKBENCH_PERSONNEL_BASELINE_DAY]).toBeArray();
  });

  test("rejects cross-origin writes before touching the repository", async () => {
    const response = await PUT(
      putRequest(
        { config: { people: [], schedules: {} } },
        { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      ),
    );
    expect(response.status).toBe(403);
  });

  test("returns validation errors without writing invalid config", async () => {
    const response = await PUT(
      putRequest({
        config: {
          people: [{ id: "person", displayName: "人员", email: "" }],
          schedules: {
            "2026-09-03": [
              {
                workstation: "A1",
                members: [{ personId: "person", creditFactor: 0 }],
              },
            ],
          },
        },
      }),
    );
    const payload = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(payload.error).toContain("creditFactor must be a positive number");
  });
});

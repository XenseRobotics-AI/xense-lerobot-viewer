import { describe, expect, test } from "bun:test";
import { GET, PUT } from "@/app/api/workbench/personnel-schedules/route";
import { WORKBENCH_PERSONNEL_BASELINE_DAY } from "@/components/workbench-personnel-mapping-editor";

describe("workbench personnel schedules compatibility route", () => {
  test("requires an organization", async () => {
    const response = await GET(
      new Request("http://localhost/api/workbench/personnel-schedules"),
    );
    expect(response.status).toBe(400);
  });

  test("derives the legacy view without response caching", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workbench/personnel-schedules?org=TacVerse",
      ),
    );
    const payload = (await response.json()) as {
      org: string;
      people: Array<{ id: string; email: string }>;
      schedules: Record<string, unknown>;
    };
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.org).toBe("TacVerse");
    expect(payload.people.length).toBeGreaterThan(0);
    expect(payload.schedules[WORKBENCH_PERSONNEL_BASELINE_DAY]).toBeArray();
    expect(payload.people.every((person) => person.email === "")).toBeTrue();
  });

  test("rejects every legacy partial write with 410", async () => {
    const response = await PUT();
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      code: "LEGACY_CONFIGURATION_READ_ONLY",
      configurationEndpoint: "/api/workbench/configuration",
    });
  });
});

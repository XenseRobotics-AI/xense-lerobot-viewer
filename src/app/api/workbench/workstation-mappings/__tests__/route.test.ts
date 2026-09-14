import { describe, expect, test } from "bun:test";
import { GET, PUT } from "@/app/api/workbench/workstation-mappings/route";

describe("Workbench workstation mappings compatibility route", () => {
  test("derives legacy mappings from the unified configuration", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workbench/workstation-mappings?org=TacVerse",
      ),
    );
    const payload = (await response.json()) as {
      source: string;
      mappings: Record<string, string>;
      defaults: Record<string, string>;
      readOnly: boolean;
      configurationEndpoint: string;
    };

    expect(response.status).toBe(200);
    expect(payload.mappings.TCGU01A28Z0033m).toBe("N0");
    expect(payload.defaults.TCGU01A28Z0071m).toBe("E4");
    expect(payload.readOnly).toBeTrue();
    expect(payload.configurationEndpoint).toBe("/api/workbench/configuration");
  });

  test("returns empty derived mappings for unknown organizations", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workbench/workstation-mappings?org=OtherOrg",
      ),
    );
    await expect(response.json()).resolves.toMatchObject({
      mappings: {},
      defaults: {},
      readOnly: true,
    });
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

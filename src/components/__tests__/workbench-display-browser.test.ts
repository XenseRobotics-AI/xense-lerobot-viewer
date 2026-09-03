import { describe, expect, test } from "bun:test";
import {
  isWorkbenchOrganizationDisplayPath,
  requestWorkbenchDisplayFullscreen,
} from "@/components/workbench-display-browser";

describe("Workbench display entry", () => {
  test("enables Display for root and local episode Workbench routes", () => {
    expect(isWorkbenchOrganizationDisplayPath("/")).toBe(true);
    expect(
      isWorkbenchOrganizationDisplayPath(
        "/_local/VGFjVmVyc2UvdGFjY2FwLWcxLW9wZXJhdGUtc2hvZS1ib3gtMDgxNw/episode_0",
      ),
    ).toBe(true);
    expect(
      isWorkbenchOrganizationDisplayPath(
        "/_local/VGFjVmVyc2UvdGFjY2FwLWcxLW9wZXJhdGUtc2hvZS1ib3gtMDgxNw/episode_12/",
      ),
    ).toBe(true);
    expect(
      isWorkbenchOrganizationDisplayPath("/TacVerse/example-dataset/episode_0"),
    ).toBe(false);
    expect(isWorkbenchOrganizationDisplayPath("/_local/example-dataset")).toBe(
      false,
    );
  });
});

describe("Workbench display fullscreen fallback", () => {
  test("reports a successful Fullscreen API request", async () => {
    let requested = false;
    const result = await requestWorkbenchDisplayFullscreen({
      requestFullscreen: async () => {
        requested = true;
      },
    });

    expect(requested).toBe(true);
    expect(result).toBe(true);
  });

  test("falls back when fullscreen is unsupported or rejected", async () => {
    expect(await requestWorkbenchDisplayFullscreen({})).toBe(false);
    expect(
      await requestWorkbenchDisplayFullscreen({
        requestFullscreen: async () => {
          throw new Error("Permission denied");
        },
      }),
    ).toBe(false);
  });
});

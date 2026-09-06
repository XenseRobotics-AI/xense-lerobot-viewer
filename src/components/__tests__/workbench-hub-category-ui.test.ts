import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("Workbench Hub category UI contract", () => {
  test("owns the radio filter above both statistics views and hides it for checks", async () => {
    const parent = await source("dataset-review-panel.tsx");
    expect(parent).toContain("Dataset category");
    expect(parent).toContain("All datasets");
    for (const label of [
      "TacVerse/taccap-g1 · Dated",
      "TacVerse/xtac-umi-g1",
      "TacVerse/taccap-g1 · Merged",
      "Folder repositories",
      "Other datasets",
    ]) {
      expect(parent).toContain(label);
    }
    expect(parent).toContain('workbenchView !== "checks"');
    expect(parent).toContain('name="workbenchHubCategory"');
  });

  test("persists valid URL state and fixes both statistics views to TacVerse", async () => {
    const parent = await source("dataset-review-panel.tsx");
    expect(parent).toContain('searchParams.get("workbenchHubCategory")');
    expect(parent).toContain('url.searchParams.delete("workbenchHubCategory")');
    expect(parent).toContain(
      'url.searchParams.set("workbenchHubCategory", hubCategoryFilter)',
    );
    expect(parent).toContain(
      'workbenchView === "checks" ? organization : "TacVerse"',
    );
    expect(parent).toContain('organization="TacVerse"');
    expect(parent).toContain("categoryFilter={hubCategoryFilter}");
  });

  test("passes the category to both read-only API requests", async () => {
    const datasetStatistics = await source("workbench-dataset-statistics.tsx");
    const grouping = await source("workbench-grouping-panel.tsx");
    expect(datasetStatistics).toContain(
      '"/api/workbench/dataset-statistics?category="',
    );
    expect(grouping).toContain('"&category="');
    expect(grouping).toContain("categoryRangeCheckPendingRef");
    expect(grouping).toContain("categoryTotal - hubScope.localMatchedTotal");
  });
});

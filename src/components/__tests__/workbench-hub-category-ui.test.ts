import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("Workbench Hub category UI contract", () => {
  test("owns the checkbox filter above both statistics views and hides it for checks", async () => {
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
    expect(parent).toContain('type="checkbox"');
    expect(parent).not.toContain('type="radio"');
  });

  test("persists valid URL state and fixes both statistics views to TacVerse", async () => {
    const parent = await source("dataset-review-panel.tsx");
    expect(parent).toContain('searchParams.get("workbenchHubCategory")');
    expect(parent).toContain('url.searchParams.delete("workbenchHubCategory")');
    expect(parent).toContain(
      'url.searchParams.set("workbenchHubCategory", serialized)',
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

  test("keeps Rule, Avg / ep, and final Reward aligned across UI, CSV, and fullscreen", async () => {
    const grouping = await source("workbench-grouping-panel.tsx");
    const avgHeader = grouping.indexOf(">Avg / ep</th>");
    const ruleHeader = grouping.lastIndexOf(">Rule</th>", avgHeader);
    const rewardHeader = grouping.indexOf(">Reward</th>", avgHeader);
    expect(ruleHeader).toBeGreaterThanOrEqual(0);
    expect(avgHeader).toBeGreaterThan(ruleHeader);
    expect(rewardHeader).toBeGreaterThan(avgHeader);

    const csvBlock = grouping.slice(
      grouping.indexOf("const csv = workbenchCsv"),
    );
    expect(csvBlock.indexOf(`"rule"`)).toBeLessThan(
      csvBlock.indexOf(`"avg_per_ep"`),
    );
    expect(csvBlock.indexOf(`"avg_per_ep"`)).toBeLessThan(
      csvBlock.indexOf(`"reward"`),
    );
    expect(grouping).toContain(
      "averageEpisodeSeconds: row.reward.averageEpisodeSeconds",
    );
    expect(grouping).toContain("durationMultiplier: row.reward.multiplier");

    const display = await source("workbench-display.tsx");
    const displayAvg = display.indexOf(">Avg / ep</th>");
    expect(display.lastIndexOf(">Rule</th>", displayAvg)).toBeLessThan(
      displayAvg,
    );
    expect(display.indexOf(">Reward</th>", displayAvg)).toBeGreaterThan(
      displayAvg,
    );
  });
});

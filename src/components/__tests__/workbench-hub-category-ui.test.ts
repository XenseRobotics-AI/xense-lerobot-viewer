import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("Workbench Hub category UI contract", () => {
  test("owns the checkbox filter above both statistics views and hides it for checks", async () => {
    const parent = await source("dataset-review-panel.tsx");
    for (const key of [
      "workbench.datasetCategory",
      "workbench.allDatasetsCategory",
      "workbench.datedCategory",
      "workbench.xtacCategory",
      "workbench.mergedCategory",
      "workbench.folderRepositories",
      "workbench.otherDatasets",
    ]) {
      expect(parent).toContain(`t("${key}")`);
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
    const avgHeader = grouping.indexOf('t("workbench.avgPerEpisode")');
    const ruleHeader = grouping.lastIndexOf('t("workbench.rule")', avgHeader);
    const rewardHeader = grouping.indexOf('t("workbench.reward")', avgHeader);
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
    const displayAvg = display.indexOf('t("workbench.avgPerEpisode")');
    const displayRule = display.lastIndexOf('t("workbench.rule")', displayAvg);
    const displayReward = display.indexOf('t("workbench.reward")', displayAvg);
    expect(displayRule).toBeGreaterThanOrEqual(0);
    expect(displayRule).toBeLessThan(displayAvg);
    expect(displayReward).toBeGreaterThan(displayAvg);
  });

  test("calculates workstation rewards only after source rows are aggregated", async () => {
    const grouping = await source("workbench-grouping-panel.tsx");
    const sourceRowsStart = grouping.indexOf(
      "const sourceWorkstationDashboardRows",
    );
    const workstationRowsStart = grouping.indexOf(
      "const workstationDashboardRows",
    );
    expect(sourceRowsStart).toBeGreaterThanOrEqual(0);
    expect(workstationRowsStart).toBeGreaterThan(sourceRowsStart);
    expect(grouping.slice(sourceRowsStart, workstationRowsStart)).not.toContain(
      "evaluateWorkbenchRewardRules",
    );
    expect(grouping).toContain(
      "const projectedRewardAmount = workstationDashboardRows.reduce(",
    );
    expect(grouping).toContain(
      "reward: evaluateWorkbenchRewardRules(\n            row.hours,",
    );
  });
});

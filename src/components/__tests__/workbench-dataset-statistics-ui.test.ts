import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function componentSource(
  file = "workbench-dataset-statistics.tsx",
): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("TacVerse dataset statistics UI contract", () => {
  test("keeps the requested KPI set and removes daily delta controls", async () => {
    const source = await componentSource();
    const labels = [
      't("workbench.datasets")',
      't("common.episodes")',
      't("common.frames")',
      't("common.hours")',
      't("workbench.issuesOnly")',
      't("workbench.downloads")',
    ];
    for (const label of labels) expect(source).toContain(label);
    expect(source).not.toContain("New episodes");
    expect(source).not.toContain("New hours");
    expect(source).not.toContain("Target completion");
    expect(source).not.toContain("Daily target");
  });

  test("keeps the table columns in the fixed order without Checks", async () => {
    const source = await componentSource();
    const labels = [
      't("workbench.dataset")',
      "robot_type",
      "Updated",
      't("workbench.downloads")',
      "Local",
      't("common.episodes")',
      't("common.frames")',
      "Hours",
      't("workbench.avgPerEpisode")',
    ];
    for (const label of labels) {
      expect(source).toContain(label);
    }
    expect(source).not.toContain(">Checks</th>");
  });

  test("supports Folder expansion, mixed robot types, and partial metrics", async () => {
    const source = await componentSource();
    expect(source).toContain("expandedFolders");
    expect(source).toContain("workbench.toggleChildren");
    expect(source).toContain("workbench.robotTypes");
    expect(source).toContain("metricsState");
    expect(source).toContain("item.hubUrl");
  });

  test("surfaces metadata byte totals and transfer rate while syncing", async () => {
    const source = await componentSource("dataset-review-panel.tsx");
    expect(source).toContain("bytesPerSecond");
    expect(source).toContain("formatTransferRate");
    expect(source).toContain("workbench.waitingNetworkBytes");
  });

  test("uses the fixed title and both non-persistent sort options", async () => {
    const source = await componentSource();
    expect(source).toContain("workbench.datasetStatistics");
    expect(source).toContain("workbench.recentlyUpdated");
    expect(source).toContain("workbench.recentlyCreated");
    expect(source).not.toContain("localStorage");
  });

  test("localizes the statistics scope rule and grouped hour details", async () => {
    const statistics = await componentSource(
      "workbench-statistics-filter-notice.tsx",
    );
    const grouping = await componentSource("workbench-grouping-panel.tsx");

    expect(statistics).toContain('t("workbench.statisticsScopeRule")');
    expect(statistics).not.toContain("{filter.rule}");
    expect(grouping).toContain('t("common.hours")');
    expect(grouping).not.toContain('" hours"');
  });
});

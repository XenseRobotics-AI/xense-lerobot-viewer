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
      'label="Datasets"',
      'label="Episodes"',
      'label="Frames"',
      'label="Recorded hours"',
      'label="Issues"',
      'label="Downloads"',
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
      ">Dataset</th>",
      ">robot_type</th>",
      ">Updated</th>",
      ">Downloads</th>",
      ">Local</th>",
      ">Episodes</th>",
      ">Frames</th>",
      ">Hours</th>",
      ">Avg / ep</th>",
    ];
    let previous = -1;
    for (const label of labels) {
      const position = source.indexOf(label);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(source).not.toContain(">Checks</th>");
  });

  test("supports Folder expansion, mixed robot types, and partial metrics", async () => {
    const source = await componentSource();
    expect(source).toContain("expandedFolders");
    expect(source).toContain("Toggle children for");
    expect(source).toContain("robot types");
    expect(source).toContain("metricsState");
    expect(source).toContain("item.hubUrl");
  });

  test("surfaces metadata byte totals and transfer rate while syncing", async () => {
    const source = await componentSource("dataset-review-panel.tsx");
    expect(source).toContain("bytesPerSecond");
    expect(source).toContain("formatTransferRate");
    expect(source).toContain("waiting for network bytes");
  });

  test("uses the fixed title and both non-persistent sort options", async () => {
    const source = await componentSource();
    expect(source).toContain("Dataset statistics/TacVerse");
    expect(source).toContain("Recently updated");
    expect(source).toContain("Recently created");
    expect(source).not.toContain("localStorage");
  });
});

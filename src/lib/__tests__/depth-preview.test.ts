import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { depthPreviewFilter, depthRangeLevels } from "@/lib/depth-preview";

async function datasetWithStats(stats: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "depth-preview-"));
  await fs.mkdir(path.join(root, "meta"));
  await fs.writeFile(
    path.join(root, "meta", "stats.json"),
    JSON.stringify(stats),
  );
  return root;
}

describe("depthRangeLevels", () => {
  test("uses the stream's recorded maximum, in levels", async () => {
    const root = await datasetWithStats({ depth: { max: [[[0.0632]]] } });
    expect(await depthRangeLevels(root, "depth")).toBe(259);
  });

  test("never stretches a near-empty stream past the floor", async () => {
    const root = await datasetWithStats({ depth: { max: [[[0.0001]]] } });
    expect(await depthRangeLevels(root, "depth")).toBe(16);
  });

  test("falls back to the full range without usable stats", async () => {
    const root = await datasetWithStats({ other: { max: [[[0.5]]] } });
    expect(await depthRangeLevels(root, "depth")).toBe(4095);
    expect(await depthRangeLevels("/nonexistent", "depth")).toBe(4095);
  });
});

test("the filter stretches to the range before colouring", () => {
  const filter = depthPreviewFilter(259);
  expect(filter.startsWith("lut=y='4095*sqrt(min(val/259,1))'")).toBe(true);
  expect(filter).toContain("lutrgb=");
});

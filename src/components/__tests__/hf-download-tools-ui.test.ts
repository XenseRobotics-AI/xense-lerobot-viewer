import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("Workbench HF download tools UI contract", () => {
  test("places the tab immediately after Current dataset checks", async () => {
    const parent = await source("dataset-review-panel.tsx");
    const checks = parent.indexOf(
      '["checks", t("workbench.currentDatasetChecks")]',
    );
    const download = parent.indexOf(
      '["hf-download", t("workbench.hfDownloadTools")]',
    );
    expect(checks).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(checks);
    expect(parent.slice(checks, download)).not.toContain('["grouping"');
  });

  test("keeps Hub credentials above the page and passes endpoint and draft token", async () => {
    const parent = await source("dataset-review-panel.tsx");
    expect(parent).toContain('workbenchView !== "hf-download"');
    expect(parent).toContain("endpoint={statisticsEndpoint}");
    expect(parent).toContain("token={statisticsToken}");
    expect(parent).toContain('t("workbench.checkAccount")');
    const panel = await source("hf-download-panel.tsx");
    expect(panel).not.toContain("checkHfAccount");
    expect(panel).not.toContain("clearHfAccount");
  });

  test("defaults to all files and requires check plus confirmation", async () => {
    const panel = await source("hf-download-panel.tsx");
    expect(panel).toContain('useState<HfDownloadScope>("all")');
    expect(panel).toContain("checkHfDownload(nextRequest");
    expect(panel).toContain(
      "if (!check || !checkedRequest || !confirmed) return",
    );
    expect(panel).toContain('name="hfDownloadScope"');
    expect(panel).toContain('value="meta"');
  });

  test("loads the server root, supports Browse, progress, cancel, and result details", async () => {
    const panel = await source("hf-download-panel.tsx");
    for (const text of [
      "readHfDownloadRoot",
      "/api/local-datasets/pick-folder",
      'role="progressbar"',
      "abortRef.current?.abort()",
      "result.backupPath",
      "result.revisionSha",
      "result.metaOnly",
    ]) {
      expect(panel).toContain(text);
    }
  });
});

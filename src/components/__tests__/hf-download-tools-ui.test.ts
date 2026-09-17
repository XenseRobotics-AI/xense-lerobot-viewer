import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("Workbench dataset download tools UI contract", () => {
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
    expect(panel).toContain('provider: "huggingface"');
    expect(panel).toContain('scope: "all"');
    expect(panel).toContain("useSyncExternalStore");
    expect(panel).toContain("downloadPanelState");
    expect(panel).toContain("DEFAULT_DOWNLOAD_CONCURRENCY");
    expect(panel).toContain('type="range"');
    expect(panel).toContain("workbench.hfDownloadConcurrency");
    expect(panel).toContain("checkModelScopeDownload");
    expect(panel).toContain("startModelScopeDownload");
    expect(panel).toContain("workbench.hfDownloadProvider");
    expect(panel).toContain("queueText");
    expect(panel).toContain("DEFAULT_QUEUE_CONCURRENCY");
    expect(panel).toContain("queueConcurrency");
    expect(panel).toContain("Math.min(queueConcurrency, runnable.length)");
    expect(panel).toContain("runQueueCheck");
    expect(panel).toContain("runQueueDownload");
    expect(panel).toContain("workbench.hfDownloadQueueConfirm");
    expect(panel).toContain("checkHfDownload(");
    expect(panel).toContain("checkModelScopeDownload(");
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
      "readModelScopeDownloadRoot",
      "/api/local-datasets/pick-folder",
      'role="progressbar"',
      "downloadAbortRef.current?.abort()",
      "result.backupPath",
      "result.revisionSha",
      "result.metaOnly",
    ]) {
      expect(panel).toContain(text);
    }
  });
});

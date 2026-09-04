import { describe, expect, test } from "bun:test";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import type { WorkbenchTacFlowScoreLedgerEntry } from "@/types/workbench-score.types";
import {
  isWorkbenchTacFlowScoreCacheHit,
  normalizeWorkbenchScoreDay,
  normalizeWorkbenchScoreOrganization,
  resolveWorkbenchDatasetAbsolutePath,
  selectWorkbenchDatasetsForScore,
} from "@/lib/workbench-score-batch";

function dataset(relativePath: string): LocalDatasetSummary {
  return { relativePath } as LocalDatasetSummary;
}

describe("Workbench score dataset selection", () => {
  test("validates date/org and filters exact merged segments", () => {
    expect(normalizeWorkbenchScoreOrganization(" TacVerse ")).toBe("TacVerse");
    expect(normalizeWorkbenchScoreOrganization("TacVerse/other")).toBeNull();
    expect(normalizeWorkbenchScoreDay("2026-02-30")).toBeNull();
    expect(normalizeWorkbenchScoreDay("2026-09-03")).toBe("2026-09-03");
    expect(normalizeWorkbenchScoreDay("2026-09-03T00:00")).toBe("2026-09-03");

    const datasets = [
      dataset("TacVerse/z-task-0903"),
      dataset("TacVerse/merged/z-task-0903"),
      dataset("TacVerse/merged-results-0903"),
      dataset("OtherOrg/other-task-0903"),
      dataset("TacVerse/no-suffix"),
    ];
    const metadata = new Map([
      ["TacVerse/no-suffix", { lastModified: "2026-09-03T04:00:00Z" }],
    ]);

    expect(
      selectWorkbenchDatasetsForScore(
        datasets,
        "TacVerse",
        "2026-09-03",
        "2026-09-04",
        metadata,
      ).map((entry) => entry.relativePath),
    ).toEqual([
      "TacVerse/merged-results-0903",
      "TacVerse/no-suffix",
      "TacVerse/z-task-0903",
    ]);
  });

  test("only reuses a scored entry with the same fingerprint, version, and weights", () => {
    const entry = {
      datasetPath: "TacVerse/task-0903",
      doctorReport: {},
      score: 100,
      grade: "A",
      rows: [],
      tacflowVersion: "test-ts",
      checkWeights: { metadata: 2 },
      datasetFingerprint: "fingerprint",
      scoredAt: "2026-09-04T00:00:00.000Z",
      status: "scored",
    } as WorkbenchTacFlowScoreLedgerEntry;
    expect(
      isWorkbenchTacFlowScoreCacheHit(entry, "fingerprint", "test-ts", {
        metadata: 2,
      }),
    ).toBe(true);
    expect(
      isWorkbenchTacFlowScoreCacheHit(entry, "changed", "test-ts", {
        metadata: 2,
      }),
    ).toBe(false);
    expect(
      isWorkbenchTacFlowScoreCacheHit(entry, "fingerprint", "new-ts", {
        metadata: 2,
      }),
    ).toBe(false);
    expect(
      isWorkbenchTacFlowScoreCacheHit(entry, "fingerprint", "test-ts", {
        metadata: 1,
      }),
    ).toBe(false);
    expect(
      isWorkbenchTacFlowScoreCacheHit(
        { ...entry, status: "retry" },
        "fingerprint",
        "test-ts",
        { metadata: 2 },
      ),
    ).toBe(false);
  });

  test("rejects traversal and absolute dataset paths", () => {
    expect(
      resolveWorkbenchDatasetAbsolutePath("/tmp/root", "TacVerse/task"),
    ).toBe("/tmp/root/TacVerse/task");
    expect(
      resolveWorkbenchDatasetAbsolutePath("/tmp/root", "../task"),
    ).toBeNull();
    expect(
      resolveWorkbenchDatasetAbsolutePath("/tmp/root", "TacVerse/../task"),
    ).toBeNull();
    expect(
      resolveWorkbenchDatasetAbsolutePath("/tmp/root", "/tmp/task"),
    ).toBeNull();
    expect(
      resolveWorkbenchDatasetAbsolutePath("/tmp/root", "C:\\task"),
    ).toBeNull();
  });
});

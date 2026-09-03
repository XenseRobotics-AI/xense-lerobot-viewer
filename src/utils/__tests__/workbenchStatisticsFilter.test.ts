import { describe, expect, test } from "bun:test";
import {
  createWorkbenchStatisticsFilterSummary,
  filterWorkbenchStatisticsDatasets,
  isWorkbenchStatisticsExcludedDataset,
} from "@/utils/workbenchStatisticsFilter";

describe("Workbench statistics dataset filter", () => {
  test("excludes the merged storage bucket but keeps names containing merged", () => {
    expect(
      isWorkbenchStatisticsExcludedDataset(
        "TacVerse/merged/taccap-g1-arrange-desk-items-09902",
      ),
    ).toBe(true);
    expect(
      isWorkbenchStatisticsExcludedDataset(
        "TacVerse/taccap-g1-arrange-desk-items-0902",
      ),
    ).toBe(false);
    expect(
      isWorkbenchStatisticsExcludedDataset("TacVerse/merged-results-0902"),
    ).toBe(false);
  });

  test("returns an inspectable summary and preserves included order", () => {
    const result = filterWorkbenchStatisticsDatasets([
      { relativePath: "TacVerse/normal-0902", value: 1 },
      { relativePath: "TacVerse/merged/merged-output-09902", value: 2 },
    ]);

    expect(result.included).toEqual([
      { relativePath: "TacVerse/normal-0902", value: 1 },
    ]);
    expect(result.excluded).toEqual([
      { relativePath: "TacVerse/merged/merged-output-09902", value: 2 },
    ]);
    expect(result.summary).toEqual({
      rule: expect.stringContaining("exact path segment `merged`"),
      excludedDatasets: [
        {
          relativePath: "TacVerse/merged/merged-output-09902",
          reason: "post-processing-merged-output",
        },
      ],
    });
    expect(createWorkbenchStatisticsFilterSummary([]).excludedDatasets).toEqual(
      [],
    );
  });
});

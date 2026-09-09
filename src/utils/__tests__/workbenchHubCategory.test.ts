import { describe, expect, test } from "bun:test";
import {
  canonicalTacverseRepoId,
  classifyTacverseHubRepository,
  countTacverseHubCategories,
  hasValidWorkbenchMonthDaySuffix,
  hubRepoIdForLocalDatasetPath,
  matchesTacverseHubCategory,
  parseTacverseHubCategoryFilter,
  parseTacverseHubCategorySelection,
  serializeTacverseHubCategorySelection,
  tacverseHubCategory,
} from "@/utils/workbenchHubCategory";
import { workbenchDatasetSourceKey } from "@/utils/workbenchRollup";

describe("TacVerse Hub categories", () => {
  test.each([
    ["TacVerse/taccap-g1-insert-divider-0904", {}, "taccap-g1"],
    ["TacVerse/taccap-g1-task-0228", {}, "taccap-g1"],
    ["TacVerse/taccap-g1-task-0230", {}, "other"],
    ["TacVerse/taccap-g1-task-1331", {}, "other"],
    ["TacVerse/taccap-g1-task", {}, "taccap-g1-merged"],
    ["TacVerse/taccap-g1", {}, "other"],
    ["TacVerse/xtac-umi-g1", {}, "xtac-umi-g1"],
    ["TacVerse/xtac-umi-g1-open", {}, "xtac-umi-g1"],
    ["TacVerse/xtac-umi-g1-open-9999", {}, "xtac-umi-g1"],
    ["TacVerse/not-xtac-umi-g1-open", {}, "other"],
    ["TacVerse/taccap-g1-insert-hook-assembly", {}, "other"],
    ["TacVerse/taccap-g1-press-remote-buttons", {}, "other"],
    [
      "TacVerse/taccap-g1-dated-0904",
      { layout: "folder", children: [] },
      "folder",
    ],
    ["OtherOrg/taccap-g1-task-0904", {}, "other"],
    ["TacVerse/raw/taccap-g1-task-0904", {}, "other"],
  ] as const)(
    "classifies %s by the required priority",
    (repoId, metadata, expected) => {
      expect(tacverseHubCategory(repoId, metadata)).toBe(expected);
    },
  );

  test("reports robot type mismatches without changing categories", () => {
    expect(
      classifyTacverseHubRepository({
        repoId: "TacVerse/xtac-umi-g1-demo",
        robotType: "unexpected",
      }),
    ).toEqual({
      category: "xtac-umi-g1",
      warning:
        "Expected robot_type xtac_umi_g1 or bi_taccap_gripper; found unexpected.",
    });
    expect(
      classifyTacverseHubRepository({
        repoId: "TacVerse/taccap-g1-merged-task",
        robotType: "unexpected",
      }),
    ).toEqual({
      category: "taccap-g1-merged",
      warning: "Expected robot_type bi_taccap_gripper; found unexpected.",
    });
    expect(
      classifyTacverseHubRepository({
        repoId: "TacVerse/xtac-umi-g1-demo",
        robotType: "bi_taccap_gripper",
      }).warning,
    ).toBeNull();
    expect(
      classifyTacverseHubRepository({
        repoId: "TacVerse/taccap-g1-merged-task",
        robotType: null,
      }).warning,
    ).toContain("missing robot_type");
  });

  test("shares the real-calendar MMDD rule with the existing source classifier", () => {
    expect(hasValidWorkbenchMonthDaySuffix("task-0430")).toBe(true);
    expect(hasValidWorkbenchMonthDaySuffix("task-0431")).toBe(false);
    expect(workbenchDatasetSourceKey("TacVerse/taccap-g1-task-0430")).toBe(
      "taccap-g1",
    );
    expect(workbenchDatasetSourceKey("TacVerse/taccap-g1-task-0431")).toBe(
      "unclassified",
    );
  });

  test("maps bucket paths and only known Folder child paths to Hub parents", () => {
    const folders = new Set(["TacVerse/sampledata"]);
    expect(
      hubRepoIdForLocalDatasetPath(
        "TacVerse/released/taccap-g1-task-0904",
        "TacVerse",
        folders,
      ),
    ).toBe("TacVerse/taccap-g1-task-0904");
    expect(
      hubRepoIdForLocalDatasetPath(
        "TacVerse/sampledata/child-a",
        "TacVerse",
        folders,
      ),
    ).toBe("TacVerse/sampledata");
    expect(
      hubRepoIdForLocalDatasetPath(
        "TacVerse/not-folder/child-a",
        "TacVerse",
        folders,
      ),
    ).toBeNull();
  });

  test("round-trips multi-category URL state in stable order", () => {
    const parsed = parseTacverseHubCategorySelection(
      "xtac-umi-g1,taccap-g1,xtac-umi-g1",
    );
    expect(parsed).toEqual(["taccap-g1", "xtac-umi-g1"]);
    expect(serializeTacverseHubCategorySelection(parsed)).toBe(
      "taccap-g1,xtac-umi-g1",
    );
    expect(parseTacverseHubCategorySelection("all")).toEqual([]);
    expect(serializeTacverseHubCategorySelection([])).toBe("all");
    expect(
      matchesTacverseHubCategory("TacVerse/xtac-umi-g1-demo", parsed),
    ).toBe(true);
  });

  test("parses URL state and counts all five Hub categories", () => {
    expect(parseTacverseHubCategoryFilter(null)).toBe("all");
    expect(parseTacverseHubCategoryFilter("invalid")).toBe("all");
    expect(parseTacverseHubCategoryFilter("folder")).toBe("folder");
    expect(canonicalTacverseRepoId("TacVerse/name")).toBe("TacVerse/name");
    expect(canonicalTacverseRepoId("TacVerse/raw/name")).toBeNull();
    expect(
      countTacverseHubCategories([
        "TacVerse/taccap-g1-task-0904",
        "TacVerse/xtac-umi-g1-demo",
        "TacVerse/taccap-g1-merged-task",
        {
          repoId: "TacVerse/sampledata",
          layout: "folder",
          children: [],
        },
        "TacVerse/no-info",
      ]),
    ).toEqual({
      "taccap-g1": 1,
      "xtac-umi-g1": 1,
      "taccap-g1-merged": 1,
      folder: 1,
      other: 1,
    });
    expect(
      matchesTacverseHubCategory("TacVerse/xtac-umi-g1-demo", "xtac-umi-g1"),
    ).toBe(true);
  });
});

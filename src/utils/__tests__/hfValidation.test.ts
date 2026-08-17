import { describe, expect, test } from "bun:test";
import {
  MAX_HF_REPOS_PER_REQUEST,
  normalizeHfRepoIds,
  normalizeHfSource,
  normalizeHfToken,
} from "@/utils/hfValidation";

describe("normalizeHfSource", () => {
  test("accepts a plain Hub organization name and trims it", () => {
    expect(normalizeHfSource("  TacVerse ")).toBe("TacVerse");
  });

  test("rejects path-like or empty values", () => {
    expect(normalizeHfSource("../private")).toBeNull();
    expect(normalizeHfSource("TacVerse/foo")).toBeNull();
    expect(normalizeHfSource("   ")).toBeNull();
  });
});

describe("normalizeHfToken", () => {
  test("trims a token but never returns an empty value", () => {
    expect(normalizeHfToken("  hf_example  ")).toBe("hf_example");
    expect(normalizeHfToken(" ")).toBeNull();
    expect(normalizeHfToken(42)).toBeNull();
  });
});

describe("normalizeHfRepoIds", () => {
  test("deduplicates valid ids while preserving selection order", () => {
    expect(
      normalizeHfRepoIds(
        ["TacVerse/b", "TacVerse/a", "TacVerse/b"],
        "TacVerse",
      ),
    ).toEqual({ repoIds: ["TacVerse/b", "TacVerse/a"], error: null });
  });

  test("rejects ids outside the selected source or path traversal", () => {
    expect(normalizeHfRepoIds(["Other/private"], "TacVerse").error).toContain(
      "does not belong",
    );
    expect(normalizeHfRepoIds(["TacVerse/../secret"], "TacVerse").error).toBe(
      'Invalid repo name in "TacVerse/../secret".',
    );
  });

  test("caps a single request to keep child process work bounded", () => {
    const tooMany = Array.from(
      { length: MAX_HF_REPOS_PER_REQUEST + 1 },
      (_, index) => `TacVerse/repo-${index}`,
    );
    expect(normalizeHfRepoIds(tooMany, "TacVerse").error).toContain("At most");
  });
});

import { describe, expect, test } from "bun:test";
import {
  filterTacverseDatasetStatistics,
  formatRelativeUpdatedAt,
  sortTacverseDatasetStatistics,
  summarizeTacverseDatasetStatistics,
  type TacverseDatasetStatisticsRow,
} from "@/utils/tacverseDatasetStatistics";

function row(
  repoId: string,
  overrides: Partial<TacverseDatasetStatisticsRow> = {},
): TacverseDatasetStatisticsRow {
  return {
    repoId,
    robotType: "g1",
    episodes: 1,
    frames: 100,
    hours: 0.1,
    localStatus: "downloaded",
    issuesStatus: "ok",
    createdAt: null,
    lastModified: null,
    downloads: 0,
    ...overrides,
  };
}

describe("TacVerse dataset statistics logic", () => {
  const rows = [
    row("TacVerse/first", {
      createdAt: "2026-08-01T00:00:00Z",
      lastModified: "2026-09-01T00:00:00Z",
    }),
    row("TacVerse/missing"),
    row("TacVerse/second", {
      createdAt: "2026-09-02T00:00:00Z",
      lastModified: "2026-08-02T00:00:00Z",
    }),
    row("TacVerse/tied", {
      createdAt: "2026-09-02T00:00:00Z",
      lastModified: "not-a-time",
    }),
  ];

  test("sorts both dates descending with missing dates last and stable ties", () => {
    expect(
      sortTacverseDatasetStatistics(rows, "updated").map((item) => item.repoId),
    ).toEqual([
      "TacVerse/first",
      "TacVerse/second",
      "TacVerse/missing",
      "TacVerse/tied",
    ]);
    expect(
      sortTacverseDatasetStatistics(rows, "created").map((item) => item.repoId),
    ).toEqual([
      "TacVerse/second",
      "TacVerse/tied",
      "TacVerse/first",
      "TacVerse/missing",
    ]);
  });

  test("formats relative updated time and unavailable timestamps", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    expect(formatRelativeUpdatedAt("2026-09-05T06:00:00Z", now)).toBe(
      "Updated about 6 hours ago",
    );
    expect(formatRelativeUpdatedAt(null, now)).toBe("—");
    expect(formatRelativeUpdatedAt("invalid", now)).toBe("—");
  });

  test("totals downloads over every Hub row and ignores unavailable numbers", () => {
    const allRows = [
      row("TacVerse/a", {
        episodes: 5,
        frames: 500,
        hours: 1.5,
        downloads: 12,
        issuesStatus: "warn",
      }),
      row("TacVerse/b", {
        episodes: null,
        frames: null,
        hours: null,
        downloads: 8,
      }),
    ];
    expect(summarizeTacverseDatasetStatistics(allRows, 2)).toEqual({
      datasets: 2,
      episodes: 5,
      frames: 500,
      hours: 1.5,
      issues: 1,
      downloads: 20,
    });
    expect(
      filterTacverseDatasetStatistics(allRows, "a", true).map(
        (item) => item.repoId,
      ),
    ).toEqual(["TacVerse/a"]);
  });
});

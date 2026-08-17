import { describe, expect, test } from "bun:test";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import {
  buildHomepageDatasetStatistics,
  filterHomepageDatasetStatisticsRows,
} from "@/utils/homepageDatasetStatistics";

function dataset(
  overrides: Partial<LocalDatasetSummary> = {},
): LocalDatasetSummary {
  return {
    relativePath: "TacVerse/taccap-g1-place-cup-0818",
    encodedPath: "encoded",
    codebase_version: "v3.0",
    robot_type: "taccap-g1",
    total_episodes: 10,
    total_frames: 36_000,
    fps: 30,
    sizeBytes: 0,
    thumbnailVideoUrl: null,
    integrity: {
      hasData: true,
      hasVideos: true,
      hasEpisodes: true,
      status: "ok",
    },
    tags: { task: null, scene: null, objects: [] },
    ...overrides,
  };
}

describe("buildHomepageDatasetStatistics", () => {
  test("aggregates homepage KPIs and derives mean episode duration", () => {
    const summary = buildHomepageDatasetStatistics([
      dataset(),
      dataset({
        relativePath: "TacVerse/taccap-g1-fold-towel-0818",
        encodedPath: "second",
        total_episodes: 20,
        total_frames: 72_000,
      }),
    ]);

    expect(summary.datasets).toBe(2);
    expect(summary.episodes).toBe(30);
    expect(summary.frames).toBe(108_000);
    expect(summary.hours).toBeCloseTo(1, 8);
    expect(summary.rows[0].averageEpisodeSeconds).toBeCloseTo(120, 8);
  });

  test("reuses custom checks while keeping the unavailable prompt check skipped", () => {
    const summary = buildHomepageDatasetStatistics([dataset()]);
    const row = summary.rows[0];

    expect(row.checkStatus).toBe("ok");
    expect(row.passedChecks).toBe(2);
    expect(row.skippedChecks).toBe(1);
    expect(row.hasIssue).toBe(false);
    expect(summary.healthy).toBe(1);
  });

  test("counts a failed custom rule as a dataset issue", () => {
    const summary = buildHomepageDatasetStatistics([
      dataset({ relativePath: "OtherOrg/unconstrained-name" }),
    ]);

    expect(summary.rows[0].failedChecks).toBe(1);
    expect(summary.rows[0].hasIssue).toBe(true);
    expect(summary.healthy).toBe(0);
    expect(summary.issues).toBe(1);
  });

  test("counts an incomplete local dataset as an issue even when checks pass", () => {
    const summary = buildHomepageDatasetStatistics([
      dataset({
        integrity: {
          hasData: true,
          hasVideos: false,
          hasEpisodes: true,
          status: "incomplete",
        },
      }),
    ]);

    expect(summary.rows[0].checkStatus).toBe("ok");
    expect(summary.rows[0].hasIssue).toBe(true);
    expect(summary.issues).toBe(1);
  });

  test("does not emit NaN or Infinity for unusable fps", () => {
    const summary = buildHomepageDatasetStatistics([
      dataset({ fps: 0, total_frames: Number.NaN }),
    ]);

    expect(summary.frames).toBe(0);
    expect(summary.hours).toBe(0);
    expect(summary.rows[0].averageEpisodeSeconds).toBeNull();
  });
});

describe("filterHomepageDatasetStatisticsRows", () => {
  const rows = buildHomepageDatasetStatistics([
    dataset(),
    dataset({
      relativePath: "OtherOrg/unconstrained-name",
      encodedPath: "second",
      robot_type: "so101",
    }),
  ]).rows;

  test("matches dataset name and robot type case-insensitively", () => {
    expect(
      filterHomepageDatasetStatisticsRows(rows, "PLACE-CUP", false),
    ).toHaveLength(1);
    expect(
      filterHomepageDatasetStatisticsRows(rows, "TACCAP-G1", false),
    ).toHaveLength(1);
    expect(
      filterHomepageDatasetStatisticsRows(rows, "SO101", false),
    ).toHaveLength(1);
  });

  test("can restrict the table to datasets with issues", () => {
    const filtered = filterHomepageDatasetStatisticsRows(rows, "", true);
    expect(filtered.map((row) => row.name)).toEqual([
      "OtherOrg/unconstrained-name",
    ]);
  });
});

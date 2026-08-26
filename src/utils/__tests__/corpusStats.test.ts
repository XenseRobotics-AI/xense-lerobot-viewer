import { describe, expect, test } from "bun:test";
import {
  computeCorpusStats,
  datasetHours,
  formatCompact,
  formatEpisodeLength,
  formatHours,
  formatHoursValue,
  tapeColor,
  tapeWidths,
  TAPE_COLORS,
} from "@/utils/corpusStats";
import type { DatasetGroup } from "@/utils/datasetGrouping";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";

const ds = (over: Partial<LocalDatasetSummary> = {}): LocalDatasetSummary =>
  ({
    relativePath: "Org/task",
    encodedPath: "enc",
    codebase_version: "v3.0",
    leftGripperSn: null,
    robot_type: null,
    total_episodes: 0,
    total_frames: 0,
    fps: 30,
    sizeBytes: 0,
    thumbnailVideoUrl: null,
    integrity: { status: "ok" },
    tags: {},
    ...over,
  }) as LocalDatasetSummary;

const group = (prefix: string, datasets: LocalDatasetSummary[]): DatasetGroup =>
  ({
    prefix,
    datasets,
    counts: { ok: datasets.length, empty: 0, incomplete: 0 },
    totalEpisodes: datasets.reduce((s, d) => s + d.total_episodes, 0),
    thumbnailVideoUrl: null,
  }) as DatasetGroup;

describe("datasetHours", () => {
  test("converts frames at fps into hours", () => {
    expect(datasetHours(ds({ total_frames: 108000, fps: 30 }))).toBeCloseTo(
      1,
      6,
    );
  });

  test("returns 0 for fps 0 rather than Infinity", () => {
    // A single Infinity would poison every corpus total downstream.
    expect(datasetHours(ds({ total_frames: 1000, fps: 0 }))).toBe(0);
  });

  test("returns 0 for negative or non-finite inputs", () => {
    expect(datasetHours(ds({ total_frames: -5, fps: 30 }))).toBe(0);
    expect(datasetHours(ds({ total_frames: NaN, fps: 30 }))).toBe(0);
    expect(datasetHours(ds({ total_frames: 100, fps: NaN }))).toBe(0);
  });
});

describe("computeCorpusStats", () => {
  test("aggregates hours, episodes, frames and tasks per group", () => {
    const stats = computeCorpusStats([
      group("A", [
        ds({ total_frames: 108000, fps: 30, total_episodes: 4 }),
        ds({ total_frames: 54000, fps: 30, total_episodes: 2 }),
      ]),
    ]);

    expect(stats.segments).toHaveLength(1);
    expect(stats.segments[0].hours).toBeCloseTo(1.5, 6);
    expect(stats.segments[0].episodes).toBe(6);
    expect(stats.segments[0].tasks).toBe(2);
    expect(stats.totalFrames).toBe(162000);
    expect(stats.totalTasks).toBe(2);
  });

  test("sums bytes per segment and across the corpus", () => {
    const stats = computeCorpusStats([
      group("A", [ds({ sizeBytes: 1_000 }), ds({ sizeBytes: 2_500 })]),
      group("B", [ds({ sizeBytes: 500 })]),
    ]);

    const bySource = Object.fromEntries(
      stats.segments.map((s) => [s.prefix, s.bytes]),
    );
    expect(bySource).toEqual({ A: 3_500, B: 500 });
    expect(stats.totalBytes).toBe(4_000);
  });

  test("treats a dataset with no measured size as zero, not NaN", () => {
    const stats = computeCorpusStats([
      group("A", [
        ds({ sizeBytes: 1_000 }),
        ds({ sizeBytes: undefined as unknown as number }),
      ]),
    ]);
    expect(stats.totalBytes).toBe(1_000);
  });

  test("sorts segments by hours descending and computes shares summing to 1", () => {
    const stats = computeCorpusStats([
      group("small", [ds({ total_frames: 36000, fps: 30 })]),
      group("big", [ds({ total_frames: 108000, fps: 30 })]),
    ]);

    expect(stats.segments.map((s) => s.prefix)).toEqual(["big", "small"]);
    expect(stats.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(
      1,
      6,
    );
    expect(stats.segments[0].share).toBeCloseTo(0.75, 6);
  });

  test("episode count and hours rank independently", () => {
    // The real corpus has a group with many short episodes and another with few
    // long ones; the tape must order by duration, not episode count.
    const stats = computeCorpusStats([
      group("manyShort", [
        ds({ total_frames: 3000, fps: 30, total_episodes: 1468 }),
      ]),
      group("fewLong", [
        ds({ total_frames: 300000, fps: 30, total_episodes: 12 }),
      ]),
    ]);

    expect(stats.segments[0].prefix).toBe("fewLong");
    expect(stats.segments[0].episodes).toBeLessThan(stats.segments[1].episodes);
  });

  test("empty corpus yields zero shares instead of NaN", () => {
    const stats = computeCorpusStats([
      group("A", [ds({ total_frames: 0, fps: 30 })]),
    ]);
    expect(stats.totalHours).toBe(0);
    expect(stats.segments[0].share).toBe(0);
    expect(Number.isNaN(stats.segments[0].share)).toBe(false);
  });

  test("handles no groups at all", () => {
    const stats = computeCorpusStats([]);
    expect(stats.segments).toEqual([]);
    expect(stats.totalHours).toBe(0);
    expect(stats.totalTasks).toBe(0);
  });
});

describe("tapeWidths", () => {
  const seg = (share: number) =>
    ({
      prefix: "x",
      tasks: 1,
      hours: share,
      episodes: 0,
      frames: 0,
      share,
    }) as never;

  test("passes shares straight through when all clear the floor", () => {
    expect(tapeWidths([seg(0.5), seg(0.5)], 2.5)).toEqual([50, 50]);
  });

  test("floors tiny segments so they stay visible and hoverable", () => {
    const widths = tapeWidths([seg(0.99), seg(0.01)], 2.5);
    expect(widths[1]).toBe(2.5);
  });

  test("still sums to 100 after borrowing width for tiny segments", () => {
    const widths = tapeWidths(
      [seg(0.61), seg(0.37), seg(0.019), seg(0.001)],
      2.5,
    );
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  test("keeps zero-hour segments at zero width", () => {
    const widths = tapeWidths([seg(1), seg(0)], 2.5);
    expect(widths[1]).toBe(0);
  });

  test("handles an empty corpus without dividing by zero", () => {
    const widths = tapeWidths([seg(0), seg(0)], 2.5);
    expect(widths).toEqual([0, 0]);
  });
});

describe("avgEpisodeSeconds", () => {
  test("derives mean episode length from hours and episode count", () => {
    // 108000 frames @ 30fps = 3600 s over 12 episodes = 300 s/ep.
    const stats = computeCorpusStats([
      group("A", [ds({ total_frames: 108000, fps: 30, total_episodes: 12 })]),
    ]);
    expect(stats.segments[0].avgEpisodeSeconds).toBeCloseTo(300, 6);
  });

  test("is null when a source has no episodes, not a division by zero", () => {
    const stats = computeCorpusStats([
      group("A", [ds({ total_frames: 0, fps: 30, total_episodes: 0 })]),
    ]);
    expect(stats.segments[0].avgEpisodeSeconds).toBeNull();
  });

  test("separates many-short from few-long sources", () => {
    const stats = computeCorpusStats([
      group("clips", [ds({ total_frames: 9000, fps: 30, total_episodes: 50 })]),
      group("runs", [ds({ total_frames: 90000, fps: 30, total_episodes: 5 })]),
    ]);
    const clips = stats.segments.find((s) => s.prefix === "clips")!;
    const runs = stats.segments.find((s) => s.prefix === "runs")!;
    expect(clips.avgEpisodeSeconds).toBeCloseTo(6, 6);
    expect(runs.avgEpisodeSeconds).toBeCloseTo(600, 6);
  });
});

describe("formatEpisodeLength", () => {
  test("keeps a decimal for very short episodes", () => {
    expect(formatEpisodeLength(6.4)).toBe("6.4 s");
  });

  test("rounds to whole seconds under a minute", () => {
    expect(formatEpisodeLength(42.6)).toBe("43 s");
  });

  test("switches to minutes at 60 s and up", () => {
    expect(formatEpisodeLength(211)).toBe("3.5 min");
    expect(formatEpisodeLength(1800)).toBe("30 min");
  });

  test("renders an em dash for missing or invalid values", () => {
    expect(formatEpisodeLength(null)).toBe("—");
    expect(formatEpisodeLength(0)).toBe("—");
    expect(formatEpisodeLength(NaN)).toBe("—");
  });
});

describe("formatHours", () => {
  test("shows minutes below one hour", () => {
    expect(formatHours(0.5)).toEqual({ value: "30", unit: "min" });
  });

  test("keeps one decimal in the double-digit range", () => {
    expect(formatHours(12.34)).toEqual({ value: "12.3", unit: "h" });
  });

  test("keeps the decimal once the number is large", () => {
    expect(formatHours(417.4)).toEqual({ value: "417.4", unit: "h" });
    expect(formatHours(4173.45)).toEqual({ value: "4,173.5", unit: "h" });
  });

  test("degrades to zero for empty or invalid input", () => {
    expect(formatHours(0)).toEqual({ value: "0.0", unit: "h" });
    expect(formatHours(NaN)).toEqual({ value: "0.0", unit: "h" });
  });
});

describe("formatHoursValue", () => {
  test("always carries exactly one decimal", () => {
    expect(formatHoursValue(7)).toBe("7.0");
    expect(formatHoursValue(7.04)).toBe("7.0");
    expect(formatHoursValue(0.06)).toBe("0.1");
  });

  test("groups thousands and floors invalid input at zero", () => {
    expect(formatHoursValue(12345.67)).toBe("12,345.7");
    expect(formatHoursValue(NaN)).toBe("0.0");
    expect(formatHoursValue(-3)).toBe("0.0");
  });
});

describe("formatCompact", () => {
  test("abbreviates millions and ten-thousands", () => {
    expect(formatCompact(45019623)).toBe("45.0M");
    expect(formatCompact(15368)).toBe("15.4k");
  });

  test("leaves small numbers grouped but unabbreviated", () => {
    expect(formatCompact(231)).toBe("231");
    expect(formatCompact(9999)).toBe("9,999");
  });
});

describe("tapeColor", () => {
  test("cycles through the ramp so any group count is colored", () => {
    expect(tapeColor(0)).toBe(TAPE_COLORS[0]);
    expect(tapeColor(TAPE_COLORS.length)).toBe(TAPE_COLORS[0]);
  });
});

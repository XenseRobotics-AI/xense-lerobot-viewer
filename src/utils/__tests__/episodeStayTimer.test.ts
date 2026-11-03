import { describe, expect, test } from "bun:test";
import {
  EpisodeStayTimer,
  parseStoredEpisodeStayMs,
  shouldTrackEpisodeStay,
} from "../episodeStayTimer";

describe("EpisodeStayTimer", () => {
  test("accumulates only active time and resumes the same episode", () => {
    const timer = new EpisodeStayTimer();
    timer.start("episode-3:Alice", 10_000, 100);
    expect(timer.read("episode-3:Alice", 2_600).stay_ms).toBe(2_500);
    timer.pause(2_600);
    timer.start("episode-4:Alice", 20_000, 5_000);
    timer.pause(7_000);
    timer.start("episode-3:Alice", 10_000, 10_000);
    expect(timer.read("episode-3:Alice", 11_250)).toEqual({
      stay_ms: 3_750,
      episode_duration_ms: 10_000,
    });
  });

  test("caps accumulated and live time at twice the episode duration", () => {
    const timer = new EpisodeStayTimer();
    timer.start("episode-0:Alice", 1_000, 0);
    expect(timer.read("episode-0:Alice", 5_000).stay_ms).toBe(2_000);
    timer.pause(5_000);
    timer.start("episode-0:Alice", 1_000, 8_000);
    timer.pause(9_000);
    expect(timer.read("episode-0:Alice", 10_000)).toEqual({
      stay_ms: 2_000,
      episode_duration_ms: 1_000,
    });
  });

  test("accepts the exact cap and ignores additional elapsed time", () => {
    const timer = new EpisodeStayTimer();
    timer.start("at-cap", 1_000, 10_000);
    expect(timer.read("at-cap", 12_000).stay_ms).toBe(2_000);
    expect(timer.read("at-cap", 100_000).stay_ms).toBe(2_000);
  });

  test("does not accumulate for an invalid or zero duration", () => {
    const invalidDurations = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const [index, duration] of invalidDurations.entries()) {
      const timer = new EpisodeStayTimer();
      const key = `invalid-duration-${index}`;
      timer.start(key, duration, 0);
      expect(timer.read(key, 2_000)).toEqual({
        stay_ms: 0,
        episode_duration_ms: 0,
      });
    }
  });

  test("pause is idempotent and hidden intervals are excluded", () => {
    const timer = new EpisodeStayTimer();
    timer.start("visibility", 10_000, 0);
    timer.pause(1_000);
    timer.pause(5_000);
    expect(timer.read("visibility", 5_000).stay_ms).toBe(1_000);
    timer.start("visibility", 10_000, 8_000);
    expect(timer.read("visibility", 8_500).stay_ms).toBe(1_500);
  });

  test("restores tab-local elapsed time and applies the current episode cap", () => {
    const timer = new EpisodeStayTimer();
    timer.start("episode-1:Alice", 5_000, 0, 7_500);
    expect(timer.read("episode-1:Alice", 0).stay_ms).toBe(7_500);
  });

  test("normalizes invalid restored values and non-finite clocks", () => {
    const timer = new EpisodeStayTimer();
    timer.start("negative-restore", 1_000, 10, -4);
    expect(timer.read("negative-restore", 10).stay_ms).toBe(0);
    timer.pause(10);
    timer.start("invalid-restore", 1_000, 30, Number.NaN);
    expect(timer.read("invalid-restore", Number.NaN).stay_ms).toBe(0);
    timer.pause(Number.NaN);
    expect(timer.read("invalid-restore", 40).stay_ms).toBe(0);
  });

  test("floors fractional time and does not subtract time when the clock regresses", () => {
    const timer = new EpisodeStayTimer();
    timer.start("monotonic", 10_000, 100.25);
    expect(timer.read("monotonic", 101.99).stay_ms).toBe(1);
    timer.pause(99);
    expect(timer.read("monotonic", 200).stay_ms).toBe(0);
  });

  test("keeps time separate for different inspectors", () => {
    const timer = new EpisodeStayTimer();
    timer.start("episode-1:Alice", 10_000, 0);
    timer.pause(2_000);
    timer.start("episode-1:Bob", 10_000, 3_000);
    timer.pause(5_000);
    expect(timer.read("episode-1:Alice", 6_000).stay_ms).toBe(2_000);
    expect(timer.read("episode-1:Bob", 6_000).stay_ms).toBe(2_000);
  });

  test("parses only valid non-negative safe integer session snapshots", () => {
    expect(parseStoredEpisodeStayMs(null)).toBe(0);
    expect(parseStoredEpisodeStayMs("broken")).toBe(0);
    expect(parseStoredEpisodeStayMs("null")).toBe(0);
    expect(parseStoredEpisodeStayMs("{}")).toBe(0);
    expect(parseStoredEpisodeStayMs('{"stay_ms":-1}')).toBe(0);
    expect(parseStoredEpisodeStayMs('{"stay_ms":1.5}')).toBe(0);
    expect(parseStoredEpisodeStayMs('{"stay_ms":"500"}')).toBe(0);
    expect(parseStoredEpisodeStayMs('{"stay_ms":9007199254740992}')).toBe(0);
    expect(parseStoredEpisodeStayMs('{"stay_ms":500}')).toBe(500);
  });

  test("tracks time only when the episode is ready, visible, and has a reviewer", () => {
    const cases = [
      [
        {
          pageHidden: false,
          episodeReady: true,
          reviewerSelected: true,
          reviewSurfaceReady: true,
        },
        true,
      ],
      [
        {
          pageHidden: true,
          episodeReady: true,
          reviewerSelected: true,
          reviewSurfaceReady: true,
        },
        false,
      ],
      [
        {
          pageHidden: false,
          episodeReady: false,
          reviewerSelected: true,
          reviewSurfaceReady: true,
        },
        false,
      ],
      [
        {
          pageHidden: false,
          episodeReady: true,
          reviewerSelected: false,
          reviewSurfaceReady: true,
        },
        false,
      ],
      [
        {
          pageHidden: false,
          episodeReady: true,
          reviewerSelected: true,
          reviewSurfaceReady: false,
        },
        false,
      ],
    ] as const;
    for (const [input, expected] of cases)
      expect(shouldTrackEpisodeStay(input)).toBe(expected);
  });
});

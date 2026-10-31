import { describe, expect, test } from "bun:test";
import { ReplayPlaybackClock } from "../replayPlaybackClock";

describe("replay playback clock", () => {
  test("counts short play intervals even when pause precedes the first RAF", () => {
    const clock = new ReplayPlaybackClock();
    clock.start(0);
    expect(clock.pause(16, 30).frames).toBe(0);
    clock.start(10_000);
    const sample = clock.pause(10_020, 30);
    expect(sample.frames).toBe(1);
    expect(sample.alpha).toBeCloseTo(0.08, 8);
  });

  test("preserves all active fractions over 1000 rapid toggles, excluding paused time", () => {
    const clock = new ReplayPlaybackClock();
    let now = 0;
    let played = 0;
    let frames = 0;
    for (let i = 0; i < 1000; i++) {
      clock.start(now);
      const duration = 1 + (i % 37);
      if (duration > 16) frames += clock.advance(now + 16, 30).frames;
      now += duration;
      played += duration;
      frames += clock.pause(now, 30).frames;
      now += 500 + i;
    }
    expect(frames).toBe(Math.floor((played * 30) / 1000));
    expect(clock.pause(now, 30).frames).toBe(0);
  });

  test("an explicit reset clears both old fractions and the running timestamp", () => {
    const clock = new ReplayPlaybackClock();
    clock.start(0);
    clock.advance(30, 30);
    clock.reset();
    expect(clock.pause(1000, 30)).toEqual({ frames: 0, alpha: 0 });
    clock.start(2000);
    expect(clock.pause(2010, 30)).toEqual({ frames: 0, alpha: 0.3 });
  });

  test("a long suspension preserves the fraction without jumping across the gap", () => {
    const clock = new ReplayPlaybackClock();
    clock.start(0);
    clock.advance(10, 30);
    expect(clock.advance(1010, 30).frames).toBe(0);
    expect(clock.pause(1040, 30).frames).toBe(1);
  });

  test("ignores invalid timestamps and rates without poisoning future samples", () => {
    const clock = new ReplayPlaybackClock();
    clock.start(Number.NaN);
    clock.start(0);
    expect(clock.advance(Number.NaN, 30).frames).toBe(0);
    expect(clock.advance(10, Number.NaN)).toEqual({ frames: 0, alpha: 0 });
    expect(clock.advance(10, 0)).toEqual({ frames: 0, alpha: 0 });
    expect(clock.pause(40, 30).frames).toBe(1);
  });
});

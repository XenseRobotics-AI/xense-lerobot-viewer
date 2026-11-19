import { afterAll, describe, expect, test } from "bun:test";
import { ReplayVideoSynchronizer } from "../replayVideoSync";

const previousMedia = globalThis.HTMLMediaElement;
Object.defineProperty(globalThis, "HTMLMediaElement", {
  configurable: true,
  value: { HAVE_FUTURE_DATA: 3 },
});
afterAll(() =>
  Object.defineProperty(globalThis, "HTMLMediaElement", {
    configurable: true,
    value: previousMedia,
  }),
);

function setup() {
  const video = {
    currentTime: 10,
    playbackRate: 1,
    seeking: false,
    readyState: 4,
  } as HTMLVideoElement;
  const sync = new ReplayVideoSynchronizer();
  const seeks: number[] = [];
  const correct = (target: number, now = 0) =>
    sync.correct(video, target, now, (time) => seeks.push(time));
  return { video, sync, seeks, correct };
}

describe("replay video drift correction", () => {
  test("recovers a small lag through rate changes without a decoder seek", () => {
    const { video, seeks, correct } = setup();
    let target = 10.3;
    for (let now = 0; now < 6000; now += 250) {
      correct(target, now);
      expect(video.playbackRate).toBeGreaterThanOrEqual(1);
      expect(video.playbackRate).toBeLessThanOrEqual(1.1);
      target += 0.25;
      video.currentTime += 0.25 * video.playbackRate;
    }
    expect(target - video.currentTime).toBeLessThan(0.05);
    expect(video.playbackRate).toBe(1);
    expect(seeks).toEqual([]);
  });

  test("slows a leading camera and restores normal rate inside the deadband", () => {
    const { video, seeks, correct } = setup();
    correct(9.7);
    expect(video.playbackRate).toBe(0.9);
    correct(10.02, 250);
    expect(video.playbackRate).toBe(1);
    expect(seeks).toEqual([]);
  });

  test("never restarts a seek or corrects a buffering camera", () => {
    const { video, seeks, correct } = setup();
    video.seeking = true;
    correct(12);
    video.seeking = false;
    video.readyState = 2;
    correct(12, 250);
    expect(seeks).toEqual([]);
    expect(video.playbackRate).toBe(1);
    video.readyState = 3;
    correct(12, 500);
    expect(seeks).toEqual([12]);
  });

  test("large drift seeks once then allows the decoder two seconds to catch up", () => {
    const { video, seeks, correct } = setup();
    correct(12);
    for (let now = 250; now < 2000; now += 250) correct(12, now);
    expect(seeks).toEqual([12]);
    correct(12, 2000);
    expect(seeks).toEqual([12, 12]);
    video.currentTime = 12;
    correct(12, 2250);
    expect(video.playbackRate).toBe(1);
  });

  test("throttles observations while allowing an explicit reset to bypass cooldown", () => {
    const { sync, seeks, correct } = setup();
    correct(10);
    correct(12, 100);
    expect(seeks).toEqual([]);
    correct(12, 250);
    expect(seeks).toEqual([12]);
    sync.reset();
    correct(14, 300);
    expect(seeks).toEqual([12, 14]);
  });

  test("invalid clock samples do not change playback rate or decoder position", () => {
    const { video, seeks, correct } = setup();
    correct(Number.NaN);
    correct(12, Number.NaN);
    expect(seeks).toEqual([]);
    expect(video.playbackRate).toBe(1);
  });
});

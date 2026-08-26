import { describe, expect, it } from "bun:test";
import { selectTrailStartIndex } from "../poseTrajectory3d";

/** 30 fps samples moving `step` metres along +x each frame. */
function track(count: number, step: number) {
  const timestamps: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < count; i += 1) {
    timestamps.push(i / 30);
    positions.push(i * step, 0, 0);
  }
  return { timestamps, positions };
}

const BASE = { baseDuration: 3, maxDuration: 10 };

describe("selectTrailStartIndex", () => {
  it("uses the plain time window when the motion is already long enough", () => {
    // 1 cm per frame => 90 cm over 3 s, far past a 5 cm floor.
    const { timestamps, positions } = track(600, 0.01);
    const endIndex = 300;
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex,
      timeSeconds: timestamps[endIndex],
      ...BASE,
      minSpan: 0.05,
    });
    expect(timestamps[endIndex] - timestamps[start]).toBeCloseTo(3, 5);
  });

  it("extends past the base window when the motion is too small to see", () => {
    // 0.3 mm per frame => 2.7 cm over 3 s, under a 5 cm floor, and the floor is
    // reachable in ~5.6 s so the cap does not decide this one.
    const { timestamps, positions } = track(600, 0.0003);
    const endIndex = 500;
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex,
      timeSeconds: timestamps[endIndex],
      ...BASE,
      minSpan: 0.05,
    });
    const span = timestamps[endIndex] - timestamps[start];
    expect(span).toBeGreaterThan(3);
    expect(span).toBeLessThan(10);
    expect((endIndex - start) * 0.0003).toBeGreaterThanOrEqual(0.05);
  });

  it("lets the cap win when the floor cannot be reached inside it", () => {
    // 0.1 mm per frame needs 16.7 s to cover 5 cm — the cap must stop it at 10.
    const { timestamps, positions } = track(600, 0.0001);
    const endIndex = 500;
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex,
      timeSeconds: timestamps[endIndex],
      ...BASE,
      minSpan: 0.05,
    });
    expect(timestamps[endIndex] - timestamps[start]).toBeCloseTo(10, 1);
  });

  it("never reaches further back than maxDuration", () => {
    // Stationary: the floor can never be met, so the cap has to stop the walk.
    const { timestamps, positions } = track(900, 0);
    const endIndex = 800;
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex,
      timeSeconds: timestamps[endIndex],
      ...BASE,
      minSpan: 0.05,
    });
    expect(timestamps[endIndex] - timestamps[start]).toBeLessThanOrEqual(10);
    expect(timestamps[endIndex] - timestamps[start]).toBeCloseTo(10, 1);
  });

  it("stops at the start of the trajectory", () => {
    const { timestamps, positions } = track(600, 0);
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex: 20,
      timeSeconds: timestamps[20],
      ...BASE,
      minSpan: 0.05,
    });
    expect(start).toBe(0);
  });

  it("returns the head itself at the first frame", () => {
    const { timestamps, positions } = track(600, 0.01);
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex: 0,
      timeSeconds: 0,
      ...BASE,
      minSpan: 0.05,
    });
    expect(start).toBe(0);
  });

  it("keeps the plain time window when the floor is zero", () => {
    const { timestamps, positions } = track(600, 0);
    const endIndex = 400;
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex,
      timeSeconds: timestamps[endIndex],
      ...BASE,
      minSpan: 0,
    });
    expect(timestamps[endIndex] - timestamps[start]).toBeCloseTo(3, 5);
  });

  it("is not satisfied by jitter in place", () => {
    // 1 cm of back-and-forth every frame: metres of path length, 1 cm across.
    const timestamps: number[] = [];
    const positions: number[] = [];
    for (let i = 0; i < 600; i += 1) {
      timestamps.push(i / 30);
      positions.push(i % 2 === 0 ? 0 : 0.01, 0, 0);
    }
    const endIndex = 500;
    const start = selectTrailStartIndex({
      timestamps,
      positions,
      endIndex,
      timeSeconds: timestamps[endIndex],
      ...BASE,
      minSpan: 0.05,
    });
    // Path length crosses 0.05 m within a few frames; the span never does, so
    // the cap has to be what stops the walk.
    expect(timestamps[endIndex] - timestamps[start]).toBeCloseTo(10, 1);
  });
});

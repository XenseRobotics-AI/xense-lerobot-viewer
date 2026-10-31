"use client";

import {
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { ReplayPlaybackClock } from "@/utils/replayPlaybackClock";

/** Shared by the 3D viewer and browser playback regression fixtures. */
export function ReplayPlaybackDriver({
  playing,
  rowsPerSecond,
  replayRevision,
  totalFrames,
  frameRef,
  setFrame,
  smoothTimeRef,
  timeAtRow,
}: {
  playing: boolean;
  /** Rows in the displayed timeline, not the dataset's original camera FPS. */
  rowsPerSecond: number;
  replayRevision: number;
  totalFrames: number;
  frameRef: MutableRefObject<number>;
  setFrame: Dispatch<SetStateAction<number>>;
  /** Between-row time for the 3D scene; null while paused. */
  smoothTimeRef: MutableRefObject<number | null>;
  timeAtRow: (row: number) => number;
}) {
  const clock = useRef(new ReplayPlaybackClock());

  // Only a new timeline or an explicit seek discards a fractional row.
  useLayoutEffect(() => {
    clock.current.reset();
  }, [replayRevision, rowsPerSecond, totalFrames, timeAtRow]);

  useLayoutEffect(() => {
    const publish = (sample: { frames: number; alpha: number }) => {
      if (totalFrames <= 0) return;
      if (sample.frames > 0) {
        frameRef.current = (frameRef.current + sample.frames) % totalFrames;
        setFrame(frameRef.current);
      }
      const row = frameRef.current;
      const t0 = timeAtRow(row);
      const t1 = row + 1 < totalFrames ? timeAtRow(row + 1) : t0;
      smoothTimeRef.current = t0 + (t1 - t0) * sample.alpha;
    };

    if (!playing) {
      publish(clock.current.pause(performance.now(), rowsPerSecond));
      smoothTimeRef.current = null;
      return;
    }
    clock.current.start(performance.now());
    let cancelled = false;
    let raf: number;
    const tick = () => {
      if (cancelled) return;
      publish(clock.current.advance(performance.now(), rowsPerSecond));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      smoothTimeRef.current = null;
    };
  }, [
    playing,
    replayRevision,
    rowsPerSecond,
    totalFrames,
    frameRef,
    setFrame,
    smoothTimeRef,
    timeAtRow,
  ]);
  return null;
}

"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { ReviewTimerProbe } from "@/utils/reviewDiagnosticsClient";
import type { TimerState } from "@/types/review-diagnostics.types";
import {
  EpisodeStayTimer,
  parseStoredEpisodeStayMs,
  shouldTrackEpisodeStay,
} from "@/utils/episodeStayTimer";

export function useEpisodeStayTime({
  datasetKey,
  episodeId,
  reviewer,
  durationSeconds,
  enabled,
  reviewSurfaceReady,
}: {
  datasetKey: string;
  episodeId: number;
  reviewer: string;
  durationSeconds: number;
  enabled: boolean;
  reviewSurfaceReady: boolean;
}) {
  const timerRef = useRef<EpisodeStayTimer | null>(null);
  if (!timerRef.current) timerRef.current = new EpisodeStayTimer();
  const timer = timerRef.current;
  const reportedDurationMs = Number.isFinite(durationSeconds)
    ? Math.max(0, Math.round(durationSeconds * 1000))
    : 0;
  const durationMs = Number.isSafeInteger(reportedDurationMs * 2)
    ? reportedDurationMs
    : 0;
  const key = JSON.stringify([datasetKey, reviewer, episodeId]);
  const storageKey = `xense-episode-stay:${key}`;
  const probe = useMemo(() => new ReviewTimerProbe(), [key]);
  const readStaySnapshot = useCallback(() => {
    const snapshot = timer.read(key, performance.now());
    return durationMs > 0 && snapshot.episode_duration_ms === durationMs
      ? snapshot
      : undefined;
  }, [durationMs, key, timer]);
  const readStayMs = useCallback(
    () => timer.read(key, performance.now()).stay_ms,
    [key, timer],
  );

  useEffect(() => {
    const persistAndPause = (state: TimerState = "disabled") => {
      probe.transition(state);
      const now = performance.now();
      timer.pause(now);
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify(timer.read(key, now)),
        );
      } catch {
        probe.storageFailure("write");
      }
    };
    const resume = () => {
      if (
        !shouldTrackEpisodeStay({
          pageHidden: document.hidden,
          episodeReady: enabled,
          reviewerSelected: !!reviewer,
          reviewSurfaceReady,
        })
      ) {
        persistAndPause(
          document.hidden
            ? "hidden"
            : !reviewer
              ? "no_reviewer"
              : !enabled
                ? "disabled"
                : "surface_not_ready",
        );
      } else {
        if (durationMs <= 0) {
          persistAndPause("invalid_duration");
          return;
        }
        let initialStayMs = 0;
        try {
          initialStayMs = parseStoredEpisodeStayMs(
            sessionStorage.getItem(storageKey),
          );
          if (initialStayMs > 0) probe.restored();
        } catch {
          probe.storageFailure("read");
        }
        timer.start(key, durationMs, performance.now(), initialStayMs);
        probe.transition("tracking");
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) persistAndPause("hidden");
      else resume();
    };
    resume();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      persistAndPause();
    };
  }, [
    durationMs,
    enabled,
    key,
    reviewer,
    reviewSurfaceReady,
    storageKey,
    timer,
    probe,
  ]);

  return {
    episodeDurationMs: durationMs,
    readStayMs,
    readStaySnapshot,
    readDiagnostics: () => probe.read(),
  };
}

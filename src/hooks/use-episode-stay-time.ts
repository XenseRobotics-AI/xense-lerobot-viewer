"use client";

import { useCallback, useEffect, useRef } from "react";
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
  const readStayMs = useCallback(
    () => timer.read(key, performance.now()).stay_ms,
    [key, timer],
  );

  useEffect(() => {
    const persistAndPause = () => {
      const now = performance.now();
      timer.pause(now);
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify(timer.read(key, now)),
        );
      } catch {
        /* Session storage may be disabled or full. */
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
        persistAndPause();
      } else {
        let initialStayMs = 0;
        try {
          initialStayMs = parseStoredEpisodeStayMs(
            sessionStorage.getItem(storageKey),
          );
        } catch {
          /* Treat invalid or unavailable session data as a fresh visit. */
        }
        timer.start(key, durationMs, performance.now(), initialStayMs);
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) persistAndPause();
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
  ]);

  return {
    episodeDurationMs: durationMs,
    readStayMs,
  };
}

"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useT } from "@/context/locale-context";
import type { VideoInfo } from "@/types";
import {
  VideoFramePresentation,
  type VideoFrameState,
} from "@/utils/videoFramePresentation";
import {
  getPrefetchedVideoPoster,
  subscribePrefetchedVideoPoster,
  videoFramePosterKey,
} from "@/utils/videoFramePrefetch";
import { FaRedo } from "react-icons/fa";

const INITIAL_STATE: VideoFrameState = {
  phase: "loading",
};

export function FirstFrameVideo({
  frameKey,
  onLoadedMetadata,
  onVideoElement,
  video,
  targetSeconds,
  suspended = false,
  compact = false,
}: {
  frameKey: string;
  onLoadedMetadata?: () => void;
  onVideoElement?: (video: HTMLVideoElement | null) => void;
  video: VideoInfo;
  targetSeconds: number;
  suspended?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const posterKey = useMemo(
    () => videoFramePosterKey(frameKey, video, targetSeconds),
    [frameKey, targetSeconds, video],
  );
  const subscribePoster = useCallback(
    (notify: () => void) => subscribePrefetchedVideoPoster(posterKey, notify),
    [posterKey],
  );
  const readPoster = useCallback(
    () => getPrefetchedVideoPoster(posterKey),
    [posterKey],
  );
  const poster = useSyncExternalStore(subscribePoster, readPoster, () => null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const presentationRef = useRef<VideoFramePresentation | null>(null);
  const [state, setState] = useState(INITIAL_STATE);
  const setVideoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      onVideoElement?.(element);
    },
    [onVideoElement],
  );

  useLayoutEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const presentation = new VideoFramePresentation(element, setState);
    presentationRef.current = presentation;
    return () => {
      presentation.dispose();
      if (presentationRef.current === presentation)
        presentationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    presentationRef.current?.update(
      video.url,
      frameKey,
      targetSeconds,
      suspended,
    );
  }, [frameKey, suspended, targetSeconds, video.url]);

  return (
    <div
      className={`relative isolate w-full overflow-hidden bg-slate-800 ${
        compact ? "aspect-[7/4]" : "aspect-[4/3]"
      }`}
      aria-busy={state.phase === "loading"}
      data-video-frame-state={state.phase}
    >
      <video
        ref={setVideoRef}
        aria-label={video.filename}
        className={`absolute inset-0 h-full w-full object-contain ${state.phase === "ready" ? "visible" : "invisible"}`}
        disablePictureInPicture
        onLoadedMetadata={onLoadedMetadata}
        muted
        playsInline
        preload="metadata"
      >
        {t("player.noVideoTag")}
      </video>
      {poster && state.phase !== "ready" && (
        // eslint-disable-next-line @next/next/no-img-element -- poster is an in-memory data URL
        <img
          src={poster}
          alt={video.filename}
          className="absolute inset-0 h-full w-full object-contain"
          aria-hidden="true"
        />
      )}
      {state.phase !== "ready" && (
        <div
          className={`absolute inset-0 z-10 flex items-center justify-center ${poster ? "bg-transparent" : "bg-[var(--surface-1)]"}`}
        >
          {state.phase === "error" ? (
            <div className="flex items-center gap-2 rounded bg-slate-950/85 px-2.5 py-1.5 text-xs text-slate-200 shadow">
              <span>{t("player.videoFrameError")}</span>
              <button
                type="button"
                aria-label={t("player.retryVideo")}
                title={t("player.retryVideo")}
                className="inline-flex size-7 items-center justify-center rounded border border-white/15 text-slate-200 hover:border-cyan-400/60 hover:text-cyan-200"
                onClick={() => presentationRef.current?.retry()}
              >
                <FaRedo size={11} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-[11px] text-slate-300">
              <span className="size-5 animate-spin rounded-full border-2 border-slate-500 border-t-cyan-300" />
              <span>{t("player.decodingVideoFrame")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

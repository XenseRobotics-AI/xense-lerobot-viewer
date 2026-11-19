"use client";

import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useT } from "@/context/locale-context";
import type { VideoInfo } from "@/types";
import {
  VideoFramePresentation,
  type VideoFrameState,
} from "@/utils/videoFramePresentation";
import { FaRedo } from "react-icons/fa";
import { videoPlaybackUrl } from "@/utils/videoPlaybackUrl";

const INITIAL_STATE: VideoFrameState = {
  phase: "loading",
  stage: "fetching",
};

export const FirstFrameVideo = memo(function FirstFrameVideo({
  frameKey,
  onLoadedMetadata,
  onVideoElement,
  video,
  targetSeconds,
  suspended = false,
  compact = false,
  expanded = false,
}: {
  frameKey: string;
  onLoadedMetadata?: () => void;
  onVideoElement?: (video: HTMLVideoElement | null) => void;
  video: VideoInfo;
  /** A stable clock ref avoids rendering this surface for playback samples. */
  targetSeconds: number | RefObject<number>;
  suspended?: boolean;
  compact?: boolean;
  /** Fill the bounded enlarged viewer instead of deriving height from width. */
  expanded?: boolean;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const presentationRef = useRef<VideoFramePresentation | null>(null);
  const targetRef = useRef(targetSeconds);
  targetRef.current = targetSeconds;
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
      videoPlaybackUrl(video.url),
      frameKey,
      typeof targetRef.current === "number"
        ? targetRef.current
        : targetRef.current.current,
      suspended,
    );
    // Playback samples are observations, not seek commands. Decoder commands
    // go through seekVideoWithFrameGate; source changes use the latest target.
  }, [frameKey, suspended, video.url]);

  return (
    <div
      className={`relative isolate w-full overflow-hidden bg-slate-800 ${
        expanded ? "h-full min-h-0" : compact ? "aspect-[7/4]" : "aspect-[4/3]"
      }`}
      aria-busy={state.phase === "loading"}
      data-video-frame-state={state.phase}
      data-video-loading-stage={state.stage}
    >
      <video
        ref={setVideoRef}
        aria-label={video.filename}
        className={`absolute inset-0 h-full w-full object-contain ${state.phase === "ready" ? "visible" : "invisible"}`}
        disablePictureInPicture
        onLoadedMetadata={onLoadedMetadata}
        muted
        playsInline
        preload="auto"
      >
        {t("player.noVideoTag")}
      </video>
      {state.phase !== "ready" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface-1)]">
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
              <span>
                {t(
                  state.stage === "fetching"
                    ? "player.loadingVideoFrame"
                    : "player.decodingVideoFrame",
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

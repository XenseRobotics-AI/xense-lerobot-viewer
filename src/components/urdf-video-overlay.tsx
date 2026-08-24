"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useT } from "@/context/locale-context";
import type { VideoInfo } from "@/types";
import { THRESHOLDS } from "@/utils/constants";
import {
  groupUrdfReplayVideos,
  urdfReplayMediaTime,
} from "@/utils/urdfReplayVideos";

function fallbackLabel(filename: string): string {
  const tail = filename.split(/[./]/).at(-1) ?? filename;
  return tail.replaceAll("_", " ");
}

function ReplayVideoTile({
  active,
  compact = false,
  episodeTimeSeconds,
  playing,
  replayRevision,
  video,
}: {
  active: boolean;
  compact?: boolean;
  episodeTimeSeconds: number;
  playing: boolean;
  replayRevision: number;
  video: VideoInfo;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const targetTime = urdfReplayMediaTime(video, episodeTimeSeconds);
  const targetTimeRef = useRef(targetTime);
  const shouldPlayRef = useRef(active && playing);
  targetTimeRef.current = targetTime;
  shouldPlayRef.current = active && playing;

  const syncToReplay = useCallback((force: boolean) => {
    const element = videoRef.current;
    if (!element || element.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const tolerance = force ? 1 / 120 : THRESHOLDS.VIDEO_SYNC_TOLERANCE;
    if (Math.abs(element.currentTime - targetTimeRef.current) > tolerance) {
      element.currentTime = targetTimeRef.current;
    }
  }, []);

  const playFromReplay = useCallback(() => {
    const element = videoRef.current;
    if (!element || !shouldPlayRef.current || !element.paused) return;
    void element.play().catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== "AbortError") {
        console.warn(`Unable to play 3D Replay video ${video.filename}`);
      }
    });
  }, [video.filename]);

  // Paused slider changes are exact seeks. During playback the MP4 runs on its
  // own media clock and is only corrected when it drifts materially, avoiding
  // eight expensive decoder seeks on every rendered frame.
  useEffect(() => {
    if (!active) return;
    syncToReplay(!playing);
    // Seeking away from the native `ended` position does not resume an MP4
    // automatically. Restart it when the 3D frame counter loops to frame 0.
    playFromReplay();
  }, [active, playFromReplay, playing, syncToReplay, targetTime]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (!active || !playing) {
      element.pause();
      return;
    }
    syncToReplay(true);
    playFromReplay();
  }, [active, playFromReplay, playing, syncToReplay]);

  useEffect(() => {
    if (!active) return;
    syncToReplay(true);
    playFromReplay();
  }, [active, playFromReplay, replayRevision, syncToReplay]);

  const handleLoadedMetadata = useCallback(() => {
    syncToReplay(true);
    playFromReplay();
  }, [playFromReplay, syncToReplay]);

  const label = fallbackLabel(video.filename);

  return (
    <figure className="relative overflow-hidden rounded-md border border-white/15 bg-black/90 shadow-xl">
      <video
        ref={videoRef}
        aria-label={label}
        className={`block w-full bg-black object-contain ${
          compact ? "aspect-[7/4]" : "aspect-[4/3]"
        }`}
        disablePictureInPicture
        muted
        onLoadedMetadata={handleLoadedMetadata}
        playsInline
        preload="metadata"
        src={video.url}
      />
      <figcaption className="absolute left-1 top-1 max-w-[calc(100%-0.5rem)] truncate rounded bg-slate-950/75 px-1.5 py-0.5 text-[9px] font-medium leading-none text-slate-100 shadow backdrop-blur-sm">
        {label}
      </figcaption>
    </figure>
  );
}

function SideVideoGroup({
  active,
  episodeTimeSeconds,
  playing,
  replayRevision,
  videos,
}: {
  active: boolean;
  episodeTimeSeconds: number;
  playing: boolean;
  replayRevision: number;
  videos: VideoInfo[];
}) {
  const [primary, ...secondary] = videos;
  if (!primary) return null;
  return (
    <div className="space-y-1.5">
      <ReplayVideoTile
        key={`${primary.filename}:${primary.url}:${primary.segmentStart ?? 0}`}
        active={active}
        episodeTimeSeconds={episodeTimeSeconds}
        playing={playing}
        replayRevision={replayRevision}
        video={primary}
      />
      {secondary.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {secondary.map((video) => (
            <ReplayVideoTile
              key={`${video.filename}:${video.url}:${video.segmentStart ?? 0}`}
              active={active}
              compact
              episodeTimeSeconds={episodeTimeSeconds}
              playing={playing}
              replayRevision={replayRevision}
              video={video}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type VideoResizeEdge = "left" | "right";
type VideoLayerId = "left" | "center" | "right";

function ResizableVideoGroup({
  activeLayer,
  children,
  className,
  defaultWidth,
  maxWidth,
  maxWidthRatio,
  minWidth,
  onActivate,
  resetLabel,
  resizeEdges,
  resizeLabel,
}: {
  activeLayer: boolean;
  children: ReactNode;
  className: string;
  defaultWidth: string;
  maxWidth: number;
  maxWidthRatio: number;
  minWidth: number;
  onActivate: () => void;
  resetLabel: string;
  resizeEdges: readonly VideoResizeEdge[];
  resizeLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    resizeEdge: VideoResizeEdge;
    startWidth: number;
    startX: number;
  } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  const clampWidth = useCallback(
    (candidate: number) => {
      const overlayWidth =
        containerRef.current?.parentElement?.getBoundingClientRect().width ??
        window.innerWidth;
      const responsiveMaximum = Math.max(
        minWidth,
        Math.min(maxWidth, overlayWidth * maxWidthRatio),
      );
      return Math.round(
        Math.max(minWidth, Math.min(candidate, responsiveMaximum)),
      );
    },
    [maxWidth, maxWidthRatio, minWidth],
  );

  useEffect(() => {
    const overlay = containerRef.current?.parentElement;
    if (!overlay || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidth((current) => (current === null ? null : clampWidth(current)));
    });
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [clampWidth]);

  const handlePointerDown = useCallback(
    (
      resizeEdge: VideoResizeEdge,
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
      if (event.button !== 0 || !containerRef.current) return;
      onActivate();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        resizeEdge,
        startWidth: containerRef.current.getBoundingClientRect().width,
        startX: event.clientX,
      };
      setResizing(true);
    },
    [onActivate],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = drag.resizeEdge === "right" ? 1 : -1;
      setWidth(
        clampWidth(drag.startWidth + (event.clientX - drag.startX) * direction),
      );
    },
    [clampWidth],
  );

  const finishResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const grow =
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "+" ||
        event.key === "=";
      const shrink =
        event.key === "ArrowLeft" ||
        event.key === "ArrowDown" ||
        event.key === "-" ||
        event.key === "_";
      if (event.key === "Home" || event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        setWidth(null);
        return;
      }
      if (!grow && !shrink) return;
      onActivate();
      event.preventDefault();
      event.stopPropagation();
      const current =
        containerRef.current?.getBoundingClientRect().width ?? minWidth;
      setWidth(clampWidth(current + (grow ? 16 : -16)));
    },
    [clampWidth, minWidth, onActivate],
  );

  return (
    <div
      ref={containerRef}
      className={`${className} pointer-events-auto`}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
        setWidth(null);
      }}
      onPointerDownCapture={onActivate}
      style={{
        width: width === null ? defaultWidth : `${width}px`,
        zIndex: activeLayer ? 40 : 20,
      }}
    >
      {children}
      {resizeEdges.map((resizeEdge) => {
        const isRightHandle = resizeEdge === "right";
        return (
          <button
            key={resizeEdge}
            type="button"
            aria-label={resizeLabel}
            className={`pointer-events-auto absolute -bottom-1 z-30 flex h-6 w-6 items-center justify-center rounded border border-white/20 bg-slate-950/85 text-slate-300 shadow-lg backdrop-blur-sm transition-colors hover:border-cyan-400/60 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${
              isRightHandle
                ? "-right-1 cursor-nwse-resize"
                : "-left-1 cursor-nesw-resize"
            } ${resizing ? "border-cyan-400/70 text-cyan-300" : ""}`}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setWidth(null);
            }}
            onKeyDown={handleKeyDown}
            onLostPointerCapture={() => {
              dragRef.current = null;
              setResizing(false);
            }}
            onPointerCancel={finishResize}
            onPointerDown={(event) => handlePointerDown(resizeEdge, event)}
            onPointerMove={handlePointerMove}
            onPointerUp={finishResize}
            style={{ touchAction: "none" }}
            title={`${resizeLabel} · ${resetLabel}`}
          >
            <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16">
              <path
                d={isRightHandle ? "M7 14 14 7M11 14l3-3" : "M2 7l7 7M2 11l3 3"}
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.75"
              />
            </svg>
          </button>
        );
      })}
    </div>
  );
}

export default function UrdfVideoOverlay({
  active,
  episodeTimeSeconds,
  playing,
  replayRevision,
  videos,
}: {
  active: boolean;
  episodeTimeSeconds: number;
  playing: boolean;
  replayRevision: number;
  videos: VideoInfo[];
}) {
  const t = useT();
  const [frontLayer, setFrontLayer] = useState<VideoLayerId>("center");
  const groups = useMemo(() => groupUrdfReplayVideos(videos), [videos]);
  const hasAnyVideo =
    groups.left.length > 0 ||
    groups.center.length > 0 ||
    groups.right.length > 0;
  if (!hasAnyVideo) return null;

  const shared = { active, episodeTimeSeconds, playing, replayRevision };
  const hasSingleHead = groups.center.length === 1;
  const resizeLabels = {
    resetLabel: t("urdf.resetVideoSize"),
    resizeLabel: t("urdf.resizeVideo"),
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {groups.left.length > 0 && (
        <ResizableVideoGroup
          {...resizeLabels}
          activeLayer={frontLayer === "left"}
          className="absolute left-3 top-3"
          defaultWidth="clamp(13rem, 28vw, 22rem)"
          maxWidth={520}
          maxWidthRatio={0.42}
          minWidth={120}
          onActivate={() => setFrontLayer("left")}
          resizeEdges={["right"]}
        >
          <SideVideoGroup {...shared} videos={groups.left} />
        </ResizableVideoGroup>
      )}

      {groups.center.length > 0 && (
        <ResizableVideoGroup
          {...resizeLabels}
          activeLayer={frontLayer === "center"}
          className={`absolute left-1/2 top-3 grid -translate-x-1/2 gap-1.5 ${
            hasSingleHead ? "grid-cols-1" : "grid-cols-2"
          }`}
          defaultWidth={
            hasSingleHead
              ? "clamp(8rem, 16vw, 14rem)"
              : "clamp(12rem, 29vw, 26rem)"
          }
          maxWidth={760}
          maxWidthRatio={0.7}
          minWidth={hasSingleHead ? 128 : 240}
          onActivate={() => setFrontLayer("center")}
          resizeEdges={["left", "right"]}
        >
          {groups.center.map((video) => (
            <ReplayVideoTile
              key={`${video.filename}:${video.url}:${video.segmentStart ?? 0}`}
              {...shared}
              video={video}
            />
          ))}
        </ResizableVideoGroup>
      )}

      {groups.right.length > 0 && (
        <ResizableVideoGroup
          {...resizeLabels}
          activeLayer={frontLayer === "right"}
          className="absolute right-3 top-3"
          defaultWidth="clamp(13rem, 28vw, 22rem)"
          maxWidth={520}
          maxWidthRatio={0.42}
          minWidth={120}
          onActivate={() => setFrontLayer("right")}
          resizeEdges={["left"]}
        >
          <SideVideoGroup {...shared} videos={groups.right} />
        </ResizableVideoGroup>
      )}
    </div>
  );
}

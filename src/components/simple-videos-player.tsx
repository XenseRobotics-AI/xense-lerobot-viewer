"use client";

import React, { useEffect, useRef } from "react";
import { useTime } from "../context/time-context";
import { FaExpand, FaCompress, FaTimes, FaEye } from "react-icons/fa";
import type { VideoInfo } from "@/types";
import { VideoOverlayCanvas } from "./video-overlay-canvas";
import {
  episodeTimeFromMediaTime,
  mediaTimeFromEpisodeTime,
} from "@/utils/videoSegments";
import { useT } from "@/context/locale-context";

const THRESHOLDS = {
  VIDEO_SYNC_TOLERANCE: 0.2,
  VIDEO_SEGMENT_BOUNDARY: 0.05,
};

const VIDEO_READY_TIMEOUT_MS = 10_000;

type VideoPlayerProps = {
  videosInfo: VideoInfo[];
  /**
   * The episode currently being requested. This is separate from
   * `videosInfo`: while the next episode is loading, the parent intentionally
   * keeps the old data mounted. The player uses this signal to stop the old
   * media immediately instead of letting it continue behind the loading
   * overlay.
   */
  episodeId?: number;
  /** Keep the old media mounted for fast v3 switches, but pause it while the
   * next episode's metadata/data slice is being resolved. */
  loading?: boolean;
  onVideosReady?: () => void;
  /**
   * Mount the VQA bbox/keypoint overlay over each video. Off by default: the
   * overlay is annotation machinery and belongs only to the Annotations tab.
   */
  annotationOverlay?: boolean;
};

const videoEventCleanup = new WeakMap<HTMLVideoElement, () => void>();

export const SimpleVideosPlayer = ({
  videosInfo,
  episodeId,
  loading = false,
  onVideosReady,
  annotationOverlay = false,
}: VideoPlayerProps) => {
  const t = useT();
  const { currentTime, seek, externalSeekVersion, isPlaying, setIsPlaying } =
    useTime();
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  // Mirror videoRefs into state so the absolutely-positioned VQA overlay can
  // re-render with the actual <video> element once it mounts. Using a ref
  // alone means the overlay's first render still sees `null`.
  const [videoEls, setVideoEls] = React.useState<(HTMLVideoElement | null)[]>(
    () => [],
  );
  // Stable ref callbacks per index. If we used inline `(el) => { ... }` here
  // React would re-invoke the callback on every render (the function identity
  // changes), which combined with `setVideoEls` would toggle state on each
  // tick and produce a "Maximum update depth exceeded" loop.
  const videoRefCallbacksRef = useRef<
    ((el: HTMLVideoElement | null) => void)[]
  >([]);
  while (videoRefCallbacksRef.current.length < videosInfo.length) {
    const idx = videoRefCallbacksRef.current.length;
    videoRefCallbacksRef.current.push((el: HTMLVideoElement | null) => {
      videoRefs.current[idx] = el;
      setVideoEls((prev) => {
        if (prev[idx] === el) return prev;
        const next = prev.slice();
        next[idx] = el;
        return next;
      });
    });
  }
  const [hiddenVideos, setHiddenVideos] = React.useState<string[]>([]);
  const [enlargedVideo, setEnlargedVideo] = React.useState<string | null>(null);
  const [showHiddenMenu, setShowHiddenMenu] = React.useState(false);
  const [videosReady, setVideosReady] = React.useState(false);

  const hiddenSet = React.useMemo(() => new Set(hiddenVideos), [hiddenVideos]);

  const firstVisibleIdx = videosInfo.findIndex(
    (video) => !hiddenSet.has(video.filename),
  );

  // Last externalSeekVersion we observed in the sync effect. When the
  // context's version moves past this, an external seek happened and we
  // need to drive every video to the new position.
  const lastSeekVersionRef = useRef(externalSeekVersion);

  // Mirror firstVisibleIdx into a ref so the videos-ready effect doesn't have
  // to depend on it. If it did, hiding the first camera would tear the whole
  // effect down and back up, re-attaching `canplaythrough` listeners that
  // never re-fire (the videos are already loaded), leaving readyCount stuck
  // at 0 until the 10s timeout — at which point markReady forces play even
  // if the user paused.
  const firstVisibleIdxRef = useRef(firstVisibleIdx);
  useEffect(() => {
    firstVisibleIdxRef.current = firstVisibleIdx;
  }, [firstVisibleIdx]);

  // Mirror onVideosReady into a ref for the same reason. Parents typically
  // pass an inline arrow (`onVideosReady={() => setVideosReady(true)}`) which
  // gets a new identity every render. Including it in the videos-ready
  // effect's deps caused that effect to tear down + setup on every parent
  // render. The setup branch then ran `queueMicrotask(handleLoadedData)` for
  // every already-loaded video (true after the first load), seeking each
  // back to segmentStart — videos got pinned on their first frame and never
  // advanced.
  const onVideosReadyRef = useRef(onVideosReady);
  useEffect(() => {
    onVideosReadyRef.current = onVideosReady;
  }, [onVideosReady]);

  // Initialize video refs array
  useEffect(() => {
    videoRefs.current = videoRefs.current.slice(0, videosInfo.length);
  }, [videosInfo.length]);

  // Stop the previous episode as soon as selection changes. The parent keeps
  // the previous data around while the next parquet slice is being decoded;
  // without this effect that old media can keep playing underneath the
  // loading overlay. Do not change the source here — retaining the element
  // for a shared v3 MP4 is what lets the browser reuse its buffer.
  React.useLayoutEffect(() => {
    if (!loading) return;
    // The parent intentionally keeps the previous EpisodeData visible while
    // a new slice is loading. Stop both the media and this player's readiness
    // state so an old timeout/event cannot restart the previous episode.
    setVideosReady(false);
    setIsPlaying(false);
    videoRefs.current.forEach((video) => video?.pause());
  }, [loading, setIsPlaying]);

  // Seek the retained media element before the newly loaded episode paints.
  // v3 episodes commonly share one MP4; changing the URL would throw away
  // the browser's buffer, so the segment boundary is the thing that changes.
  React.useLayoutEffect(() => {
    if (loading || episodeId === undefined) return;
    videoRefs.current.forEach((video, index) => {
      const info = videosInfo[index];
      if (
        !video ||
        !info ||
        video.readyState < HTMLMediaElement.HAVE_METADATA
      ) {
        return;
      }
      video.pause();
      video.currentTime = mediaTimeFromEpisodeTime(info, 0);
    });
  }, [episodeId, loading, videosInfo]);

  // Handle videos ready — with a timeout fallback so the UI never hangs
  // if a video fails to reach canplaythrough (e.g. network stall).
  useEffect(() => {
    let cancelled = false;
    if (loading) {
      setVideosReady(false);
      return () => {
        cancelled = true;
      };
    }
    let readyCount = 0;
    let resolved = false;

    const markReady = () => {
      if (cancelled || resolved) return;
      resolved = true;
      setVideosReady(true);
      onVideosReadyRef.current?.();
      setIsPlaying(true);
    };

    const checkReady = () => {
      if (cancelled) return;
      readyCount++;
      if (readyCount >= videosInfo.length) markReady();
    };

    const timeout = setTimeout(markReady, VIDEO_READY_TIMEOUT_MS);

    // Coordinated loop reset — when the primary video hits its segment end
    // (or natural end), seek every camera to its own segmentStart in a
    // single synchronous burst. The previous design seeked the primary,
    // then bumped externalSeekVersion which scheduled the other seeks via
    // a React render — leaving an 80ms (throttled) gap where the primary
    // played fresh frames while the others still showed the segment-end
    // frame. Now the gap is microseconds.
    const loopAllVideos = () => {
      if (cancelled) return;
      videoRefs.current.forEach((other, otherIdx) => {
        if (!other) return;
        const otherInfo = videosInfo[otherIdx];
        if (!otherInfo) return;
        other.currentTime = otherInfo.segmentStart ?? 0;
      });
      // Update the slider as a status report — don't bump externalSeekVersion
      // since we already drove every video to its target.
      seek(0, "video");
    };

    // Capture the nodes this effect actually attaches to. React can clear a
    // callback ref during a keyed media replacement before running the effect
    // cleanup; reading `videoRefs.current` there would then miss the old node
    // and leave its timeupdate handler alive.
    const attachedVideos = videoRefs.current.slice();
    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      const info = videosInfo[index];

      // One timeupdate handler per video covers both jobs:
      // (a) loop-reset on segmented videos at segment-end
      // (b) reporting the primary video's currentTime back to the context
      const handleTimeUpdate = () => {
        if (info.isSegmented) {
          const segmentEnd = info.segmentEnd ?? video.duration;
          const segmentStart = info.segmentStart ?? 0;
          if (
            video.currentTime >=
            segmentEnd - THRESHOLDS.VIDEO_SEGMENT_BOUNDARY
          ) {
            // Primary drives the coordinated loop. Non-primary cameras
            // that race ahead just snap to segmentStart and wait — the
            // primary's next loop will re-align everyone.
            if (index === firstVisibleIdxRef.current) {
              loopAllVideos();
            } else {
              video.currentTime = segmentStart;
            }
            return;
          }
        }
        if (index === firstVisibleIdxRef.current) {
          // Clamped into the segment: the first `timeupdate` after a load or
          // an episode switch arrives while the element still sits at 0, i.e.
          // before the seek to `segmentStart` has landed. The raw difference
          // is then `-segmentStart` — a large negative time on the playback
          // bar for any episode deep inside a shared v3 MP4.
          seek(episodeTimeFromMediaTime(info, video.currentTime), "video");
        }
      };

      // For segmented videos, snap into the segment when play() is called
      // — covers the case where the user paused outside the segment range.
      const handlePlay = info.isSegmented
        ? () => {
            const segmentStart = info.segmentStart ?? 0;
            const segmentEnd = info.segmentEnd ?? video.duration;
            if (
              video.currentTime < segmentStart ||
              video.currentTime >= segmentEnd
            ) {
              video.currentTime = segmentStart;
            }
          }
        : null;

      let countedAsReady = false;
      const markVideoReady = () => {
        if (cancelled || countedAsReady) return;
        countedAsReady = true;
        checkReady();
      };

      // A seek inside an already-loaded MP4 does not reliably emit another
      // `loadeddata`. That made a fast shared-shard episode switch sit behind
      // the 10-second fallback even though the requested frame was already
      // decoded. Treat `seeked`/`canplay` as the authoritative completion
      // signals, and count each camera only after it is at the new segment.
      const handleSegmentReady = info.isSegmented
        ? () => {
            if (cancelled || countedAsReady) return;
            const targetTime = mediaTimeFromEpisodeTime(info, 0);
            if (
              Math.abs(video.currentTime - targetTime) >
              THRESHOLDS.VIDEO_SEGMENT_BOUNDARY
            ) {
              if (
                video.readyState >= HTMLMediaElement.HAVE_METADATA &&
                !video.seeking
              ) {
                video.currentTime = targetTime;
              }
              return;
            }
            if (
              video.seeking ||
              video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
            ) {
              return;
            }
            markVideoReady();
          }
        : null;

      const handleEnded = info.isSegmented
        ? null
        : () => {
            // Same coordinated loop strategy for non-segmented videos at
            // their natural end — primary drives, others wait for primary
            // to align them.
            if (index === firstVisibleIdxRef.current) {
              loopAllVideos();
            } else {
              video.currentTime = 0;
            }
          };

      video.addEventListener("timeupdate", handleTimeUpdate);
      if (handlePlay) video.addEventListener("play", handlePlay);
      if (handleEnded) video.addEventListener("ended", handleEnded);

      // Already-loaded videos (cached or fast network) may not re-fire a
      // readiness event after we attach the listener. Check the current state
      // in a microtask as well; otherwise only the 10s fallback would unfreeze
      // the UI.
      if (info.isSegmented && handleSegmentReady) {
        video.addEventListener("loadeddata", handleSegmentReady);
        video.addEventListener("canplay", handleSegmentReady);
        video.addEventListener("seeked", handleSegmentReady);

        const targetTime = mediaTimeFromEpisodeTime(info, 0);
        if (
          video.readyState >= HTMLMediaElement.HAVE_METADATA &&
          !video.seeking &&
          Math.abs(video.currentTime - targetTime) >
            THRESHOLDS.VIDEO_SEGMENT_BOUNDARY
        ) {
          video.currentTime = targetTime;
        }
        queueMicrotask(handleSegmentReady);
      } else if (!info.isSegmented) {
        if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
          queueMicrotask(checkReady);
        } else {
          video.addEventListener("canplaythrough", checkReady, { once: true });
        }
      }

      videoEventCleanup.set(video, () => {
        video.removeEventListener("timeupdate", handleTimeUpdate);
        if (handlePlay) video.removeEventListener("play", handlePlay);
        if (handleSegmentReady) {
          video.removeEventListener("loadeddata", handleSegmentReady);
          video.removeEventListener("canplay", handleSegmentReady);
          video.removeEventListener("seeked", handleSegmentReady);
        }
        if (handleEnded) video.removeEventListener("ended", handleEnded);
        video.removeEventListener("canplaythrough", checkReady);
      });
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      attachedVideos.forEach((video) => {
        if (!video) return;
        video.pause();
        const cleanup = videoEventCleanup.get(video);
        if (cleanup) {
          cleanup();
          videoEventCleanup.delete(video);
        }
      });
    };
    // firstVisibleIdx intentionally omitted — we read it via ref so hiding
    // the first camera doesn't reset readiness (see the comment near
    // firstVisibleIdxRef above).
    // onVideosReady intentionally omitted — read via onVideosReadyRef so
    // an inline parent prop doesn't tear this effect down on every render.
  }, [loading, videosInfo, setIsPlaying, seek]);

  // Handle play/pause — skip hidden videos
  useEffect(() => {
    if (!videosReady) return;

    videoRefs.current.forEach((video, idx) => {
      if (!video || hiddenSet.has(videosInfo[idx].filename)) return;
      if (isPlaying) {
        video.play().catch((e) => {
          if (e.name !== "AbortError") {
            console.error("Error playing video");
          }
        });
      } else {
        video.pause();
      }
    });
  }, [isPlaying, videosReady, hiddenSet, videosInfo]);

  // Drive every video to currentTime on external seeks (slider drag, chart
  // click, loop reset). The version-based check replaces a 0.3s heuristic
  // that misfired when a network stall produced a >0.3s timeupdate jump
  // and incorrectly classified it as a user seek — causing every camera to
  // re-seek, which itself stalled them in a feedback spiral.
  useEffect(() => {
    if (!videosReady) return;
    if (externalSeekVersion === lastSeekVersionRef.current) return;
    lastSeekVersionRef.current = externalSeekVersion;

    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      if (hiddenSet.has(videosInfo[index].filename)) return;

      const info = videosInfo[index];
      const targetTime = mediaTimeFromEpisodeTime(info, currentTime);

      if (
        Math.abs(video.currentTime - targetTime) >
        THRESHOLDS.VIDEO_SYNC_TOLERANCE
      ) {
        video.currentTime = targetTime;
      }
    });
  }, [externalSeekVersion, currentTime, videosInfo, videosReady, hiddenSet]);

  return (
    <>
      {/* Hidden videos menu */}
      {hiddenVideos.length > 0 && (
        <div className="relative mb-4">
          <button
            className="inline-flex items-center gap-2 h-8 rounded-md panel px-3 text-xs text-slate-300 hover:text-slate-100 hover:bg-white/5 transition-colors"
            onClick={() => setShowHiddenMenu(!showHiddenMenu)}
          >
            <FaEye size={11} />{" "}
            {t("player.showHidden", { count: hiddenVideos.length })}
          </button>
          {showHiddenMenu && (
            <div className="absolute left-0 mt-1.5 w-max panel-raised bg-[var(--surface-1)] shadow-xl p-1.5 z-50">
              <div className="mb-1 px-2 text-[10px] uppercase tracking-wide text-slate-500">
                {t("player.restoreHidden")}
              </div>
              {hiddenVideos.map((filename) => (
                <button
                  key={filename}
                  className="block w-full text-left px-2 py-1 rounded-md text-xs text-slate-300 hover:text-slate-100 hover:bg-white/5 transition-colors"
                  onClick={() =>
                    setHiddenVideos((prev) =>
                      prev.filter((v) => v !== filename),
                    )
                  }
                >
                  {filename}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Videos */}
      <div className="flex flex-wrap gap-x-2 gap-y-6">
        {videosInfo.map((info, idx) => {
          if (hiddenVideos.includes(info.filename)) return null;

          const isEnlarged = enlargedVideo === info.filename;

          return (
            <div
              // Camera names stay the same across episodes. Use the actual
              // media URL as the identity: v3 episodes commonly share one
              // MP4 and only change segmentStart/segmentEnd, so that element
              // can be retained and seeked without another media load. When
              // the URL changes (for example a v2 episode or a new v3 file),
              // React replaces the tile and cannot retain the old resource.
              key={`${info.filename}:${info.url}`}
              className={`${
                isEnlarged
                  ? "z-40 fixed inset-0 bg-black bg-opacity-90 flex flex-col items-center justify-center"
                  : "max-w-96"
              }`}
            >
              <p className="truncate w-full rounded-t-md bg-[var(--surface-1)] border border-b-0 border-white/5 px-2.5 py-1 text-[11px] text-slate-400 flex items-center justify-between gap-2">
                <span className="truncate">{info.filename}</span>
                <span className="flex gap-0.5 shrink-0">
                  <button
                    title={
                      isEnlarged ? t("player.minimize") : t("player.enlarge")
                    }
                    className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
                    onClick={() =>
                      setEnlargedVideo(isEnlarged ? null : info.filename)
                    }
                  >
                    {isEnlarged ? (
                      <FaCompress size={10} />
                    ) : (
                      <FaExpand size={10} />
                    )}
                  </button>
                  <button
                    title={t("player.hide")}
                    className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                    onClick={() => {
                      setHiddenVideos((prev) => [...prev, info.filename]);
                      // If the user hid the camera that was enlarged, clear
                      // the enlarged state too — otherwise it stays pointed
                      // at the now-hidden filename and pops back to fullscreen
                      // the moment the user un-hides it.
                      if (enlargedVideo === info.filename) {
                        setEnlargedVideo(null);
                      }
                    }}
                    disabled={
                      videosInfo.filter(
                        (v) => !hiddenVideos.includes(v.filename),
                      ).length === 1
                    }
                  >
                    <FaTimes size={10} />
                  </button>
                </span>
              </p>
              <div className="relative w-full">
                <video
                  ref={videoRefCallbacksRef.current[idx]}
                  className={`w-full object-contain ${
                    isEnlarged ? "max-h-[90vh] max-w-[90vw]" : ""
                  }`}
                  muted
                  preload="metadata"
                  src={info.url}
                >
                  {t("player.noVideoTag")}
                </video>
                {/* VQA bbox/keypoint overlay. Reads atoms + drawMode from
                    AnnotationsContext; pointer-events fall through when
                    not in draw mode so video controls remain usable. */}
                {annotationOverlay && (
                  <VideoOverlayCanvas
                    videoEl={videoEls[idx] ?? null}
                    cameraKey={info.filename}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

export default SimpleVideosPlayer;

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VideoInfo } from "@/types";
import {
  losslessPlaybackUrl,
  losslessPlaybackVideo,
  videoPlaybackUrl,
  type PlaybackColor,
} from "@/utils/videoPlaybackUrl";

function displayedColor(video: VideoInfo): PlaybackColor | undefined {
  try {
    const source = new URL(videoPlaybackUrl(video.url), window.location.href)
      .href;
    const element = Array.from(document.querySelectorAll("video")).find(
      (v) =>
        v.getAttribute("aria-label") === video.filename && v.src === source,
    );
    if (!element || element.readyState < 2 || typeof VideoFrame === "undefined")
      return;
    const frame = new VideoFrame(element, { timestamp: 0 });
    const color = frame.colorSpace.toJSON();
    frame.close();
    if (
      ["bt709", "smpte170m"].includes(color.matrix ?? "") &&
      ["bt709", "smpte170m"].includes(color.primaries ?? "") &&
      ["bt709", "smpte170m", "iec61966-2-1"].includes(color.transfer ?? "") &&
      typeof color.fullRange === "boolean"
    )
      return color as PlaybackColor;
  } catch {
    /* Some codecs do not expose a decoded frame before preparation. */
  }
}

async function readyDisplayColor(
  video: VideoInfo,
  signal: AbortSignal,
): Promise<PlaybackColor | undefined> {
  signal.throwIfAborted();
  const source = new URL(videoPlaybackUrl(video.url), window.location.href)
    .href;
  const element = Array.from(document.querySelectorAll("video")).find(
    (v) => v.getAttribute("aria-label") === video.filename && v.src === source,
  );
  if (!element || element.readyState >= 2 || element.error)
    return displayedColor(video);
  // An early click must not encode before the original frame's display colour
  // is known. An unsupported original decoder can still use compatibility.
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener("loadeddata", done);
      element.removeEventListener("error", done);
      signal.removeEventListener("abort", aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Original display colour is not ready"));
    }, 30000);
    element.addEventListener("loadeddata", done, { once: true });
    element.addEventListener("error", done, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  return displayedColor(video);
}

type Phase = "original" | "preparing" | "compatible" | "unavailable" | "error";
type Result = { key: string; phase: Phase; done: number; videos?: VideoInfo[] };
export type VideoCompatibility = {
  phase: Phase;
  done: number;
  total: number;
  available: boolean;
  videos: VideoInfo[];
  toggle: () => void;
};

/** Prepare a complete episode before switching sources; retain the current frames meanwhile. */
export function useVideoCompatibility(
  videos: VideoInfo[],
  identity: string,
  active: boolean,
): VideoCompatibility {
  const [enabled, setEnabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = useMemo(
    () =>
      JSON.stringify([
        identity,
        videos.map((v) => [v.filename, v.url, v.segmentStart, v.segmentEnd]),
      ]),
    [identity, videos],
  );
  const [result, setResult] = useState<Result>({
    key: "",
    phase: "original",
    done: 0,
  });
  const input = useRef(videos);
  const current = useRef(result);
  input.current = videos;
  current.current = result;
  const available =
    videos.length >= 4 &&
    videos.some((video) => losslessPlaybackUrl(video) !== null);
  const leaseScope = useMemo(
    () => ({
      key,
      enabled,
      id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    }),
    [key, enabled],
  );
  const lease = leaseScope.id;
  const leases = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    if (!enabled) return;
    const ownedLeases = leases.current;
    const release = () => {
      for (const cacheKey of ownedLeases.get(lease) ?? []) {
        void fetch(`/api/video-playback-cache/${cacheKey}?lease=${lease}`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => undefined);
      }
      ownedLeases.delete(lease);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [enabled, key, lease]);

  useEffect(() => {
    if (!enabled) {
      setResult({ key, phase: "original", done: 0 });
      return;
    }
    if (!active || !available) return;
    if (
      current.current.key === key &&
      current.current.phase === "compatible" &&
      current.current.videos?.every(
        (video) =>
          !video.url.includes("compat=lossless-h264") ||
          new URL(video.url, "http://localhost").searchParams.get("lease") ===
            lease,
      )
    )
      return;
    const controller = new AbortController();
    const sources = input.current;
    const retained =
      current.current.key === key ? current.current.videos : undefined;
    let done = 0;
    setResult({
      key,
      phase: "preparing",
      done,
      ...(retained ? { videos: retained } : {}),
    });
    void Promise.all(
      sources.map(async (video) => {
        if (!losslessPlaybackUrl(video)) return video;
        const color = await readyDisplayColor(video, controller.signal);
        const url = losslessPlaybackUrl(video, lease, color);
        if (!url) return video;
        const response = await fetch(url, {
          method: "HEAD",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error("Unable to prepare compatible playback");
        const cacheKey = response.headers.get("x-video-cache-key");
        if (cacheKey) {
          if (controller.signal.aborted) {
            void fetch(`/api/video-playback-cache/${cacheKey}?lease=${lease}`, {
              method: "DELETE",
              keepalive: true,
            }).catch(() => undefined);
          } else {
            const keys = leases.current.get(lease) ?? new Set<string>();
            keys.add(cacheKey);
            leases.current.set(lease, keys);
          }
        }
        done++;
        if (!controller.signal.aborted)
          setResult({
            key,
            phase: "preparing",
            done,
            ...(retained ? { videos: retained } : {}),
          });
        return response.headers.get("x-video-playback-codec") ===
          "h264-lossless"
          ? losslessPlaybackVideo(video, url)
          : video;
      }),
    )
      .then((prepared) => {
        if (controller.signal.aborted) return;
        const converted = prepared.some(
          (video, index) => video.url !== sources[index].url,
        );
        setResult({
          key,
          phase: converted ? "compatible" : "unavailable",
          done,
          ...(converted ? { videos: prepared } : {}),
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        controller.abort();
        for (const cacheKey of leases.current.get(lease) ?? []) {
          void fetch(`/api/video-playback-cache/${cacheKey}?lease=${lease}`, {
            method: "DELETE",
            keepalive: true,
          }).catch(() => undefined);
        }
        leases.current.delete(lease);
        setResult({ key, phase: "error", done });
      });
    return () => controller.abort();
  }, [enabled, attempt, key, active, available, lease]);

  useEffect(() => {
    if (
      !enabled ||
      result.key !== key ||
      result.phase !== "compatible" ||
      !result.videos
    )
      return;
    const sources = result.videos;
    const controller = new AbortController();
    let busy = false;
    const heartbeat = async () => {
      if (busy) return;
      busy = true;
      try {
        await Promise.all(
          sources
            .filter((video) => video.url.includes("compat=lossless-h264"))
            .map((video) =>
              fetch(video.url, {
                method: "HEAD",
                cache: "no-store",
                signal: controller.signal,
              }),
            ),
        );
      } catch {
        /* A later media request can refresh its lease after reconnection. */
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void heartbeat();
    }, 60000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [enabled, key, result]);

  const phase = result.key === key ? result.phase : "original";
  return {
    phase,
    done: result.key === key ? result.done : 0,
    total: videos.length,
    available,
    videos:
      enabled && result.key === key && result.videos ? result.videos : videos,
    toggle: () => {
      if (enabled && (phase === "compatible" || phase === "preparing"))
        setEnabled(false);
      else {
        setEnabled(true);
        setAttempt((value) => value + 1);
      }
    },
  };
}

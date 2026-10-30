import type { VideoInfo } from "@/types";
import { VideoFramePresentation } from "./videoFramePresentation";

const MAX_POSTER_BYTES = 256 * 1024;
const POSTER_TTL_MS = 10 * 60_000;
const POSTER_DECODE_TIMEOUT_MS = 15_000;
const POSTER_MAX_WIDTH = 640;
const MAX_PREWARM_CAMERAS = 2;
const MAX_POSTER_CACHE_BYTES = 24 * 1024 * 1024;
type Poster = { value: string; bytes: number; expiresAt: number };

const posters = new Map<string, Poster>();
const subscribers = new Map<string, Set<() => void>>();
let posterCacheBytes = 0;
let prewarmTask: Promise<void> | null = null;

export function videoFramePosterKey(
  identity: string,
  video: VideoInfo,
  targetSeconds: number,
): string {
  const time = Number.isFinite(targetSeconds) ? Math.max(0, targetSeconds) : 0;
  return `${identity}\u0000${video.filename}\u0000${video.url}\u0000${time.toFixed(3)}`;
}

export function getPrefetchedVideoPoster(key: string): string | null {
  const poster = posters.get(key);
  if (!poster) return null;
  if (Date.now() >= poster.expiresAt) {
    posters.delete(key);
    posterCacheBytes -= poster.bytes;
    return null;
  }
  posters.delete(key);
  posters.set(key, poster);
  return poster.value;
}

export function subscribePrefetchedVideoPoster(
  key: string,
  notify: () => void,
): () => void {
  const listeners = subscribers.get(key) ?? new Set();
  listeners.add(notify);
  subscribers.set(key, listeners);
  return () => {
    listeners.delete(notify);
    if (!listeners.size) subscribers.delete(key);
  };
}

function rememberPoster(key: string, value: string): void {
  const payload = value.slice(value.indexOf(",") + 1);
  const bytes = Math.floor((payload.length * 3) / 4);
  if (!payload || bytes > MAX_POSTER_BYTES) return;
  const existing = posters.get(key);
  if (existing) posterCacheBytes -= existing.bytes;
  posters.delete(key);
  while (
    posters.size &&
    (posters.size >= 128 || posterCacheBytes + bytes > MAX_POSTER_CACHE_BYTES)
  ) {
    const oldestKey = posters.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = posters.get(oldestKey);
    posters.delete(oldestKey);
    if (oldest) posterCacheBytes -= oldest.bytes;
  }
  posters.set(key, { value, bytes, expiresAt: Date.now() + POSTER_TTL_MS });
  posterCacheBytes += bytes;
  subscribers.get(key)?.forEach((notify) => notify());
}

export function preferredPrewarmCameras(videos: VideoInfo[]): VideoInfo[] {
  const eligible = videos.filter(
    (video) => !/tactile|touch|gel/i.test(video.filename),
  );
  const wrists = eligible.filter((video) => /wrist/i.test(video.filename));
  return (wrists.length ? wrists : eligible).slice(0, MAX_PREWARM_CAMERAS);
}

async function decodePoster(
  videoInfo: VideoInfo,
  key: string,
  shouldContinue: () => boolean,
): Promise<string | null> {
  if (!shouldContinue()) return null;
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  return new Promise((resolve) => {
    let complete = false;
    const presentationRef: { dispose?: () => void } = {};
    const finish = (value: string | null) => {
      if (complete) return;
      complete = true;
      clearInterval(cancelCheck);
      clearTimeout(timeout);
      presentationRef.dispose?.();
      video.pause();
      video.removeAttribute("src");
      video.load();
      canvas.width = 0;
      canvas.height = 0;
      resolve(value);
    };
    const cancelCheck = setInterval(() => {
      if (!shouldContinue()) finish(null);
    }, 200);
    const timeout = setTimeout(() => finish(null), POSTER_DECODE_TIMEOUT_MS);
    const presentation = new VideoFramePresentation(video, (state) => {
      if (state.phase === "error") {
        finish(null);
        return;
      }
      if (state.phase !== "ready" || !video.videoWidth || !video.videoHeight)
        return;
      const scale = Math.min(1, POSTER_MAX_WIDTH / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        finish(null);
        return;
      }
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL("image/jpeg", 0.72);
        const payload = image.slice(image.indexOf(",") + 1);
        finish(
          Math.floor((payload.length * 3) / 4) <= MAX_POSTER_BYTES
            ? image
            : null,
        );
      } catch {
        finish(null);
      }
    });
    presentationRef.dispose = () => presentation.dispose();
    const target = videoInfo.isSegmented
      ? Math.max(0, videoInfo.segmentStart ?? 0)
      : 0;
    presentation.update(videoInfo.url, key, target, false);
  });
}

/** Decode small first-frame posters for at most two primary cameras at a time. */
export function prefetchEpisodeVideoPosters(
  datasetKey: string,
  episodeId: number,
  videos: VideoInfo[],
  shouldContinue: () => boolean,
): Promise<void> {
  if (typeof document === "undefined" || !videos.length || !shouldContinue())
    return Promise.resolve();

  if (prewarmTask) {
    return prewarmTask.then(() =>
      shouldContinue()
        ? prefetchEpisodeVideoPosters(
            datasetKey,
            episodeId,
            videos,
            shouldContinue,
          )
        : undefined,
    );
  }

  const identity = `${datasetKey}:${episodeId}`;
  const candidates = preferredPrewarmCameras(videos);
  if (
    candidates.every((video) =>
      getPrefetchedVideoPoster(
        videoFramePosterKey(
          identity,
          video,
          video.isSegmented ? (video.segmentStart ?? 0) : 0,
        ),
      ),
    )
  )
    return Promise.resolve();

  const task = (async () => {
    try {
      for (const video of candidates) {
        if (!shouldContinue()) break;
        const time = video.isSegmented ? (video.segmentStart ?? 0) : 0;
        const key = videoFramePosterKey(identity, video, time);
        if (getPrefetchedVideoPoster(key)) continue;
        let poster: string | null = null;
        try {
          poster = await decodePoster(video, key, shouldContinue);
        } catch {
          // A poster is an optional warm cache; the visible player owns errors.
        }
        if (poster) rememberPoster(key, poster);
      }
    } finally {
      prewarmTask = null;
    }
  })();
  prewarmTask = task;
  return task;
}

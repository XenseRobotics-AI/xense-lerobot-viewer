import type { VideoInfo } from "@/types";

/**
 * v3 datasets pack many episodes into one MP4, so an episode occupies the
 * window `[segmentStart, segmentEnd)` of the underlying media clock while
 * every player, chart and timeline speaks episode-local time starting at 0.
 *
 * These two functions are the whole mapping between those clocks, and they
 * live together so the directions cannot drift apart. Both clamp: the media
 * clock is free to sit outside the episode's window — a fresh `<video>` reads
 * 0 until the seek to `segmentStart` lands — and episode time is not.
 */

/** Where this episode starts on the media clock (0 for a whole-file video). */
function segmentStartOf(video: VideoInfo): number {
  return video.isSegmented ? Math.max(0, video.segmentStart ?? 0) : 0;
}

/** Where it ends, or `undefined` when the file runs to its natural end. */
function segmentEndOf(video: VideoInfo): number | undefined {
  if (!video.isSegmented) return undefined;
  const end = video.segmentEnd;
  return end !== undefined && Number.isFinite(end) ? end : undefined;
}

/** Convert episode-local replay time to time in the underlying MP4 shard. */
export function mediaTimeFromEpisodeTime(
  video: VideoInfo,
  episodeTimeSeconds: number,
): number {
  const localTime = Number.isFinite(episodeTimeSeconds)
    ? Math.max(0, episodeTimeSeconds)
    : 0;
  const segmentStart = segmentStartOf(video);
  const target = segmentStart + localTime;
  const segmentEnd = segmentEndOf(video);

  if (segmentEnd === undefined) return target;
  // Staying a millisecond inside the segment avoids the browser briefly
  // presenting the first frame of the following episode at the right edge.
  return Math.min(target, Math.max(segmentStart, segmentEnd - 0.001));
}

/**
 * Convert a reading of the media clock back to episode-local time.
 *
 * The clamp at 0 is load-bearing: a segmented `<video>` fires `timeupdate`
 * from its own clock, and the first ones arrive while it still sits at 0 —
 * before the `loadeddata` seek to `segmentStart` has landed. Reporting the
 * raw difference then hands the playback bar `-segmentStart`, which for an
 * episode deep inside a shared MP4 is a large negative time.
 */
export function episodeTimeFromMediaTime(
  video: VideoInfo,
  mediaTimeSeconds: number,
): number {
  if (!Number.isFinite(mediaTimeSeconds)) return 0;
  const segmentStart = segmentStartOf(video);
  const segmentEnd = segmentEndOf(video);
  const localTime = Math.max(0, mediaTimeSeconds - segmentStart);

  if (segmentEnd === undefined) return localTime;
  return Math.min(localTime, Math.max(0, segmentEnd - segmentStart));
}

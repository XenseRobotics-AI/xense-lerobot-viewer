import { parseLocalDatasetFileApiUrl } from "./datasetRoute";
import type { VideoInfo } from "@/types";
import { videoSegmentStart, videoSegmentEnd } from "./videoSegments";

export type PlaybackColor = {
  matrix: "bt709" | "smpte170m";
  primaries: "bt709" | "smpte170m";
  transfer: "bt709" | "smpte170m" | "iec61966-2-1";
  fullRange: boolean;
};

/** Playback uses a separate representation; file downloads retain original bytes. */
export function videoPlaybackUrl(source: string): string {
  if (!source.startsWith("/api/local-datasets/")) return source;
  const file = parseLocalDatasetFileApiUrl(source);
  if (!file?.filePath.at(-1)?.toLowerCase().endsWith(".mp4")) return source;
  const url = new URL(source, "http://localhost");
  url.searchParams.set("playback", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function losslessPlaybackUrl(
  video: VideoInfo,
  lease?: string,
  color?: PlaybackColor,
): string | null {
  const file = parseLocalDatasetFileApiUrl(video.url);
  if (!file?.filePath.at(-1)?.toLowerCase().endsWith(".mp4")) return null;
  if (!video.url.startsWith("/api/local-datasets/")) return null;
  const url = new URL(videoPlaybackUrl(video.url), "http://localhost");
  url.searchParams.set("compat", "lossless-h264");
  url.searchParams.set("from", String(videoSegmentStart(video)));
  const end = videoSegmentEnd(video);
  if (end !== undefined) url.searchParams.set("to", String(end));
  if (lease !== undefined) url.searchParams.set("lease", lease);
  if (color) {
    url.searchParams.set("matrix", color.matrix);
    url.searchParams.set("primaries", color.primaries);
    url.searchParams.set("transfer", color.transfer);
    url.searchParams.set("full_range", color.fullRange ? "1" : "0");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An episode copy starts at zero; map the existing episode clock to that file. */
export function losslessPlaybackVideo(
  video: VideoInfo,
  url: string,
): VideoInfo {
  const end = videoSegmentEnd(video);
  return {
    ...video,
    url,
    isSegmented: true,
    segmentStart: 0,
    ...(end === undefined
      ? { segmentEnd: undefined }
      : { segmentEnd: end - videoSegmentStart(video) }),
  };
}

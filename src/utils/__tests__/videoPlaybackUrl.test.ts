import { describe, expect, test } from "bun:test";
import {
  videoPlaybackUrl,
  losslessPlaybackUrl,
  losslessPlaybackVideo,
} from "../videoPlaybackUrl";
import {
  mediaTimeFromEpisodeTime,
  episodeTimeFromMediaTime,
} from "../videoSegments";

describe("video playback representation", () => {
  test("maps a later episode to its copy without changing the source interval or user timeline", () => {
    const original = {
      filename: "camera",
      url: "/api/local-datasets/root/cam.mp4",
      isSegmented: true,
      segmentStart: 92.5,
      segmentEnd: 176.63333333333333,
    };
    const copy = losslessPlaybackVideo(
      original,
      losslessPlaybackUrl(original)!,
    );
    expect(copy.segmentStart).toBe(0);
    expect(copy.segmentEnd).toBeCloseTo(84.13333333333333);
    expect(mediaTimeFromEpisodeTime(copy, 50)).toBe(50);
    expect(episodeTimeFromMediaTime(copy, 50)).toBe(50);
    expect(mediaTimeFromEpisodeTime(original, 50)).toBe(142.5);
    expect(new URL(copy.url, "http://localhost").searchParams.get("from")).toBe(
      "92.5",
    );
  });
  test("lossless playback preserves absolute episode bounds and existing URL fields", () => {
    const url = losslessPlaybackUrl(
      {
        filename: "camera",
        url: "/api/local-datasets/root/cam.mp4?source=next#t=4",
        isSegmented: true,
        segmentStart: 92.5,
        segmentEnd: 185,
      },
      "a".repeat(32),
    );
    const parsed = new URL(url!, "http://localhost");
    expect(parsed.searchParams.get("from")).toBe("92.5");
    expect(parsed.searchParams.get("to")).toBe("185");
    expect(parsed.searchParams.get("source")).toBe("next");
    expect(parsed.searchParams.get("lease")).toBe("a".repeat(32));
    expect(parsed.hash).toBe("#t=4");
  });
  test("compatibility preparation does not rewrite external or non-MP4 sources", () => {
    for (const url of [
      "/clip.mp4",
      "https://example.com/movie.mp4",
      "/api/local-datasets/root/movie.webm?playback=1",
      "/api/local-datasets/root/%ZZ.mp4",
    ])
      expect(losslessPlaybackUrl({ filename: "camera", url })).toBeNull();
  });
  test("opts local MP4 playback into faststart while preserving query and fragment", () => {
    expect(
      videoPlaybackUrl(
        "/api/local-datasets/root/videos/cam.mp4?source=next#t=3",
      ),
    ).toBe(
      "/api/local-datasets/root/videos/cam.mp4?source=next&playback=1#t=3",
    );
    expect(
      videoPlaybackUrl("/api/local-datasets/root/videos/cam.MP4?playback=1"),
    ).toBe("/api/local-datasets/root/videos/cam.MP4?playback=1");
  });
  test("leaves other sources and formats unchanged", () => {
    for (const url of [
      "/clip.mp4",
      "blob:abc",
      "https://example.com/api/local-datasets/root/cam.mp4",
      "/api/local-datasets/root/cam.webm",
      "/api/local-datasets/root/%ZZ.mp4",
    ])
      expect(videoPlaybackUrl(url)).toBe(url);
  });
});

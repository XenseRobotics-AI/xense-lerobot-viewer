import { describe, expect, test } from "bun:test";
import type { VideoInfo } from "@/types";
import {
  episodeTimeFromMediaTime,
  mediaTimeFromEpisodeTime,
} from "@/utils/videoSegments";

const wholeFile: VideoInfo = {
  filename: "observation.images.head",
  url: "/head.mp4",
};

const segmented: VideoInfo = {
  filename: "observation.images.left_wrist",
  url: "/shared.mp4",
  isSegmented: true,
  segmentStart: 100,
  segmentEnd: 110,
};

describe("episode time ↔ media time", () => {
  test("maps episode-local time into a segmented MP4 and clamps its end", () => {
    expect(mediaTimeFromEpisodeTime(segmented, 2.5)).toBe(102.5);
    expect(mediaTimeFromEpisodeTime(segmented, -1)).toBe(100);
    expect(mediaTimeFromEpisodeTime(segmented, 12)).toBeCloseTo(109.999, 6);
    expect(mediaTimeFromEpisodeTime(wholeFile, 2.5)).toBe(2.5);
  });

  test("maps the media clock back to episode-local time", () => {
    expect(episodeTimeFromMediaTime(segmented, 102.5)).toBe(2.5);
    expect(episodeTimeFromMediaTime(wholeFile, 2.5)).toBe(2.5);
  });

  test("never reports a negative episode time", () => {
    // The state a fresh <video> is in until the seek to segmentStart lands.
    expect(episodeTimeFromMediaTime(segmented, 0)).toBe(0);
    // A seek that undershoots the segment by a keyframe.
    expect(episodeTimeFromMediaTime(segmented, 99.96)).toBe(0);
    expect(episodeTimeFromMediaTime(wholeFile, -0.5)).toBe(0);
    expect(episodeTimeFromMediaTime(segmented, NaN)).toBe(0);
  });

  test("never reports past the end of the segment", () => {
    expect(episodeTimeFromMediaTime(segmented, 140)).toBe(10);
    expect(episodeTimeFromMediaTime(wholeFile, 140)).toBe(140);
  });

  test("round-trips a time inside the segment", () => {
    const media = mediaTimeFromEpisodeTime(segmented, 4.25);
    expect(episodeTimeFromMediaTime(segmented, media)).toBeCloseTo(4.25, 6);
  });
});

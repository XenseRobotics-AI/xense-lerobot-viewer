import { describe, expect, test } from "bun:test";
import type { VideoInfo } from "@/types";
import { getVideosToPrewarm, videoFramePosterKey } from "../videoFramePrefetch";

describe("video frame prefetch policy", () => {
  test("prewarms every camera, including tactile streams", () => {
    const videos: VideoInfo[] = [
      { filename: "observation.images.head", url: "/head.mp4" },
      { filename: "observation.images.left_wrist", url: "/left.mp4" },
      { filename: "observation.images.right_wrist", url: "/right.mp4" },
      { filename: "observation.images.tactile_left", url: "/touch.mp4" },
    ];
    expect(getVideosToPrewarm(videos)).toEqual(videos);
  });

  test("poster identity changes with dataset, episode, source and target time", () => {
    const video = { filename: "left_wrist", url: "/left.mp4" };
    const key = videoFramePosterKey("dataset:3", video, 0);
    expect(videoFramePosterKey("dataset:4", video, 0)).not.toBe(key);
    expect(videoFramePosterKey("other:3", video, 0)).not.toBe(key);
    expect(
      videoFramePosterKey("dataset:3", { ...video, url: "/other.mp4" }, 0),
    ).not.toBe(key);
    expect(videoFramePosterKey("dataset:3", video, 0.2)).not.toBe(key);
  });
});

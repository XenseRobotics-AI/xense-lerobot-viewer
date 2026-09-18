import { describe, expect, test } from "bun:test";
import type { VideoInfo } from "@/types";
import {
  classifyUrdfReplayVideo,
  groupUrdfReplayVideos,
} from "@/utils/urdfReplayVideos";

const video = (filename: string): VideoInfo => ({
  filename,
  url: `/${filename}.mp4`,
});

describe("3D Replay video layout", () => {
  test("prioritizes head, then uses the first left/right word", () => {
    expect(classifyUrdfReplayVideo("observation.images.head")).toBe("center");
    expect(classifyUrdfReplayVideo("camera/head-left")).toBe("center");
    expect(classifyUrdfReplayVideo("observation.images.left_head")).toBe(
      "center",
    );
    expect(
      classifyUrdfReplayVideo("observation.images.left_tactile_right"),
    ).toBe("left");
    expect(
      classifyUrdfReplayVideo("observation.images.right_tactile_left"),
    ).toBe("right");
    // No side word at all: shown top-center, never dropped. The RDT rig's
    // third-person `side` camera is the only view of its scene.
    expect(classifyUrdfReplayVideo("observation.images.top")).toBe("center");
    expect(classifyUrdfReplayVideo("observation.images.side")).toBe("center");
  });

  test("groups cameras by side and keeps the physical display order", () => {
    const groups = groupUrdfReplayVideos([
      video("observation.images.right_tactile_right"),
      video("observation.images.head_right"),
      video("observation.images.left_wrist"),
      video("observation.images.left_tactile_right"),
      video("observation.images.right_wrist"),
      video("observation.images.head_left"),
      video("observation.images.right_tactile_left"),
      video("observation.images.left_tactile_left"),
    ]);

    expect(groups.left.map(({ filename }) => filename)).toEqual([
      "observation.images.left_wrist",
      "observation.images.left_tactile_left",
      "observation.images.left_tactile_right",
    ]);
    expect(groups.center.map(({ filename }) => filename)).toEqual([
      "observation.images.head_left",
      "observation.images.head_right",
    ]);
    expect(groups.right.map(({ filename }) => filename)).toEqual([
      "observation.images.right_wrist",
      "observation.images.right_tactile_left",
      "observation.images.right_tactile_right",
    ]);
  });

  test("keeps a third-person camera the RDT rig names `side`", () => {
    // Its seven cameras carry no `head`; `side` watches the bench and used to
    // fall through the left/right/head match, so the 3D tab showed six.
    const groups = groupUrdfReplayVideos([
      video("observation.images.side"),
      video("observation.images.left_wrist"),
      video("observation.images.right_wrist"),
      video("observation.images.left_tactile_left"),
      video("observation.images.left_tactile_right"),
      video("observation.images.right_tactile_left"),
      video("observation.images.right_tactile_right"),
    ]);
    expect(groups.center.map(({ filename }) => filename)).toEqual([
      "observation.images.side",
    ]);
    expect(groups.left).toHaveLength(3);
    expect(groups.right).toHaveLength(3);
    const shown =
      groups.left.length + groups.center.length + groups.right.length;
    expect(shown).toBe(7);
  });

  test("centers a dataset's single head camera", () => {
    const groups = groupUrdfReplayVideos([
      video("observation.images.left"),
      video("observation.images.head"),
      video("observation.images.right"),
    ]);

    expect(groups.left[0]?.filename).toBe("observation.images.left");
    expect(groups.center.map(({ filename }) => filename)).toEqual([
      "observation.images.head",
    ]);
    expect(groups.right[0]?.filename).toBe("observation.images.right");
  });

  test("orders both head_left and left_head naming conventions by side", () => {
    const groups = groupUrdfReplayVideos([
      video("observation.images.right_head"),
      video("observation.images.left_head"),
    ]);

    expect(groups.center.map(({ filename }) => filename)).toEqual([
      "observation.images.left_head",
      "observation.images.right_head",
    ]);
  });
});

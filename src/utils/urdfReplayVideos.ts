import type { VideoInfo } from "@/types";

export type UrdfReplayVideoRegion = "center" | "left" | "right";

export type UrdfReplayVideoGroups = Record<UrdfReplayVideoRegion, VideoInfo[]>;

function videoNameTokens(filename: string): string[] {
  return filename
    .trim()
    .toLowerCase()
    .split(/[./_-]+/)
    .filter(Boolean);
}

/**
 * Place cameras by the semantic direction words in their feature key.
 * `head` deliberately wins over `left`/`right`: head_left and left_head are
 * both head cameras and belong in the top-center group. For non-head cameras,
 * the first side word wins, so left_tactile_right remains a left-hand camera.
 */
export function classifyUrdfReplayVideo(
  filename: string,
): UrdfReplayVideoRegion | null {
  const tokens = videoNameTokens(filename);
  if (tokens.includes("head")) return "center";

  const firstSide = tokens.find(
    (token): token is "left" | "right" => token === "left" || token === "right",
  );
  return firstSide ?? null;
}

/**
 * Multiple head cameras sit left-to-right by their own side word, so
 * `head_left` lands left of a plain `head` and `head_right` to its right.
 */
function centerOrder(filename: string): number {
  const side = videoNameTokens(filename).find(
    (token): token is "left" | "right" => token === "left" || token === "right",
  );
  if (side === "left") return 0;
  if (side === "right") return 2;
  return 1;
}

function sideOrder(filename: string): number {
  const tokens = videoNameTokens(filename);
  if (tokens.includes("wrist")) return 0;
  const tactileIndex = tokens.indexOf("tactile");
  if (tactileIndex < 0) return 1;

  const sensorPosition = tokens
    .slice(tactileIndex + 1)
    .find((token) => ["left", "right", "0", "1"].includes(token));
  if (sensorPosition === "left" || sensorPosition === "0") return 10;
  if (sensorPosition === "right" || sensorPosition === "1") return 11;
  return 12;
}

function stableSort(
  videos: Array<{ index: number; video: VideoInfo }>,
  order: (filename: string) => number,
): VideoInfo[] {
  return videos
    .sort(
      (a, b) =>
        order(a.video.filename) - order(b.video.filename) || a.index - b.index,
    )
    .map(({ video }) => video);
}

/** Arrange recognized cameras into left, top-center, and right overlays. */
export function groupUrdfReplayVideos(
  videos: VideoInfo[],
): UrdfReplayVideoGroups {
  const indexed = videos.map((video, index) => ({ index, video }));
  const inRegion = (region: UrdfReplayVideoRegion) =>
    indexed.filter(
      ({ video }) => classifyUrdfReplayVideo(video.filename) === region,
    );

  return {
    center: stableSort(inRegion("center"), centerOrder),
    left: stableSort(inRegion("left"), sideOrder),
    right: stableSort(inRegion("right"), sideOrder),
  };
}

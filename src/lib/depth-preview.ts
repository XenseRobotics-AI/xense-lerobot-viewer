/**
 * Browser-playable previews of depth-map video streams.
 *
 * A LeRobot depth stream (`video.is_depth_map`) is typically high-bit-depth
 * monochrome — TacFlow writes 12-bit lossless HEVC (`gray12le`) — which no
 * browser decodes. The player would show a dead tile. So for those streams the
 * file route serves a preview instead: the same frames, one-to-one, rescaled to
 * the stream's own range and false-coloured, as ordinary H.264.
 *
 * The preview is a cache, never part of the dataset: it lives under the OS temp
 * directory, keyed by the source file's path, size and mtime, so a re-derived
 * dataset gets a fresh one. It is for looking at; the values are in the source.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Levels of a 12-bit stream; the fallback when the source bit depth is unknown. */
const DEFAULT_LEVELS = 4095;
/** Never stretch less than this many levels to full scale — keeps sensor noise from filling the palette. */
const MIN_RANGE_LEVELS = 16;

const inFlight = new Map<string, Promise<string>>();

export function depthPreviewCacheDir(): string {
  return (
    process.env.XENSE_VIEWER_PREVIEW_DIR ??
    path.join(os.tmpdir(), "xense-viewer-depth-preview")
  );
}

/**
 * The level that should map to full scale: the dataset's recorded maximum for
 * this stream (`meta/stats.json`, normalised to [0, 1] like image stats), or
 * the whole range when there is none.
 */
export async function depthRangeLevels(
  datasetRoot: string,
  videoKey: string,
  levels: number = DEFAULT_LEVELS,
): Promise<number> {
  try {
    const stats = JSON.parse(
      await fs.readFile(path.join(datasetRoot, "meta", "stats.json"), "utf8"),
    ) as Record<string, { max?: unknown }>;
    const max = Number([stats[videoKey]?.max].flat(4)[0]);
    if (Number.isFinite(max) && max > 0) {
      return Math.min(
        levels,
        Math.max(MIN_RANGE_LEVELS, Math.ceil(max * levels)),
      );
    }
  } catch {
    // no stats, unreadable stats: fall through to the full range
  }
  return levels;
}

/**
 * ffmpeg filter: stretch [0, range] to full scale on a square-root curve — a stream's maximum is usually one
 * hard press, and a linear stretch to it leaves ordinary contact a few levels above zero — then a jet-like palette
 * built from `lutrgb` (the `pseudocolor` presets need ffmpeg >= 5).
 */
export function depthPreviewFilter(
  range: number,
  levels: number = DEFAULT_LEVELS,
): string {
  const channel = (centre: number) =>
    `'255*clip(1.5-abs(4*val/255-${centre}),0,1)'`;
  return [
    `lut=y='${levels}*sqrt(min(val/${range},1))'`,
    "format=rgb24",
    `lutrgb=r=${channel(3)}:g=${channel(2)}:b=${channel(1)}`,
  ].join(",");
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Path of the preview for one depth mp4, transcoding it first if the cache has
 * none. Concurrent requests for the same file share one transcode.
 */
export async function ensureDepthPreview(source: {
  absolutePath: string;
  size: number;
  mtimeMs: number;
  datasetRoot: string;
  videoKey: string;
}): Promise<string> {
  const range = await depthRangeLevels(source.datasetRoot, source.videoKey);
  const key = createHash("sha1")
    .update(
      [source.absolutePath, source.size, source.mtimeMs, range, "v2"].join("|"),
    )
    .digest("hex");
  const target = path.join(depthPreviewCacheDir(), `${key}.mp4`);

  try {
    await fs.access(target);
    return target;
  } catch {
    // not cached yet
  }

  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.${process.pid}.partial.mp4`;
      try {
        // GOP of 30 so seeking inside a long shared file stays cheap
        await run(process.env.FFMPEG_PATH ?? "ffmpeg", [
          "-y",
          "-v",
          "error",
          "-i",
          source.absolutePath,
          "-vf",
          depthPreviewFilter(range),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "30",
          "-an",
          "-movflags",
          "+faststart",
          partial,
        ]);
        await fs.rename(partial, target);
      } catch (error) {
        await fs.rm(partial, { force: true });
        throw error;
      }
      return target;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

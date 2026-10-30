/**
 * Which coordinate frame an episode's `observation.state` poses are in.
 *
 * Collector (0.4.6-rc.2+) writes an `export` block per episode into
 * `meta/xumi_collection_devices.json`. With `world_frame:
 * "head_yaw_at_episode_start"` the exporter has re-expressed every pose so the
 * episode starts with the head at (0, 0, 0) facing +X, Z up — the dataset
 * origin *is* the episode origin. `world_anchor` is that origin in the recorded
 * Pico world, kept so the two frames can be converted.
 *
 * Older exports (no block, or `world_frame: "recorded"`) keep the recorded Pico
 * world, whose (0, 0, 0) is wherever the headset last recentred — not a
 * meaningful episode origin. The viewer still marks dataset (0, 0, 0) for those,
 * but labels it as the recorded origin.
 *
 * Same failure policy as `meta/sources.json`: an absent or unreadable file
 * means "unknown frame", never a broken episode.
 */

import { getLocalDatasetFileBase } from "@/utils/datasetRoute";

export const WORLD_FRAME_HEAD_START = "head_yaw_at_episode_start";

export type EpisodeWorldFrameKind = "head-start" | "recorded" | "unknown";

export interface EpisodeWorldAnchor {
  /** Episode origin in the recorded Pico world, metres. */
  position: [number, number, number];
  yawDeg: number;
}

export interface EpisodeWorldFrame {
  kind: EpisodeWorldFrameKind;
  anchor: EpisodeWorldAnchor | null;
}

const UNKNOWN: EpisodeWorldFrame = { kind: "unknown", anchor: null };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseAnchor(value: unknown): EpisodeWorldAnchor | null {
  if (!value || typeof value !== "object") return null;
  const { position, yaw_deg: yaw } = value as {
    position?: unknown;
    yaw_deg?: unknown;
  };
  if (!Array.isArray(position) || position.length !== 3) return null;
  const xyz = position.map(finiteNumber);
  const yawDeg = finiteNumber(yaw);
  if (xyz.some((v) => v === null) || yawDeg === null) return null;
  return { position: xyz as [number, number, number], yawDeg };
}

type ExportBlock = { world_frame?: unknown; world_anchor?: unknown };

/**
 * The episode's export block. v1 inlines it; v2 (Collector 0.4.6-rc.2+) stores the
 * shared part once under `exports[id]` and keeps per-episode fields such as
 * `world_anchor` inline on the episode, so merge the two.
 */
function resolveExport(
  devices: unknown,
  entry: { export?: unknown; world_anchor?: unknown } | undefined,
): ExportBlock | null {
  const ref = entry?.export;
  if (typeof ref === "string") {
    const shared = (devices as { exports?: Record<string, unknown> } | null)
      ?.exports?.[ref];
    if (!shared || typeof shared !== "object") return null;
    return { ...(shared as ExportBlock), world_anchor: entry?.world_anchor };
  }
  return ref && typeof ref === "object" ? (ref as ExportBlock) : null;
}

/** Read one episode's frame from a parsed `xumi_collection_devices.json`. */
export function readEpisodeWorldFrame(
  devices: unknown,
  episodeIndex: number,
): EpisodeWorldFrame {
  const episodes = (devices as { episodes?: unknown } | null)?.episodes;
  if (!Array.isArray(episodes)) return UNKNOWN;
  const entry = episodes.find(
    (candidate) =>
      !!candidate &&
      typeof candidate === "object" &&
      (candidate as { episode_index?: unknown }).episode_index === episodeIndex,
  ) as { export?: unknown; world_anchor?: unknown } | undefined;
  const exported = resolveExport(devices, entry);
  if (!exported) return UNKNOWN;
  if (exported.world_frame === WORLD_FRAME_HEAD_START) {
    return { kind: "head-start", anchor: parseAnchor(exported.world_anchor) };
  }
  if (exported.world_frame === "recorded") {
    return { kind: "recorded", anchor: null };
  }
  return UNKNOWN;
}

const cache = new Map<string, Promise<unknown | null>>();

/** `meta/xumi_collection_devices.json`, once per dataset; null when absent. */
export function fetchCollectionDevices(
  repoId: string,
): Promise<unknown | null> {
  const cached = cache.get(repoId);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const response = await fetch(
        `${getLocalDatasetFileBase(repoId)}/meta/xumi_collection_devices.json`,
      );
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  })();
  cache.set(repoId, pending);
  return pending;
}

/**
 * Client for `meta/sources.json`, the converter's per-episode provenance file.
 *
 * Served by the ordinary per-dataset file route, so there is no API of its own.
 * The viewer reads it for one thing today — the gripper calibration windows in
 * `@/utils/gripperCalibration` — and datasets converted before that block
 * existed simply do not have it, which is why every failure here resolves to
 * null rather than throwing: an absent or unreadable file means "no extra
 * metadata", never a broken episode.
 *
 * One request per dataset, cached in-flight and after, because the file is
 * dataset-wide while the viewer asks per episode.
 */

import { getLocalDatasetFileBase } from "@/utils/datasetRoute";

const cache = new Map<string, Promise<unknown | null>>();

export function fetchDatasetSources(repoId: string): Promise<unknown | null> {
  const cached = cache.get(repoId);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const response = await fetch(
        `${getLocalDatasetFileBase(repoId)}/meta/sources.json`,
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

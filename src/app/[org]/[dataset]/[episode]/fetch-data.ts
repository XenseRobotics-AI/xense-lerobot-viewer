// Public facade: foreground reads stay direct; speculative decodes use one worker.
export * from "./fetch-data-core";
export { warmEpisodeDecoder } from "@/utils/episodeDecoder";
import {
  getEpisodeData,
  getEpisodeList,
  type EpisodeData,
} from "./fetch-data-core";
import { pruneParquetCache } from "@/utils/parquetUtils";
import { EPISODE_CACHE_POLICY } from "@/utils/episodeCachePolicy";
import {
  EpisodeDataCache,
  estimateEpisodeBytes,
} from "@/utils/episodeDataCache";
import { decodeEpisode, canUseBackgroundDecoder } from "@/utils/episodeDecoder";

// Episode switches used to be route transitions, so every visit naturally
// threw away the parsed episode object. The in-page selector introduced by
// PR #19 keeps the viewer mounted; retain a small LRU here as well so going
// back to a recently viewed episode is synchronous and overlapping switches
// share one request. The cache is deliberately bounded because chart rows and
// frame timestamps are kept in the object passed to the client UI.
//
// Two properties callers must know about:
//
//   - **There is no invalidation.** Unlike the Node-side handle cache in
//     `src/lib/parquet-server.ts`, which re-keys on `mtime + size`, this one
//     evicts by capacity and idle distance/age. A dataset rewritten underneath the tab — running
//     `scripts/export_subtasks.py`, or an HF sync — keeps serving the parsed
//     copy until it is evicted. This module runs in the browser, so a page
//     reload is always the escape hatch; that is the trade being made.
//   - **Entries are shared, so treat an `EpisodeData` as read-only.** Two
//     visits to the same episode now receive the identical object (which is
//     also why `extractEpisodePoseTrajectories`' per-rows-array memoisation
//     starts hitting across a revisit). Mutating one in place — sorting a
//     chart row array, say — corrupts every later reader.
const configuredEntries = Number.parseInt(
  process.env.MAX_EPISODE_DATA_CACHE_ENTRIES ?? "",
  10,
);
const MAX_EPISODE_DATA_CACHE_ENTRIES =
  Number.isFinite(configuredEntries) && configuredEntries >= 1
    ? configuredEntries
    : 8;
const episodeDataCache = new EpisodeDataCache<EpisodeData>({
  recentEntries: MAX_EPISODE_DATA_CACHE_ENTRIES,
  recentBytes: EPISODE_CACHE_POLICY.recentBytes,
  prefetchEntries: 24,
  prefetchBytes: EPISODE_CACHE_POLICY.prefetchBytes,
  estimate: estimateEpisodeBytes,
  distance: (key, current) => {
    const a = key.split("\u0000");
    const b = current.split("\u0000");
    return a[0] === b[0] && a[1] === b[1]
      ? Math.abs(Number(a[2]) - Number(b[2]))
      : Infinity;
  },
});
let inactiveCacheTimers: ReturnType<typeof setTimeout>[] = [];

function episodeDataCacheKey(
  org: string,
  dataset: string,
  episodeId: number,
): string {
  return `${org}\u0000${dataset}\u0000${episodeId}`;
}

export function setEpisodePrefetchTargets(
  org: string,
  dataset: string,
  ids: number[],
  current: number,
): () => void {
  inactiveCacheTimers.forEach(clearTimeout);
  inactiveCacheTimers = [];
  const release = episodeDataCache.setTargets(
    ids.map((id) => episodeDataCacheKey(org, dataset, id)),
    episodeDataCacheKey(org, dataset, current),
  );
  return () => {
    // React installs the new target lease before releasing its predecessor.
    queueMicrotask(() => {
      if (release())
        inactiveCacheTimers = [
          EPISODE_CACHE_POLICY.farTtlMs + 1_000,
          EPISODE_CACHE_POLICY.parquetIdleTtlMs + 1_000,
        ].map((delay) => setTimeout(pruneEpisodeDataCache, delay));
    });
  };
}

export function pruneEpisodeDataCache(): void {
  episodeDataCache.prune();
  pruneParquetCache();
}

export function canPrefetchEpisode(
  org: string,
  dataset: string,
  id: number,
): boolean {
  return (
    canUseBackgroundDecoder() &&
    !episodeDataCache.backgroundBusy &&
    episodeDataCache.canPrefetch(episodeDataCacheKey(org, dataset, id))
  );
}

export function episodePrefetchBusy(): boolean {
  return episodeDataCache.backgroundBusy;
}

export function prefetchEpisodeDataSafe(
  org: string,
  dataset: string,
  id: number,
) {
  return episodeDataCache.prefetch(episodeDataCacheKey(org, dataset, id), () =>
    loadDecodedEpisode(org, dataset, id, "background"),
  );
}

async function loadDecodedEpisode(
  org: string,
  dataset: string,
  episodeId: number,
  priority: "foreground" | "background",
): Promise<EpisodeData> {
  const [data, list] = await Promise.all([
    decodeEpisode({ org, dataset, episodeId }, priority, () =>
      getEpisodeData(org, dataset, episodeId),
    ),
    getEpisodeList(org, dataset),
  ]);
  // One shared index array, including after the worker structured-clone boundary.
  data.episodes = list.episodes;
  return data;
}

// Safe wrapper for UI error display
export async function getEpisodeDataSafe(
  org: string,
  dataset: string,
  episodeId: number,
): Promise<{ data?: EpisodeData; error?: string }> {
  return episodeDataCache.get(
    episodeDataCacheKey(org, dataset, episodeId),
    () => loadDecodedEpisode(org, dataset, episodeId, "foreground"),
  );
}

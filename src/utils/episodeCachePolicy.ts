/** Retention reduces repeat decoding; count/byte budgets still bound occupancy. */
export const EPISODE_CACHE_POLICY = {
  // Per browser tab, across datasets. These are ceilings, not allocations.
  recentBytes: 192 * 1024 * 1024,
  prefetchBytes: 128 * 1024 * 1024,
  parquetBytes: 128 * 1024 * 1024,
  nearTtlMs: 10 * 60_000,
  midTtlMs: 4 * 60_000,
  farTtlMs: 60_000,
  pruneIntervalMs: 30_000,
  parquetIdleTtlMs: 10 * 60_000,
} as const;

/** Retention reduces repeat decoding; count/byte budgets still bound occupancy. */
export const EPISODE_CACHE_POLICY = {
  nearTtlMs: 5 * 60_000,
  midTtlMs: 2 * 60_000,
  farTtlMs: 30_000,
  pruneIntervalMs: 30_000,
  parquetIdleTtlMs: 5 * 60_000,
} as const;

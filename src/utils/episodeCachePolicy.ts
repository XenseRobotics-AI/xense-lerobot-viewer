/** Retention reduces repeat decoding; count/byte budgets still bound occupancy. */
export const EPISODE_CACHE_POLICY = {
  nearTtlMs: 10 * 60_000,
  midTtlMs: 4 * 60_000,
  farTtlMs: 60_000,
  pruneIntervalMs: 30_000,
  parquetIdleTtlMs: 10 * 60_000,
} as const;

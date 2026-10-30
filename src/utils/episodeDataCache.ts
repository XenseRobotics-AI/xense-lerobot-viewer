import { touchLru } from "./lruCache";
import { EPISODE_CACHE_POLICY } from "./episodeCachePolicy";

export type EpisodeLoadResult<T> = { data?: T; error?: string };
type Pending<T> = {
  foreground: boolean;
  result: Promise<EpisodeLoadResult<T>>;
  foregroundResult?: Promise<EpisodeLoadResult<T>>;
};

/** One background load; foreground reads bypass it or join the exact same key. */
export class EpisodeDataCache<T> {
  private recent = new Map<
    string,
    { data: T; bytes: number; touched: number }
  >();
  private prefetched = new Map<
    string,
    { data: T; bytes: number; touched: number }
  >();
  private pending = new Map<string, Pending<T>>();
  private targets = new Set<string>();
  private attempted = new Set<string>();
  private prefetchBytes = 0;
  private foregroundLoads = 0;
  private backgroundLoads = 0;
  private targetGeneration = 0;
  private currentKey: string | undefined;

  constructor(
    private options: {
      recentEntries: number;
      prefetchEntries: number;
      prefetchBytes: number;
      estimate: (data: T) => number;
      recentBytes?: number;
      distance?: (key: string, current: string) => number;
      now?: () => number;
    },
  ) {}

  setTargets(keys: string[], currentKey?: string): () => boolean {
    const next = new Set(keys);
    const changed =
      next.size !== this.targets.size ||
      [...next].some((key) => !this.targets.has(key));
    const generation = ++this.targetGeneration;
    for (const key of this.targets) {
      const entry = this.prefetched.get(key) ?? this.recent.get(key);
      if (entry) entry.touched = this.now();
    }
    this.targets = next;
    this.currentKey = currentKey;
    if (changed) this.attempted.clear();
    this.prune();
    return () => {
      if (this.targetGeneration !== generation) return false;
      this.targetGeneration++;
      this.targets.clear();
      this.attempted.clear();
      this.currentKey = undefined;
      this.prune();
      return true;
    };
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private distance(key: string) {
    return this.currentKey
      ? (this.options.distance?.(key, this.currentKey) ?? Infinity)
      : Infinity;
  }
  /** Visible/active data is protected; distant offscreen data expires first. */
  prune() {
    const now = this.now();
    for (const cache of [this.prefetched, this.recent]) {
      for (const [key, entry] of cache) {
        if (key === this.currentKey || this.targets.has(key)) continue;
        const distance = this.distance(key);
        const ttl =
          distance <= 2
            ? EPISODE_CACHE_POLICY.nearTtlMs
            : distance <= 12
              ? EPISODE_CACHE_POLICY.midTtlMs
              : EPISODE_CACHE_POLICY.farTtlMs;
        if (now - entry.touched >= ttl) {
          cache.delete(key);
          if (cache === this.prefetched) this.prefetchBytes -= entry.bytes;
        }
      }
    }
  }

  private makeRoom(bytes: number) {
    const removable = [...this.prefetched.entries()]
      .filter(([key]) => !this.targets.has(key) && key !== this.currentKey)
      .sort(
        ([a, av], [b, bv]) =>
          this.distance(b) - this.distance(a) || av.touched - bv.touched,
      );
    while (
      removable.length &&
      (this.prefetched.size >= this.options.prefetchEntries ||
        this.prefetchBytes + bytes > this.options.prefetchBytes)
    ) {
      const [key, entry] = removable.shift()!;
      this.prefetched.delete(key);
      this.prefetchBytes -= entry.bytes;
    }
  }

  private rememberRecent(key: string, data: T) {
    const bytes = this.options.estimate(data);
    this.recent.delete(key);
    this.recent.set(key, { data, bytes, touched: this.now() });
    let total = [...this.recent.values()].reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    const removable = [...this.recent.entries()]
      .filter(([id]) => id !== this.currentKey)
      .sort(
        ([a, av], [b, bv]) =>
          this.distance(b) - this.distance(a) || av.touched - bv.touched,
      );
    while (
      (this.recent.size > this.options.recentEntries ||
        total > (this.options.recentBytes ?? Infinity)) &&
      removable.length
    ) {
      const [id, entry] = removable.shift()!;
      this.recent.delete(id);
      total -= entry.bytes;
    }
  }

  canPrefetch(key: string): boolean {
    this.prune();
    if (
      !this.targets.has(key) ||
      this.recent.has(key) ||
      this.prefetched.has(key) ||
      this.pending.has(key) ||
      this.attempted.has(key)
    )
      return false;
    this.makeRoom(0);
    return (
      this.prefetched.size < this.options.prefetchEntries &&
      this.prefetchBytes < this.options.prefetchBytes
    );
  }

  get stats() {
    return {
      recentEntries: this.recent.size,
      recentBytes: [...this.recent.values()].reduce((n, v) => n + v.bytes, 0),
      prefetchEntries: this.prefetched.size,
      prefetchBytes: this.prefetchBytes,
      pending: this.pending.size,
    };
  }

  get backgroundBusy(): boolean {
    return this.backgroundLoads > 0 || this.foregroundLoads > 0;
  }

  get(key: string, load: () => Promise<T>): Promise<EpisodeLoadResult<T>> {
    this.currentKey = key;
    this.prune();
    const cached = touchLru(this.recent, key);
    if (cached !== undefined) {
      cached.touched = this.now();
      return Promise.resolve({ data: cached.data });
    }
    const warmed = this.prefetched.get(key);
    if (warmed) {
      this.prefetched.delete(key);
      this.prefetchBytes -= warmed.bytes;
      this.rememberRecent(key, warmed.data);
      return Promise.resolve({ data: warmed.data });
    }
    const pending = this.pending.get(key);
    if (pending) {
      if (!pending.foreground) {
        pending.foreground = true;
        this.foregroundLoads++;
        // A selected preload can fail due to worker limits or availability.
        // Retry once on the foreground path; concurrent selectors share it.
        pending.foregroundResult = pending.result.then((result) => {
          if (result.error === undefined) return result;
          const replacement = this.pending.get(key);
          return replacement?.result ?? this.start(key, load, true);
        });
      }
      return pending.foregroundResult ?? pending.result;
    }
    return this.start(key, load, true);
  }

  prefetch(key: string, load: () => Promise<T>): Promise<EpisodeLoadResult<T>> {
    if (this.backgroundBusy || !this.canPrefetch(key))
      return Promise.resolve({});
    this.attempted.add(key);
    return this.start(key, load, false);
  }

  private start(key: string, load: () => Promise<T>, foreground: boolean) {
    const job: Pending<T> = { foreground, result: Promise.resolve({}) };
    if (foreground) this.foregroundLoads++;
    else this.backgroundLoads++;
    // Register before invoking load, including when it throws synchronously.
    this.pending.set(key, job);
    job.result = Promise.resolve()
      .then(load)
      .then((data) => {
        if (job.foreground) this.rememberRecent(key, data);
        else if (this.targets.has(key)) {
          const bytes = this.options.estimate(data);
          if (
            !Number.isFinite(bytes) ||
            bytes < 0 ||
            bytes > this.options.prefetchBytes
          )
            return { data };
          this.makeRoom(bytes);
          if (
            Number.isFinite(bytes) &&
            bytes >= 0 &&
            this.prefetched.size < this.options.prefetchEntries &&
            this.prefetchBytes + bytes <= this.options.prefetchBytes
          ) {
            this.prefetched.set(key, { data, bytes, touched: this.now() });
            this.prefetchBytes += bytes;
          }
        }
        return { data };
      })
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        if (this.pending.get(key) === job) this.pending.delete(key);
        if (job.foreground) this.foregroundLoads--;
        if (!foreground) this.backgroundLoads--;
      });
    return job.result;
  }
}

/** Conservative sampled estimate; avoids serializing whole chart/pose objects. */
export function estimateEpisodeBytes(data: {
  flatChartData: unknown[];
  chartDataGroups: unknown[][];
  velocityChartDataGroups: unknown[][];
  frameTimestamps?: number[];
  languageAtoms?: unknown[];
  task?: string;
}): number {
  const arrays = new Set([
    data.flatChartData,
    ...data.chartDataGroups,
    ...data.velocityChartDataGroups,
  ]);
  const size = (value: unknown, depth = 0): number => {
    if (typeof value === "string") return 32 + value.length * 2;
    if (!value || typeof value !== "object") return 16;
    if (depth >= 3) return 256;
    if (Array.isArray(value))
      return 32 + value.reduce((sum, item) => sum + size(item, depth + 1), 0);
    return (
      64 +
      Object.entries(value).reduce(
        (sum, [key, item]) => sum + 32 + key.length * 2 + size(item, depth + 1),
        0,
      )
    );
  };
  let bytes = 64 * 1024 + (data.frameTimestamps?.length ?? 0) * 16;
  bytes += size(data.task);
  if (data.languageAtoms) arrays.add(data.languageAtoms);
  for (const rows of arrays) {
    if (!rows.length) continue;
    const samples = [
      rows[0],
      rows[Math.floor(rows.length / 2)],
      rows[rows.length - 1],
    ];
    bytes += (Math.max(...samples.map((row) => size(row))) + 16) * rows.length;
  }
  return bytes;
}

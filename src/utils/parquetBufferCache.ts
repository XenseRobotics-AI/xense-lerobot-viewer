import type { AsyncBuffer } from "hyparquet";
import { EPISODE_CACHE_POLICY } from "./episodeCachePolicy";

/** Limits retained bytes across every open file; active readers own their results. */
export class ParquetBufferCache {
  private files = new Map<
    string,
    { id: number; file: AsyncBuffer; touched: number }
  >();
  private opening = new Map<string, Promise<AsyncBuffer>>();
  private ranges = new Map<
    string,
    { id: number; data: ArrayBuffer; touched: number }
  >();
  private pending = new Map<string, Promise<ArrayBuffer>>();
  private bytes = 0;
  private sequence = 0;

  constructor(
    private options: {
      open: (url: string) => Promise<AsyncBuffer>;
      maxFiles?: number;
      maxBytes?: number;
      maxRanges?: number;
      ttl?: number;
      now?: () => number;
      smallFileBytes?: number;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get stats() {
    return {
      files: this.files.size,
      ranges: this.ranges.size,
      bytes: this.bytes,
      pending: this.pending.size,
    };
  }

  private removeRange(key: string) {
    const entry = this.ranges.get(key);
    if (entry) {
      this.bytes -= entry.data.byteLength;
      this.ranges.delete(key);
    }
  }
  private removeFile(url: string, id: number) {
    this.files.delete(url);
    for (const [key, entry] of this.ranges)
      if (entry.id === id) this.removeRange(key);
  }

  prune() {
    const threshold =
      this.now() - (this.options.ttl ?? EPISODE_CACHE_POLICY.parquetIdleTtlMs);
    for (const [url, entry] of this.files)
      if (entry.touched <= threshold) this.removeFile(url, entry.id);
    for (const [key, entry] of this.ranges)
      if (entry.touched <= threshold) this.removeRange(key);
  }

  async get(url: string): Promise<AsyncBuffer> {
    this.prune();
    const cached = this.files.get(url);
    if (cached) {
      cached.touched = this.now();
      this.files.delete(url);
      this.files.set(url, cached);
      return cached.file;
    }
    const pending = this.opening.get(url);
    if (pending) return pending;
    const result = Promise.resolve()
      .then(() => this.options.open(url))
      .then((source) => {
        const id = ++this.sequence;
        const file: AsyncBuffer = {
          byteLength: source.byteLength,
          slice: async (start, end) => {
            if (
              !Number.isSafeInteger(start) ||
              (end !== undefined && !Number.isSafeInteger(end))
            )
              throw new Error("Invalid parquet byte range");
            if (start < 0 && end !== undefined)
              throw new Error("Invalid parquet suffix range");
            const from =
              start < 0
                ? Math.max(0, source.byteLength + start)
                : Math.min(start, source.byteLength);
            const to = Math.min(end ?? source.byteLength, source.byteLength);
            if (from > to || from < 0 || to < 0)
              throw new Error("Invalid parquet byte range");
            if (from === to) return new ArrayBuffer(0);
            const small =
              source.byteLength <= (this.options.smallFileBytes ?? 512 * 1024);
            const data = await this.read(
              url,
              id,
              source,
              small ? 0 : from,
              small ? source.byteLength : to,
            );
            return small && (from !== 0 || to !== source.byteLength)
              ? data.slice(from, to)
              : data;
          },
        };
        this.files.set(url, { id, file, touched: this.now() });
        while (this.files.size > (this.options.maxFiles ?? 16)) {
          const oldest = this.files.entries().next().value!;
          this.removeFile(oldest[0], oldest[1].id);
        }
        return file;
      })
      .finally(() => {
        if (this.opening.get(url) === result) this.opening.delete(url);
      });
    this.opening.set(url, result);
    return result;
  }

  private read(
    url: string,
    id: number,
    source: AsyncBuffer,
    from: number,
    to: number,
  ): Promise<ArrayBuffer> {
    this.prune();
    const handle = this.files.get(url);
    if (handle?.id === id) {
      handle.touched = this.now();
      this.files.delete(url);
      this.files.set(url, handle);
    }
    const key = id + ":" + from + ":" + to;
    const cached = this.ranges.get(key);
    if (cached) {
      cached.touched = this.now();
      this.ranges.delete(key);
      this.ranges.set(key, cached);
      return Promise.resolve(cached.data);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const result = Promise.resolve()
      .then(() => source.slice(from, to))
      .then((data) => {
        const limit =
          this.options.maxBytes ?? EPISODE_CACHE_POLICY.parquetBytes;
        if (data.byteLength <= limit && this.files.get(url)?.id === id) {
          while (
            this.ranges.size &&
            (this.bytes + data.byteLength > limit ||
              this.ranges.size >= (this.options.maxRanges ?? 512))
          )
            this.removeRange(this.ranges.keys().next().value!);
          this.ranges.set(key, { id, data, touched: this.now() });
          this.bytes += data.byteLength;
        }
        return data;
      })
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      });
    this.pending.set(key, result);
    return result;
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { reviewTimestamp } from "@/utils/reviewTime";
import {
  REVIEW_BUILD,
  type ReviewDiagnosticEvent,
} from "@/types/review-diagnostics.types";

type Sink = (lines: string) => Promise<void>;
const MAX_EVENT_BYTES = 4096;

/** One in-flight batch, bounded waiting queue; disk failures never reach saves. */
export class ReviewDiagnosticWriter {
  private queue: string[] = [];
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private counters = {
    accepted: 0,
    written: 0,
    dropped: 0,
    write_failures: 0,
    high_water: 0,
  };
  constructor(
    private readonly sink: Sink,
    private readonly options: {
      capacity?: number;
      batchSize?: number;
      flushMs?: number;
      enabled?: boolean;
    } = {},
  ) {}

  record(event: ReviewDiagnosticEvent): void {
    if (this.options.enabled === false) return;
    try {
      const line =
        JSON.stringify({
          at: reviewTimestamp(),
          server_build: REVIEW_BUILD,
          ...event,
        }) + "\n";
      if (
        Buffer.byteLength(line) > MAX_EVENT_BYTES ||
        this.queue.length >= (this.options.capacity ?? 512)
      ) {
        this.counters.dropped++;
        return;
      }
      this.queue.push(line);
      this.counters.accepted++;
      this.counters.high_water = Math.max(
        this.counters.high_water,
        this.queue.length,
      );
      this.schedule();
    } catch {
      this.counters.dropped++;
    }
  }

  private schedule(): void {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushMs ?? 1000);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.running) return this.running;
    const drain = async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.options.batchSize ?? 32);
        try {
          await this.sink(batch.join(""));
          this.counters.written += batch.length;
        } catch {
          this.counters.write_failures++;
          this.counters.dropped += batch.length;
        }
      }
    };
    this.running = drain();
    try {
      await this.running;
    } finally {
      this.running = null;
      if (this.queue.length) this.schedule();
    }
  }

  status() {
    return {
      enabled: this.options.enabled !== false,
      ...this.counters,
      queued: this.queue.length,
      flushing: !!this.running,
      capacity: this.options.capacity ?? 512,
      batch_size: this.options.batchSize ?? 32,
    };
  }
}

/** Each writer owns unique files; prune only our namespace, never dataset files. */
export function createRotatingReviewSink(
  directory: string,
  options: {
    maxBytes?: number;
    maxFiles?: number;
    retentionMs?: number;
  } = {},
): Sink {
  const prefix = "review-" + process.pid + "-" + randomUUID();
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 20;
  let sequence = 0,
    size = 0,
    initialized = false;
  const prune = async () => {
    const entries = await fs.readdir(directory);
    const files = await Promise.all(
      entries
        .filter((name) => /^review-\d+-[a-f0-9-]+-\d+\.jsonl$/.test(name))
        .map(async (name) => ({
          name,
          stat: await fs.stat(path.join(directory, name)).catch(() => null),
        })),
    );
    const ordered = files
      .filter((entry) => entry.stat?.isFile())
      .sort((a, b) => b.stat!.mtimeMs - a.stat!.mtimeMs);
    await Promise.all(
      ordered
        .filter(
          (entry, index) =>
            index >= maxFiles - 1 ||
            Date.now() - entry.stat!.mtimeMs >
              (options.retentionMs ?? 7 * 86400000),
        )
        .map((entry) =>
          fs.rm(path.join(directory, entry.name), { force: true }),
        ),
    );
  };
  return async (lines) => {
    const bytes = Buffer.byteLength(lines);
    if (bytes > maxBytes)
      throw new Error("Diagnostic batch exceeds file capacity");
    if (!initialized || size + bytes > maxBytes) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (initialized) sequence++;
      size = 0;
      initialized = false;
      await prune();
      initialized = true;
    }
    const file = path.join(directory, prefix + "-" + sequence + ".jsonl");
    // Rotate after a failed append too: partial writes must not evade the cap.
    try {
      await fs.appendFile(file, lines, { mode: 0o600 });
      size += bytes;
    } catch (error) {
      size = maxBytes;
      throw error;
    }
  };
}

const globalState = globalThis as typeof globalThis & {
  __reviewDiagnostics?: {
    writer: ReviewDiagnosticWriter;
    secret: string;
  };
};
function state() {
  if (!globalState.__reviewDiagnostics)
    globalState.__reviewDiagnostics = {
      secret: randomUUID(),
      writer: new ReviewDiagnosticWriter(
        createRotatingReviewSink(
          process.env.REVIEW_DIAGNOSTICS_DIR ??
            path.join(process.cwd(), ".xense-diagnostics", "reviews"),
        ),
        {
          enabled:
            process.env.REVIEW_DIAGNOSTICS_ENABLED !== "0" &&
            process.env.NODE_ENV !== "test",
        },
      ),
    };
  return globalState.__reviewDiagnostics;
}
export function reviewDiagnosticIdentity(value: string): string {
  return createHmac("sha256", state().secret)
    .update(value)
    .digest("hex")
    .slice(0, 24);
}
export function recordReviewDiagnostic(event: ReviewDiagnosticEvent): void {
  state().writer.record(event);
}
export function reviewDiagnosticsStatus() {
  return { version: 1, server_build: REVIEW_BUILD, ...state().writer.status() };
}
export function reviewErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z_0-9]{1,48}$/.test(code)
    ? code
    : "REQUEST_FAILED";
}

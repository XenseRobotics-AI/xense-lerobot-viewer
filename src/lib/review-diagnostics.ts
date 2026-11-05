import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { reviewTimestamp } from "@/utils/reviewTime";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import {
  REVIEW_BUILD,
  type ReviewDiagnosticEvent,
} from "@/types/review-diagnostics.types";

type Sink = (lines: string, browsePath?: string) => Promise<void>;
const MAX_EVENT_BYTES = 4096;

/** One in-flight batch, bounded waiting queue; disk failures never reach saves. */
export class ReviewDiagnosticWriter {
  private queue: { line: string; browsePath?: string }[] = [];
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

  record(event: ReviewDiagnosticEvent, browsePath?: string): void {
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
      this.queue.push({ line, browsePath });
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
        const browsePath = this.queue[0].browsePath;
        let length = 1;
        while (
          length < this.queue.length &&
          length < (this.options.batchSize ?? 32) &&
          this.queue[length].browsePath === browsePath
        )
          length++;
        const batch = this.queue.splice(0, length);
        try {
          await this.sink(
            batch.map((entry) => entry.line).join(""),
            browsePath,
          );
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
    shared?: boolean;
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
    let ownFiles = 0;
    await Promise.all(
      ordered
        .filter((entry) => {
          const excess =
            entry.name.startsWith(prefix + "-") && ownFiles++ >= maxFiles - 1;
          return (
            excess ||
            Date.now() - entry.stat!.mtimeMs >
              (options.retentionMs ?? 7 * 86400000)
          );
        })
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
      if (options.shared) {
        const root = await fs.realpath(path.resolve(directory, "../.."));
        const parent = path.dirname(directory);
        try {
          if (!isInsideRoot(root, await fs.realpath(parent)))
            throw new Error("Diagnostic directory escapes browse directory");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const created = await fs.mkdir(directory, {
        recursive: true,
        mode: options.shared ? 0o2775 : 0o700,
      });
      if (options.shared) {
        const root = path.resolve(directory, "../..");
        if (
          !isInsideRoot(await fs.realpath(root), await fs.realpath(directory))
        )
          throw new Error("Diagnostic directory escapes browse directory");
        if (created) await fs.chmod(directory, 0o2775);
      }
      if (initialized) sequence++;
      size = 0;
      initialized = false;
      await prune();
      initialized = true;
    }
    const file = path.join(directory, prefix + "-" + sequence + ".jsonl");
    // Rotate after a failed append too: partial writes must not evade the cap.
    try {
      const handle = await fs.open(file, "a", options.shared ? 0o664 : 0o600);
      try {
        if (options.shared) await handle.chmod(0o664);
        await handle.writeFile(lines);
      } finally {
        await handle.close();
      }
      size += bytes;
    } catch (error) {
      size = maxBytes;
      throw error;
    }
  };
}

/** Mirror scoped server events to shared storage without growing scope state forever. */
export function createScopedReviewDiagnosticSink(
  localDirectory: string,
  maxScopes = 32,
): Sink {
  const local = createRotatingReviewSink(localDirectory);
  const scopes = new Map<string, Sink>();
  return async (lines, browsePath) => {
    const writes = [local(lines)];
    if (browsePath) {
      const root = path.resolve(browsePath);
      let shared = scopes.get(root);
      if (!shared && scopes.size < maxScopes) {
        shared = createRotatingReviewSink(
          path.join(root, ".xense-viewer", "review-diagnostics"),
          { shared: true },
        );
        scopes.set(root, shared);
      }
      writes.push(
        shared
          ? shared(lines)
          : Promise.reject(new Error("Diagnostic scope capacity exceeded")),
      );
    }
    const results = await Promise.allSettled(writes);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Diagnostic delivery failed");
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
        createScopedReviewDiagnosticSink(
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
export function recordReviewDiagnostic(
  event: ReviewDiagnosticEvent,
  browsePath?: string,
): void {
  state().writer.record(event, browsePath);
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

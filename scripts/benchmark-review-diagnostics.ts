/** Run with: bun scripts/benchmark-review-diagnostics.ts. Temporary fixtures only. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  updateEpisodeReview,
  reviewsFilePath,
} from "../src/lib/episode-reviews-store";
import {
  ReviewDiagnosticWriter,
  createRotatingReviewSink,
} from "../src/lib/review-diagnostics";
import type { ReviewStoreTrace } from "../src/types/review-diagnostics.types";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "xense-review-benchmark-"),
);
const dataset = path.join(root, "synthetic-dataset");
const logDir = path.join(root, "diagnostics");
const count = 60,
  rounds = 5;
const initial =
  JSON.stringify(
    {
      version: 1,
      datasets: {
        "synthetic-dataset": {
          version: 1,
          episodes: Object.fromEntries(
            Array.from({ length: 3000 }, (_, index) => [
              String(index),
              [
                {
                  reviewer: "Fixture",
                  source: "episodes",
                  reviewed_at: "2026-11-03T00:00:00+08:00",
                  stay_ms: 1200,
                  episode_duration_ms: 30000,
                },
              ],
            ]),
          ),
        },
      },
    },
    null,
    2,
  ) + "\n";
const disabled: number[] = [],
  enabled: number[] = [];
const paired: {
  round: number;
  disabled_mean_ms: number;
  enabled_mean_ms: number;
  difference_ms: number;
}[] = [];
const writer = new ReviewDiagnosticWriter(createRotatingReviewSink(logDir));
const percentile = (values: number[], ratio: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ];
};
const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number) => Math.round(value * 1000) / 1000;

async function run(diagnostics: boolean, samples: number, target: number[]) {
  await fs.writeFile(reviewsFilePath(root), initial);
  const startIndex = target.length;
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    const request_id = randomUUID(),
      operation_id = randomUUID();
    const trace: ReviewStoreTrace = { timings: {} };
    if (diagnostics)
      writer.record({
        event: "received",
        request_id,
        operation_id,
        episode_index: 3000 + index,
        reviewed: true,
        snapshot: "present",
      });
    await updateEpisodeReview(
      root,
      dataset,
      {
        episode_index: 3000 + index,
        reviewer: "Benchmark",
        source: "episodes",
        reviewed: true,
        operation_id,
        stay_ms: 1200,
        episode_duration_ms: 30000,
      },
      diagnostics ? trace : undefined,
    );
    if (diagnostics)
      writer.record({
        event: "completed",
        request_id,
        operation_id,
        status: 200,
        duration_ms: performance.now() - started,
        store: trace,
      });
    target.push(performance.now() - started);
  }
  await writer.flush();
  return mean(target.slice(startIndex));
}

try {
  await fs.mkdir(path.join(dataset, "meta"), { recursive: true });
  await fs.writeFile(
    path.join(dataset, "meta", "info.json"),
    JSON.stringify({ total_episodes: 10000 }),
  );
  await fs.mkdir(path.dirname(reviewsFilePath(root)), { recursive: true });
  await run(false, 10, []);
  await run(true, 10, []);
  for (let index = 0; index < rounds; index++) {
    let off: number, on: number;
    if (index % 2 === 0) {
      off = await run(false, count, disabled);
      on = await run(true, count, enabled);
    } else {
      on = await run(true, count, enabled);
      off = await run(false, count, disabled);
    }
    paired.push({
      round: index + 1,
      disabled_mean_ms: round(off),
      enabled_mean_ms: round(on),
      difference_ms: round(on - off),
    });
  }
  const logs = await fs.readdir(logDir);
  const bytes = (
    await Promise.all(
      logs.map(async (name) => (await fs.stat(path.join(logDir, name))).size),
    )
  ).reduce((sum, size) => sum + size, 0);
  console.log(
    JSON.stringify(
      {
        fixture_records: 3000,
        fixture_bytes: Buffer.byteLength(initial),
        samples_per_mode: disabled.length,
        paired,
        disabled: {
          mean_ms: round(mean(disabled)),
          p50_ms: round(percentile(disabled, 0.5)),
          p95_ms: round(percentile(disabled, 0.95)),
        },
        enabled: {
          mean_ms: round(mean(enabled)),
          p50_ms: round(percentile(enabled, 0.5)),
          p95_ms: round(percentile(enabled, 0.95)),
        },
        difference_ms: round(mean(enabled) - mean(disabled)),
        difference_percent: round((mean(enabled) / mean(disabled) - 1) * 100),
        log_bytes: bytes,
        log_bytes_per_save: round(bytes / (rounds * count + 10)),
        log_files: logs.length,
        writer: writer.status(),
        note: "Local temporary filesystem; includes real flock and full JSON rewrite. Not a shared-storage load test or browser benchmark.",
      },
      null,
      2,
    ),
  );
} finally {
  await writer.flush();
  await fs.rm(root, { recursive: true, force: true });
}

import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTypeScriptDoctor } from "../runner";
import type { DoctorProgress } from "@/types/doctor.types";

describe("Doctor runner progress", () => {
  it("does not begin loading an already cancelled diagnostic", async () => {
    const controller = new AbortController();
    controller.abort();
    const progress: DoctorProgress[] = [];
    await expect(
      runTypeScriptDoctor("/missing-dataset", {
        maxEpisodes: 1,
        signal: controller.signal,
        onProgress: (event) => progress.push(event),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toHaveLength(0);
  });
  it("reports loading, each selected check, and completion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-progress-"));
    try {
      await fs.mkdir(path.join(root, "meta"), { recursive: true });
      await fs.writeFile(
        path.join(root, "meta", "info.json"),
        JSON.stringify({
          codebase_version: "v3.0",
          fps: 30,
          total_episodes: 0,
          total_frames: 0,
          total_tasks: 0,
          features: {},
          data_path:
            "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        }),
      );
      const progress: DoctorProgress[] = [];
      const result = await runTypeScriptDoctor(root, {
        maxEpisodes: 1,
        dimensionJumpThresholds: {
          dimensionZThreshold: 12.5,
          extremeSingleDimensionZ: 21,
        },
        speedThresholds: {
          linearMetersPerSecond: 2.25,
          angularDegreesPerSecond: 240,
        },
        checks: ["metadata", "episodes"],
        onProgress: (event) => progress.push(event),
      });

      expect(result.execution.dimension_jump_thresholds).toEqual({
        dimensionZThreshold: 12.5,
        extremeSingleDimensionZ: 21,
      });
      expect(result.execution.speed_thresholds).toEqual({
        linearMetersPerSecond: 2.25,
        angularDegreesPerSecond: 240,
      });

      expect(progress[0]).toMatchObject({
        phase: "loading",
        overall_percent: 0,
      });
      expect(
        progress.some(
          (event) => event.phase === "loading" && event.overall_percent === 40,
        ),
      ).toBe(true);
      expect(
        progress.every(
          (event, index) =>
            index === 0 ||
            event.overall_percent >= progress[index - 1].overall_percent,
        ),
      ).toBe(true);
      expect(
        progress.some(
          (event) =>
            event.phase === "checks" &&
            event.check_id === "metadata" &&
            event.completed === 1,
        ),
      ).toBe(true);
      expect(
        progress.some(
          (event) =>
            event.phase === "checks" &&
            event.check_id === "episodes" &&
            event.completed === 2,
        ),
      ).toBe(true);
      expect(progress.at(-1)).toMatchObject({
        phase: "complete",
        overall_percent: 100,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

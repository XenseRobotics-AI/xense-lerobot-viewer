import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { createTaskStreamResponse } from "@/lib/task-stream-response";
import { SharedAbortableTaskPool } from "@/lib/shared-abortable-task";
import { runTypeScriptDoctor } from "@/lib/doctor/runner";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import {
  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS,
  DEFAULT_DOCTOR_SPEED_THRESHOLDS,
  DOCTOR_CHECK_IDS,
  MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND,
  MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD,
  MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND,
  type DoctorCheckId,
  type DoctorDimensionJumpThresholds,
  type DoctorEpisodeRange,
  type DoctorProgress,
  type DoctorRunResponse,
  type DoctorSpeedThresholds,
  type DoctorStreamEvent,
} from "@/types/doctor.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MAX_EPISODES = 25;
const MAX_EPISODES_LIMIT = 500;
const DOCTOR_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 8;
const CHECK_IDS = new Set<string>(DOCTOR_CHECK_IDS);

interface DoctorRequestBody {
  maxEpisodes?: unknown;
  episodeRange?: unknown;
  dimensionJumpThresholds?: unknown;
  speedThresholds?: unknown;
  checks?: unknown;
}

interface CachedResult {
  expiresAt: number;
  result: DoctorRunResponse;
}

const cache = new Map<string, CachedResult>();
const inFlight = new SharedAbortableTaskPool<DoctorRunResponse>();

function parseOptions(body: DoctorRequestBody):
  | {
      maxEpisodes: number | null;
      episodeRange: DoctorEpisodeRange | null;
      dimensionJumpThresholds: DoctorDimensionJumpThresholds;
      speedThresholds: DoctorSpeedThresholds;
      checks: DoctorCheckId[] | null;
    }
  | { error: string } {
  let maxEpisodes: number | null = DEFAULT_MAX_EPISODES;
  if (body.maxEpisodes === null) maxEpisodes = null;
  else if (body.maxEpisodes !== undefined) {
    if (
      typeof body.maxEpisodes !== "number" ||
      !Number.isInteger(body.maxEpisodes) ||
      body.maxEpisodes < 1 ||
      body.maxEpisodes > MAX_EPISODES_LIMIT
    ) {
      return {
        error: `maxEpisodes must be null or an integer from 1 to ${MAX_EPISODES_LIMIT}.`,
      };
    }
    maxEpisodes = body.maxEpisodes;
  }

  let episodeRange: DoctorEpisodeRange | null = null;
  if (body.episodeRange !== undefined && body.episodeRange !== null) {
    if (
      typeof body.episodeRange !== "object" ||
      Array.isArray(body.episodeRange) ||
      !("start" in body.episodeRange) ||
      !("end" in body.episodeRange)
    ) {
      return {
        error: "episodeRange must contain integer start and end values.",
      };
    }
    const start = body.episodeRange.start;
    const end = body.episodeRange.end;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    ) {
      return {
        error:
          "episodeRange must use non-negative inclusive indices with start <= end.",
      };
    }
    episodeRange = { start, end };
    maxEpisodes = null;
  }

  let checks: DoctorCheckId[] | null = null;
  if (body.checks !== undefined) {
    if (!Array.isArray(body.checks) || body.checks.length === 0) {
      return { error: "checks must be a non-empty array when provided." };
    }
    const unique = [...new Set(body.checks)];
    if (
      unique.some((check) => typeof check !== "string" || !CHECK_IDS.has(check))
    ) {
      return { error: "checks contains an unknown Doctor check id." };
    }
    checks = unique as DoctorCheckId[];
  }

  let dimensionJumpThresholds = DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS;
  if (body.dimensionJumpThresholds !== undefined) {
    const value = body.dimensionJumpThresholds;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("dimensionZThreshold" in value) ||
      !("extremeSingleDimensionZ" in value)
    ) {
      return {
        error:
          "dimensionJumpThresholds must contain dimensionZThreshold and extremeSingleDimensionZ.",
      };
    }
    const dimensionZThreshold = value.dimensionZThreshold;
    const extremeSingleDimensionZ = value.extremeSingleDimensionZ;
    if (
      typeof dimensionZThreshold !== "number" ||
      typeof extremeSingleDimensionZ !== "number" ||
      !Number.isFinite(dimensionZThreshold) ||
      !Number.isFinite(extremeSingleDimensionZ) ||
      dimensionZThreshold <= 0 ||
      extremeSingleDimensionZ <= 0 ||
      dimensionZThreshold > MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD ||
      extremeSingleDimensionZ > MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD
    ) {
      return {
        error: `Dimension jump z-score thresholds must be greater than 0 and at most ${MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD}.`,
      };
    }
    dimensionJumpThresholds = {
      dimensionZThreshold,
      extremeSingleDimensionZ,
    };
  }

  let speedThresholds = DEFAULT_DOCTOR_SPEED_THRESHOLDS;
  if (body.speedThresholds !== undefined) {
    const value = body.speedThresholds;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("linearMetersPerSecond" in value) ||
      !("angularDegreesPerSecond" in value)
    ) {
      return {
        error:
          "speedThresholds must contain linearMetersPerSecond and angularDegreesPerSecond.",
      };
    }
    const linearMetersPerSecond = value.linearMetersPerSecond;
    const angularDegreesPerSecond = value.angularDegreesPerSecond;
    if (
      typeof linearMetersPerSecond !== "number" ||
      typeof angularDegreesPerSecond !== "number" ||
      !Number.isFinite(linearMetersPerSecond) ||
      !Number.isFinite(angularDegreesPerSecond) ||
      linearMetersPerSecond <= 0 ||
      angularDegreesPerSecond <= 0 ||
      linearMetersPerSecond > MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND ||
      angularDegreesPerSecond > MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND
    ) {
      return {
        error: `Speed thresholds must be greater than 0; linear speed must be at most ${MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND} m/s and angular speed at most ${MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND} deg/s.`,
      };
    }
    speedThresholds = {
      linearMetersPerSecond,
      angularDegreesPerSecond,
    };
  }
  return {
    maxEpisodes,
    episodeRange,
    dimensionJumpThresholds,
    speedThresholds,
    checks,
  };
}

async function validateDatasetRoot(encodedPath: string): Promise<{
  root: string;
  signature: string;
} | null> {
  const root = resolveDatasetRoot(encodedPath);
  if (!root) return null;
  try {
    const [rootStat, infoStat] = await Promise.all([
      fs.stat(root),
      fs.stat(path.join(root, "meta", "info.json")),
    ]);
    if (!rootStat.isDirectory() || !infoStat.isFile()) return null;
    return {
      root,
      signature: `${infoStat.size}:${infoStat.mtimeMs}`,
    };
  } catch {
    return null;
  }
}

function remember(key: string, result: DoctorRunResponse): void {
  cache.delete(key);
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function jsonLine(event: DoctorStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function streamCachedResult(result: DoctorRunResponse): Response {
  const cached = {
    ...result,
    execution: { ...result.execution, cache_hit: true },
  } satisfies DoctorRunResponse;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          jsonLine({
            type: "progress",
            progress: {
              phase: "complete",
              completed: 1,
              total: 1,
              percent: 100,
              overall_percent: 100,
              message: "Loaded cached diagnosis",
            },
          }),
        );
        controller.enqueue(jsonLine({ type: "result", result: cached }));
        controller.close();
      },
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    },
  );
}

function streamDoctorRun(
  datasetRoot: string,
  key: string,
  options: {
    maxEpisodes: number | null;
    episodeRange: DoctorEpisodeRange | null;
    dimensionJumpThresholds: DoctorDimensionJumpThresholds;
    speedThresholds: DoctorSpeedThresholds;
    checks: DoctorCheckId[] | null;
  },
  signal: AbortSignal,
): Response {
  return createTaskStreamResponse(
    signal,
    async (emit, jobSignal) => {
      const result = await runTypeScriptDoctor(datasetRoot, {
        ...options,
        signal: jobSignal,
        onProgress: (progress: DoctorProgress) =>
          emit({ type: "progress", progress }),
      });
      jobSignal.throwIfAborted();
      remember(key, result);
      emit({ type: "result", result });
    },
    {
      timeoutMs: DOCTOR_TIMEOUT_MS,
      timeoutMessage: "Doctor timed out after 5 minutes.",
    },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  if (request.signal.aborted) return new Response(null, { status: 499 });
  const { encodedPath } = await context.params;
  if (request.signal.aborted) return new Response(null, { status: 499 });
  const dataset = await validateDatasetRoot(encodedPath);
  if (request.signal.aborted) return new Response(null, { status: 499 });
  if (!dataset)
    return Response.json({ error: "Dataset not found." }, { status: 404 });

  let body: DoctorRequestBody;
  try {
    const raw = (await request.json()) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return Response.json(
        { error: "Request body must be a JSON object." },
        { status: 400 },
      );
    }
    body = raw as DoctorRequestBody;
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  if (request.signal.aborted) return new Response(null, { status: 499 });
  const options = parseOptions(body);
  if ("error" in options)
    return Response.json({ error: options.error }, { status: 400 });

  const scopeKey = options.episodeRange
    ? `range-${options.episodeRange.start}-${options.episodeRange.end}`
    : (options.maxEpisodes ?? "all");
  const thresholdKey = `${options.dimensionJumpThresholds.dimensionZThreshold}-${options.dimensionJumpThresholds.extremeSingleDimensionZ}`;
  const speedKey = `${options.speedThresholds.linearMetersPerSecond}-${options.speedThresholds.angularDegreesPerSecond}`;
  const key = `${dataset.root}:${dataset.signature}:${scopeKey}:jumps-${thresholdKey}:speeds-${speedKey}:${(options.checks ?? DOCTOR_CHECK_IDS).join(",")}`;
  const wantsStream = request.nextUrl.searchParams.get("stream") === "1";
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const cached = cache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    if (wantsStream) return streamCachedResult(cached.result);
    return Response.json({
      ...cached.result,
      execution: { ...cached.result.execution, cache_hit: true },
    } satisfies DoctorRunResponse);
  }
  if (cached) cache.delete(key);

  if (wantsStream) {
    return streamDoctorRun(dataset.root, key, options, request.signal);
  }

  try {
    const result = await inFlight.run(
      key,
      request.signal,
      async (signal) => {
        const result = await runTypeScriptDoctor(dataset.root, {
          ...options,
          signal,
        });
        signal.throwIfAborted();
        remember(key, result);
        return result;
      },
      {
        timeoutMs: DOCTOR_TIMEOUT_MS,
        timeoutMessage: "Doctor timed out after 5 minutes.",
      },
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (error instanceof Error && error.name === "TimeoutError") {
      return Response.json(
        { error: "Doctor timed out after 5 minutes." },
        { status: 504 },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * The filesystem half of the browsing facets — server-only.
 *
 * Split from `dataset-facets.ts` because the homepage grid is a client
 * component and reaches the pure predicates through `@/utils/corpusFilters`.
 * Keeping the `node:` imports here means the client bundle never sees them;
 * putting them in the shared module fails the build outright with
 * `UnhandledSchemeError: Reading from "node:fs/promises" is not handled`.
 */

// (No `server-only` guard: the package is not a dependency here, and adding
// one for a single import barrier is not worth it. The rule is the file name
// plus this comment — anything importing it from a `"use client"` component
// will fail the build the same way, just less politely.)
import fs from "node:fs/promises";
import path from "node:path";
import {
  bucketOf,
  dateFromName,
  shapeAnomalyOf,
  type DatasetFacets,
  type DateEvidence,
} from "@/lib/dataset-facets";

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

function isoDay(value: unknown): string | null {
  return typeof value === "string" && value.length >= 10
    ? value.slice(0, 10)
    : null;
}

function span(days: string[]): { from: string; to: string } | null {
  if (!days.length) return null;
  const sorted = [...days].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

/**
 * Capture dates, strongest evidence first:
 *
 * 1. `meta/hardware.json` epochs carry `recorded_at` — a real timestamp with a
 *    timezone, written per recording session. Only this one is a measurement.
 * 2. `meta/tacflow/sessions.json` names each source day-repo; the date comes
 *    from that name's suffix.
 * 3. The dataset directory's own `-MMDD` suffix.
 *
 * Falls through to `none` rather than guessing. A dataset with no evidence is
 * *not* assumed to predate the cutoff — 13.8% of the corpus lands here, and
 * quietly filing them as "old" would hide any new data among them.
 */
export async function readCaptureDates(datasetDir: string): Promise<{
  capturedFrom: string | null;
  capturedTo: string | null;
  dateEvidence: DateEvidence;
}> {
  const hardware = (await readJson(
    path.join(datasetDir, "meta", "hardware.json"),
  )) as { epochs?: { recorded_at?: unknown }[] } | null;
  const recorded = (hardware?.epochs ?? [])
    .map((e) => isoDay(e?.recorded_at))
    .filter((d): d is string => d !== null);
  const fromManifest = span(recorded);
  if (fromManifest) {
    return {
      capturedFrom: fromManifest.from,
      capturedTo: fromManifest.to,
      dateEvidence: "manifest",
    };
  }

  const sessions = (await readJson(
    path.join(datasetDir, "meta", "tacflow", "sessions.json"),
  )) as { sessions?: { source?: unknown }[] } | null;
  const sourceDays = (sessions?.sessions ?? [])
    .map((s) => (typeof s?.source === "string" ? dateFromName(s.source) : null))
    .filter((d): d is string => d !== null);
  const fromSessions = span(sourceDays);
  if (fromSessions) {
    return {
      capturedFrom: fromSessions.from,
      capturedTo: fromSessions.to,
      dateEvidence: "sessions",
    };
  }

  const own = dateFromName(path.basename(datasetDir));
  if (own) {
    return { capturedFrom: own, capturedTo: own, dateEvidence: "name" };
  }

  return { capturedFrom: null, capturedTo: null, dateEvidence: "none" };
}

/** Every facet for one dataset. `features` comes from `meta/info.json`. */
export async function computeFacets(
  datasetDir: string,
  relativePath: string,
  features: Record<string, { shape?: number[] }> | undefined,
  robotType?: string | null,
): Promise<DatasetFacets> {
  const stateShape = features?.["observation.state"]?.shape;
  const stateDim =
    Array.isArray(stateShape) && typeof stateShape[0] === "number"
      ? stateShape[0]
      : null;
  const videoKeys = Object.keys(features ?? {}).filter((k) =>
    k.startsWith("observation.images."),
  );
  const headStreams = videoKeys.filter((k) => k.includes("head")).length;

  return {
    bucket: bucketOf(relativePath),
    ...(await readCaptureDates(datasetDir)),
    shapeAnomaly: shapeAnomalyOf(stateDim, videoKeys.length, robotType),
    stateDim,
    videoStreams: videoKeys.length,
    headStreams,
  };
}

import type { NextRequest } from "next/server";
import { discoverLocalDatasets } from "@/lib/local-datasets-discovery";
import { readHfCatalog, type HfCatalogEntry } from "@/lib/hf-catalog-cache";
import {
  runTypeScriptDoctor,
  TYPESCRIPT_DOCTOR_VERSION,
} from "@/lib/doctor/runner";
import {
  calculateTacFlowScore,
  normalizeTacFlowScoreWeight,
  type TacFlowDoctorCheck,
  type TacFlowDoctorReport,
} from "@/lib/tacflow/scoring";
import {
  fingerprintWorkbenchDataset,
  readWorkbenchTacFlowScoreLedger,
  writeWorkbenchTacFlowScoreLedger,
} from "@/lib/workbench-score-ledger";
import {
  isWorkbenchTacFlowScoreCacheHit,
  normalizeWorkbenchScoreDay,
  normalizeWorkbenchScoreOrganization,
  resolveWorkbenchDatasetAbsolutePath,
  selectWorkbenchDatasetsForScore,
  type WorkbenchScoreDatasetMetadata,
} from "@/lib/workbench-score-batch";
import { tryAcquireTacFlowRun, releaseTacFlowRun } from "@/lib/tacflow/lock";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import { recordWorkbenchSharedEvent } from "@/lib/workbench-shared-sync";
import { DOCTOR_CHECK_IDS, type DoctorReport } from "@/types/doctor.types";
import type { WorkbenchTacFlowScoreLedgerEntry } from "@/types/workbench-score.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_WEIGHT = 100;

type BatchRequestBody = {
  organization?: unknown;
  org?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  startDateTime?: unknown;
  endDateTime?: unknown;
  weights?: unknown;
  checkWeights?: unknown;
  doctorCheckWeights?: unknown;
  forceRescore?: unknown;
  force?: unknown;
};
type BatchProgressEvent = {
  type: "progress";
  phase: "start" | "dataset" | "complete";
  completed: number;
  total: number;
  failed: number;
  cached: number;
  currentDataset: string | null;
  percent: number;
  message: string;
};
type BatchDatasetEvent = {
  type: "dataset";
  datasetPath: string;
  status: "scored" | "cached" | "retry";
  cacheHit: boolean;
  score: number | null;
  grade: string | null;
  scoredAt: string | null;
  report?: TacFlowDoctorReport;
  error?: string;
};
type BatchEvent =
  | BatchProgressEvent
  | BatchDatasetEvent
  | {
      type: "summary";
      total: number;
      completed: number;
      failed: number;
      cached: number;
      scored: number;
      pending: number;
    }
  | { type: "error"; error: string };

function jsonLine(event: BatchEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event) + "\n");
}
function dateValue(
  body: BatchRequestBody,
  key: "startDate" | "endDate",
): unknown {
  const timeKey = key === "startDate" ? "startDateTime" : "endDateTime";
  return body[key] ?? body[timeKey];
}
function parseWeights(
  input: unknown,
):
  | { ok: true; weights: Record<string, number> }
  | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, weights: {} };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ok: false,
      error: "weights must be an object keyed by Doctor check id.",
    };
  const weights: Record<string, number> = {};
  for (const [id, value] of Object.entries(input)) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_WEIGHT
    )
      return {
        ok: false,
        error: "Doctor check weights must be finite numbers from 0 to 100.",
      };
    weights[id] = normalizeTacFlowScoreWeight(value);
  }
  if (
    DOCTOR_CHECK_IDS.every(
      (id) => normalizeTacFlowScoreWeight(weights[id]) <= 0,
    )
  )
    return {
      ok: false,
      error: "At least one Doctor check weight must be greater than 0.",
    };
  return { ok: true, weights };
}
async function parseBody(request: Request): Promise<
  | {
      ok: true;
      organization: string;
      startDate: string;
      endDate: string;
      weights: Record<string, number>;
      forceRescore: boolean;
    }
  | { ok: false; error: string }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "Request body must be JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "Request body must be a JSON object." };
  const body = raw as BatchRequestBody;
  const organization = normalizeWorkbenchScoreOrganization(
    body.organization ?? body.org,
  );
  if (!organization)
    return { ok: false, error: "A valid dataset organization is required." };
  const startDate = normalizeWorkbenchScoreDay(dateValue(body, "startDate"));
  const endDate = normalizeWorkbenchScoreDay(dateValue(body, "endDate"));
  if (!startDate || !endDate || startDate >= endDate)
    return {
      ok: false,
      error:
        "startDate and endDate must be valid dates with startDate before endDate.",
    };
  const parsedWeights = parseWeights(
    body.weights ?? body.checkWeights ?? body.doctorCheckWeights,
  );
  if (!parsedWeights.ok) return parsedWeights;
  return {
    ok: true,
    organization,
    startDate,
    endDate,
    weights: parsedWeights.weights,
    forceRescore: body.forceRescore === true || body.force === true,
  };
}

function metadataForDatasets(
  organization: string,
  datasets: readonly { relativePath: string }[],
  entries: readonly HfCatalogEntry[],
): Map<string, WorkbenchScoreDatasetMetadata> {
  const byRepo = new Map<string, HfCatalogEntry>();
  for (const entry of entries)
    if (typeof entry.repoId === "string" && entry.repoId)
      byRepo.set(entry.repoId, entry);
  const result = new Map<string, WorkbenchScoreDatasetMetadata>();
  for (const dataset of datasets) {
    const leaf =
      dataset.relativePath.split("/").filter(Boolean).at(-1) ??
      dataset.relativePath;
    const entry =
      byRepo.get(dataset.relativePath) ?? byRepo.get(organization + "/" + leaf);
    result.set(dataset.relativePath, {
      repoId: entry?.repoId ?? organization + "/" + leaf,
      lastModified:
        typeof entry?.lastModified === "string" ? entry.lastModified : null,
    });
  }
  return result;
}
function reportForScoring(report: DoctorReport): TacFlowDoctorReport {
  const checks: TacFlowDoctorCheck[] = report.checks.map((check, index) => ({
    id: DOCTOR_CHECK_IDS[index] ?? "check_" + (index + 1),
    name: check.name,
    severity: check.severity,
    messages: check.messages.map((message) => ({ ...message })),
    findings: [],
  }));
  return {
    schema: "tacflow.doctor/1",
    version: report.version,
    dataset_path: report.dataset_path,
    dataset_name: report.dataset_name,
    codebase_version: report.codebase_version,
    format_version: report.format_version,
    total_episodes: report.total_episodes,
    total_frames: report.total_frames,
    fps: report.fps,
    overall_severity: report.overall_severity,
    summary: report.summary,
    checks,
  };
}
function effectiveWeights(
  input: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    DOCTOR_CHECK_IDS.map((id) => [id, normalizeTacFlowScoreWeight(input[id])]),
  );
}
function reportForEvent(
  report: WorkbenchTacFlowScoreLedgerEntry["doctorReport"],
): TacFlowDoctorReport | undefined {
  if (!report || !Array.isArray(report.checks)) return undefined;
  if (
    report.checks.every(
      (check) =>
        Boolean(check) &&
        typeof check === "object" &&
        typeof (check as { id?: unknown }).id === "string",
    )
  ) {
    return report as TacFlowDoctorReport;
  }
  return reportForScoring(report as DoctorReport);
}

type LockRun = Extract<
  ReturnType<typeof tryAcquireTacFlowRun>,
  { ok: true }
>["run"];
async function processBatch(
  request: NextRequest,
  lock: LockRun,
  input: {
    organization: string;
    startDate: string;
    endDate: string;
    weights: Record<string, number>;
    forceRescore: boolean;
  },
  datasets: Awaited<ReturnType<typeof discoverLocalDatasets>>["datasets"],
  root: string,
  initialEntries: readonly WorkbenchTacFlowScoreLedgerEntry[],
  send: (event: BatchEvent) => void,
): Promise<void> {
  const entries = new Map(
    initialEntries.map((entry) => [entry.datasetPath, entry]),
  );
  const weights = effectiveWeights(input.weights);
  let completed = 0;
  let failed = 0;
  let cached = 0;
  send({
    type: "progress",
    phase: "start",
    completed,
    total: datasets.length,
    failed,
    cached,
    currentDataset: null,
    percent: datasets.length ? 0 : 100,
    message: datasets.length
      ? "Starting sequential Doctor scoring"
      : "No datasets in the selected range",
  });
  for (const dataset of datasets) {
    if (request.signal.aborted)
      throw new DOMException("Scoring aborted", "AbortError");
    const datasetPath = dataset.relativePath;
    send({
      type: "progress",
      phase: "dataset",
      completed,
      total: datasets.length,
      failed,
      cached,
      currentDataset: datasetPath,
      percent: datasets.length
        ? Math.round((completed / datasets.length) * 100)
        : 100,
      message: "Scoring " + datasetPath,
    });
    let fingerprint = "";
    try {
      const absolutePath = resolveWorkbenchDatasetAbsolutePath(
        root,
        datasetPath,
      );
      if (!absolutePath)
        throw new Error("Dataset path is outside the local dataset root.");
      fingerprint = await fingerprintWorkbenchDataset(absolutePath);
      const old = entries.get(datasetPath);
      if (
        !input.forceRescore &&
        old &&
        isWorkbenchTacFlowScoreCacheHit(
          old,
          fingerprint,
          TYPESCRIPT_DOCTOR_VERSION,
          weights,
        )
      ) {
        cached += 1;
        completed += 1;
        const cachedReport = reportForEvent(old.doctorReport);
        send({
          type: "dataset",
          datasetPath,
          status: "cached",
          cacheHit: true,
          score: old.score,
          grade: old.grade,
          scoredAt: old.scoredAt,
          ...(cachedReport ? { report: cachedReport } : {}),
        });
        send({
          type: "progress",
          phase: "dataset",
          completed,
          total: datasets.length,
          failed,
          cached,
          currentDataset: datasetPath,
          percent: Math.round((completed / datasets.length) * 100),
          message: "Reused cached score for " + datasetPath,
        });
        continue;
      }
      const result = await runTypeScriptDoctor(absolutePath, {
        maxEpisodes: null,
        checks: [...DOCTOR_CHECK_IDS],
        signal: request.signal,
      });
      const report = reportForScoring(result.report);
      const calculation = calculateTacFlowScore(report.checks, weights);
      if (!calculation.ok) throw new Error(calculation.error);
      const entry: WorkbenchTacFlowScoreLedgerEntry = {
        datasetPath,
        doctorReport: result.report,
        score: calculation.score,
        grade: calculation.grade,
        rows: calculation.rows,
        tacflowVersion: TYPESCRIPT_DOCTOR_VERSION,
        checkWeights: weights,
        datasetFingerprint: fingerprint,
        scoredAt: new Date().toISOString(),
        status: "scored",
      };
      entries.set(datasetPath, entry);
      await writeWorkbenchTacFlowScoreLedger(
        input.organization,
        Array.from(entries.values()),
        root,
      );
      completed += 1;
      send({
        type: "dataset",
        datasetPath,
        status: "scored",
        cacheHit: false,
        score: entry.score,
        grade: entry.grade,
        scoredAt: entry.scoredAt,
        report,
      });
      send({
        type: "progress",
        phase: "dataset",
        completed,
        total: datasets.length,
        failed,
        cached,
        currentDataset: datasetPath,
        percent: Math.round((completed / datasets.length) * 100),
        message: "Completed " + datasetPath,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const entry: WorkbenchTacFlowScoreLedgerEntry = {
        datasetPath,
        doctorReport: null,
        score: null,
        grade: null,
        rows: [],
        tacflowVersion: TYPESCRIPT_DOCTOR_VERSION,
        checkWeights: weights,
        datasetFingerprint: fingerprint,
        scoredAt: new Date().toISOString(),
        status: "retry",
        error: message,
      };
      entries.set(datasetPath, entry);
      await writeWorkbenchTacFlowScoreLedger(
        input.organization,
        Array.from(entries.values()),
        root,
      ).catch(() => undefined);
      failed += 1;
      completed += 1;
      send({
        type: "dataset",
        datasetPath,
        status: "retry",
        cacheHit: false,
        score: null,
        grade: null,
        scoredAt: entry.scoredAt,
        error: message,
      });
      send({
        type: "progress",
        phase: "dataset",
        completed,
        total: datasets.length,
        failed,
        cached,
        currentDataset: datasetPath,
        percent: Math.round((completed / datasets.length) * 100),
        message: "Scoring failed; marked for retry: " + datasetPath,
      });
    }
  }
  send({
    type: "summary",
    total: datasets.length,
    completed,
    failed,
    cached,
    scored: completed - failed,
    pending: failed,
  });
  send({
    type: "progress",
    phase: "complete",
    completed,
    total: datasets.length,
    failed,
    cached,
    currentDataset: null,
    percent: 100,
    message: "Workbench Doctor batch complete",
  });
  await recordWorkbenchSharedEvent(
    {
      org: input.organization,
      source: "workbench",
      kind: "tacflow-score.batch",
      outcome: failed > 0 ? "failed" : "success",
      details: {
        startDate: input.startDate,
        endDate: input.endDate,
        forceRescore: input.forceRescore,
        weights,
        total: datasets.length,
        completed,
        failed,
        cached,
        scored: completed - failed,
        results: datasets.map((dataset) => {
          const entry = entries.get(dataset.relativePath);
          return {
            datasetPath: dataset.relativePath,
            status: entry?.status ?? "missing",
            score: entry?.score ?? null,
            grade: entry?.grade ?? null,
            scoredAt: entry?.scoredAt ?? null,
            error: entry?.error ?? null,
          };
        }),
      },
    },
    root,
  ).catch(() => undefined);
  releaseTacFlowRun(lock);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request))
    return Response.json(
      { error: "Cross-origin Workbench TACFLOW score runs are not allowed." },
      { status: 403 },
    );
  const input = await parseBody(request);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  const discovery = await discoverLocalDatasets();
  if (!discovery.root)
    return Response.json(
      { error: "Unable to resolve the local dataset root." },
      { status: 400 },
    );
  let catalogEntries: HfCatalogEntry[] = [];
  try {
    const catalog = await readHfCatalog(discovery.root, input.organization);
    catalogEntries = Array.isArray(catalog.datasets) ? catalog.datasets : [];
  } catch {
    /* local discovery is enough */
  }
  const metadata = metadataForDatasets(
    input.organization,
    discovery.datasets,
    catalogEntries,
  );
  const datasets = selectWorkbenchDatasetsForScore(
    discovery.datasets,
    input.organization,
    input.startDate,
    input.endDate,
    metadata,
  );
  let ledger;
  try {
    ledger = await readWorkbenchTacFlowScoreLedger(
      input.organization,
      discovery.root,
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
  const lock = tryAcquireTacFlowRun(
    "Workbench TACFLOW score batch " + input.organization,
  );
  if (!lock.ok)
    return Response.json(
      {
        error:
          lock.active.label +
          " has been running since " +
          new Date(lock.active.startedAt).toISOString() +
          ".",
      },
      { status: 409 },
    );
  let closed = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: BatchEvent) => {
          if (closed) return;
          try {
            controller.enqueue(jsonLine(event));
          } catch {
            closed = true;
          }
        };
        void processBatch(
          request,
          lock.run,
          input,
          datasets,
          discovery.root,
          ledger.entries,
          send,
        )
          .catch((error) => {
            if (!request.signal.aborted)
              send({
                type: "error",
                error: error instanceof Error ? error.message : String(error),
              });
            releaseTacFlowRun(lock.run);
          })
          .finally(() => {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          });
      },
      cancel() {
        // Keep the lock until the sequential batch has actually stopped.
        // The request signal normally aborts on disconnect; releasing here
        // would allow a second batch to overlap if it does not.
        closed = true;
      },
    }),
    { headers: noStoreHeaders("application/x-ndjson; charset=utf-8") },
  );
  return response;
}

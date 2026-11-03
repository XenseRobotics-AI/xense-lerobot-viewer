export const REVIEW_DIAGNOSTICS_VERSION = 1;
export const REVIEW_BUILD = (process.env.NEXT_PUBLIC_REVIEW_BUILD ?? "unknown")
  .replace(/[^a-zA-Z0-9._-]/g, "_")
  .slice(0, 80);

export type TimerState =
  | "tracking"
  | "hidden"
  | "disabled"
  | "no_reviewer"
  | "surface_not_ready"
  | "invalid_duration";

export interface ReviewTimerDiagnostics {
  state: TimerState;
  starts: number;
  pauses: number;
  storage_read_failures: number;
  storage_write_failures: number;
  restored: boolean;
}

export interface ReviewClientDiagnostics {
  queue_ms?: number;
  version: 1;
  client_build: string;
  session_id: string;
  snapshot: "present" | "not_ready" | "unmark" | "unknown";
  timer?: ReviewTimerDiagnostics;
}

export function isReviewOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  );
}

const states: TimerState[] = [
  "tracking",
  "hidden",
  "disabled",
  "no_reviewer",
  "surface_not_ready",
  "invalid_duration",
];
const counter = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 65535;

/** Diagnostics never invalidate an otherwise compatible business request. */
export function parseReviewDiagnostics(
  input: unknown,
): ReviewClientDiagnostics | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !isReviewOperationId(raw.session_id) ||
    typeof raw.client_build !== "string" ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(raw.client_build) ||
    !["present", "not_ready", "unmark", "unknown"].includes(
      raw.snapshot as string,
    )
  )
    return undefined;
  const result: ReviewClientDiagnostics = {
    version: 1,
    client_build: raw.client_build,
    session_id: raw.session_id,
    snapshot: raw.snapshot as ReviewClientDiagnostics["snapshot"],
  };
  if (
    typeof raw.queue_ms === "number" &&
    Number.isSafeInteger(raw.queue_ms) &&
    raw.queue_ms >= 0 &&
    raw.queue_ms <= 86400000
  )
    result.queue_ms = raw.queue_ms;
  const timer = raw.timer as Record<string, unknown> | undefined;
  if (
    timer &&
    states.includes(timer.state as TimerState) &&
    [
      timer.starts,
      timer.pauses,
      timer.storage_read_failures,
      timer.storage_write_failures,
    ].every(counter) &&
    typeof timer.restored === "boolean"
  ) {
    result.timer = {
      state: timer.state as TimerState,
      starts: timer.starts as number,
      pauses: timer.pauses as number,
      storage_read_failures: timer.storage_read_failures as number,
      storage_write_failures: timer.storage_write_failures as number,
      restored: timer.restored,
    };
  }
  return result;
}

export type ReviewSaveOutcome = "timeout_confirmed" | "unknown" | "rejected";
export const REVIEW_STORE_STAGES = [
  "lock_wait",
  "read",
  "write",
  "commit",
  "cleanup",
] as const;
export type ReviewStoreStage = (typeof REVIEW_STORE_STAGES)[number];
export interface ReviewStoreTrace {
  failed_phase?: ReviewStoreStage;
  phase?: ReviewStoreStage;
  timings: Partial<Record<ReviewStoreStage, number>>;
  committed?: boolean;
  unchanged?: boolean;
}

export interface ReviewDiagnosticEvent {
  request_phase?: "validation" | "scope" | "profile" | "store" | "response";
  event: "received" | "completed" | "client_result";
  request_id: string;
  operation_id?: string;
  client?: ReviewClientDiagnostics;
  diagnostics_status?: "valid" | "missing" | "invalid";
  dataset_id?: string;
  reviewer_id?: string;
  episode_index?: number;
  reviewed?: boolean;
  snapshot?: "present" | "missing" | "unmark";
  status?: number;
  duration_ms?: number;
  queue_ms?: number;
  result?: ReviewSaveOutcome;
  error_code?: string;
  store?: ReviewStoreTrace;
}

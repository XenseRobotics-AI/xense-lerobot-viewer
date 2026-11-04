import {
  REVIEW_BUILD,
  type ReviewClientDiagnostics,
  type ReviewTimerDiagnostics,
  type TimerState,
} from "@/types/review-diagnostics.types";
import {
  MAX_REVIEWER_LENGTH,
  REVIEWER_ROLES,
  parseReviewsFile,
  type EpisodeReviewsFile,
  type EpisodeReviewsResponse,
  type ReviewUpdate,
  type ReviewerProfile,
} from "@/types/episode-review.types";
import { tStandalone } from "@/i18n/standalone";
import {
  parseReviewOperationReceipt,
  reviewOperationResolution,
} from "@/types/review-operation.types";

/** Correlation only, never an authorization token; works on LAN HTTP too. */
export function createReviewId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues)
    globalThis.crypto.getRandomValues(bytes);
  else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
let sessionId: string | undefined;
export function clientReviewDiagnostics(
  snapshot: ReviewClientDiagnostics["snapshot"],
  timer?: ReviewTimerDiagnostics,
): ReviewClientDiagnostics {
  sessionId ??= createReviewId();
  return {
    version: 1,
    client_build: REVIEW_BUILD,
    session_id: sessionId,
    snapshot,
    ...(timer ? { timer } : {}),
  };
}

/** Bounded counters per current episode; no event history or per-frame work. */
export class ReviewTimerProbe {
  private data: ReviewTimerDiagnostics = {
    state: "disabled",
    starts: 0,
    pauses: 0,
    storage_read_failures: 0,
    storage_write_failures: 0,
    restored: false,
  };
  transition(state: TimerState): void {
    if (state !== this.data.state) {
      if (state === "tracking")
        this.data.starts = Math.min(65535, this.data.starts + 1);
      else if (this.data.state === "tracking")
        this.data.pauses = Math.min(65535, this.data.pauses + 1);
      this.data.state = state;
    }
  }
  storageFailure(kind: "read" | "write"): void {
    const key =
      kind === "read" ? "storage_read_failures" : "storage_write_failures";
    this.data[key] = Math.min(65535, this.data[key] + 1);
  }
  restored(): void {
    this.data.restored = true;
  }
  read(): ReviewTimerDiagnostics {
    return { ...this.data };
  }
}

class ReviewDeadlineError extends Error {}
export class ReviewSaveUnknownError extends Error {
  constructor(public readonly operationId: string) {
    super(tStandalone("review.saveUnknown") + " (" + operationId + ")");
  }
}
export class ReviewRejectedError extends Error {
  constructor(
    message: string,
    public readonly file?: EpisodeReviewsFile,
  ) {
    super(message);
  }
}

function reviewFailureMessage(
  raw: { code?: unknown; error?: unknown } | null,
  status: number,
): string {
  const code =
    raw?.code ??
    (typeof raw?.error === "string" &&
    raw.error.startsWith(
      "Review file is busy with an old-version or unknown writer.",
    )
      ? "REVIEW_LEGACY_LOCK"
      : undefined);
  switch (code) {
    case "REVIEW_LOCK_BUSY":
      return tStandalone("review.lockBusy");
    case "REVIEW_LEGACY_LOCK":
      return tStandalone("review.legacyLock");
    case "REVIEW_LOCK_CHANGED":
      return tStandalone("review.lockChanged");
    case "REVIEW_LOCK_UNAVAILABLE":
      return tStandalone("review.lockUnavailable");
    default:
      return typeof raw?.error === "string" ? raw.error : String(status);
  }
}

/** Deadline covers headers AND body, even if a transport ignores abort. */
async function deadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  external?: AbortSignal,
): Promise<T> {
  if (external?.aborted)
    throw new DOMException("Review read cancelled", "AbortError");
  const controller = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new DOMException("Review read cancelled", "AbortError"));
      controller.abort();
    };
    external?.addEventListener("abort", cancel, { once: true });
  });
  let timeout!: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ReviewDeadlineError(tStandalone("review.refreshTimeout")));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired, cancelled]);
  } finally {
    clearTimeout(timeout);
    external?.removeEventListener("abort", cancel);
  }
}

async function readReviewResponse(
  endpoint: string,
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    operationId?: string;
    verificationOnly?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  if (options.operationId) params.set("operation_id", options.operationId);
  if (options.verificationOnly) params.set("verify", "1");
  const query = params.toString();
  const url = query
    ? endpoint + (endpoint.includes("?") ? "&" : "?") + query
    : endpoint;
  return deadline(
    async (signal) => {
      const response = await (options.fetcher ?? fetch)(url, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const raw = await response.json().catch(() => null);
        throw new Error(reviewFailureMessage(raw, response.status));
      }
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid review response");
      return raw as Record<string, unknown>;
    },
    options.timeoutMs ?? 10000,
    options.signal,
  );
}

/** Read only operation evidence; roster failures must not prevent reconciliation. */
export async function readReviewOperationState(
  endpoint: string,
  options: NonNullable<Parameters<typeof readReviewResponse>[1]> & {
    operationId: string;
  },
): Promise<Pick<EpisodeReviewsResponse, "file" | "operation">> {
  const raw = await readReviewResponse(endpoint, {
    ...options,
    verificationOnly: true,
  });
  return {
    file: parseReviewsFile(raw.file),
    operation: parseReviewOperationReceipt(raw.operation),
  };
}

/** Validate everything consumed by React before updating any provider state. */
export async function readEpisodeReviewState(
  endpoint: string,
  options: NonNullable<Parameters<typeof readReviewResponse>[1]> = {},
): Promise<EpisodeReviewsResponse> {
  const raw = await readReviewResponse(endpoint, options);
  const validName = (name: unknown): name is string =>
    typeof name === "string" &&
    !!name &&
    name === name.trim() &&
    name.length <= MAX_REVIEWER_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(name);
  if (
    !Array.isArray(raw.reviewers) ||
    !raw.reviewers.every(validName) ||
    new Set(raw.reviewers).size !== raw.reviewers.length ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length !== raw.reviewers.length ||
    typeof raw.storage_path !== "string" ||
    !raw.storage_path ||
    typeof raw.dataset_key !== "string" ||
    !raw.dataset_key
  )
    throw new Error("Invalid review response metadata");
  const reviewers = raw.reviewers as string[];
  const names = new Set<string>();
  const profiles = raw.profiles.map((input: unknown): ReviewerProfile => {
    const profile = input as Partial<ReviewerProfile> | null;
    if (
      !profile ||
      !validName(profile.name) ||
      !reviewers.includes(profile.name) ||
      names.has(profile.name) ||
      !REVIEWER_ROLES.includes(profile.role!)
    )
      throw new Error("Invalid review response roster");
    names.add(profile.name);
    return { name: profile.name, role: profile.role! };
  });
  return {
    file: parseReviewsFile(raw.file),
    reviewers,
    profiles,
    storage_path: raw.storage_path,
    dataset_key: raw.dataset_key,
    operation: parseReviewOperationReceipt(raw.operation),
  };
}

export async function saveReviewWithDeadline(
  endpoint: string,
  payload: ReviewUpdate & {
    operation_id: string;
    diagnostics: ReviewClientDiagnostics;
  },
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    reconcileMs?: number;
    report?: (event: {
      operation_id: string;
      diagnostics: ReviewClientDiagnostics;
      result: "unknown" | "timeout_confirmed" | "rejected";
      duration_ms: number;
    }) => void;
  } = {},
): Promise<EpisodeReviewsFile> {
  const fetcher = options.fetcher ?? fetch;
  const started = performance.now();
  let serverFailureMessage: string | undefined;
  const report = (result: "unknown" | "timeout_confirmed" | "rejected") => {
    try {
      options.report?.({
        operation_id: payload.operation_id,
        diagnostics: payload.diagnostics,
        result,
        duration_ms: Math.min(
          86400000,
          Math.max(0, Math.round(performance.now() - started)),
        ),
      });
    } catch {
      /* Diagnostics cannot affect saves. */
    }
  };
  try {
    return await deadline(async (signal) => {
      const response = await fetcher(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
        signal,
      });
      if (!response.ok) {
        const raw = await response.json().catch(() => null);
        serverFailureMessage = reviewFailureMessage(raw, response.status);
        if (
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 499
        )
          throw new Error("Ambiguous server failure");
        if (raw?.code === "OPERATION_UNCONFIRMED")
          throw new Error("Operation needs verification");
        throw new ReviewRejectedError(serverFailureMessage);
      }
      const file = parseReviewsFile(await response.json());
      if (reviewStateMatches(file, payload) !== true)
        throw new Error("Save response does not match the requested state");
      return file;
    }, options.timeoutMs ?? 15000);
  } catch (error) {
    if (error instanceof ReviewRejectedError) {
      report("rejected");
      throw error;
    }
    // A lost response cannot establish that the write failed. Read once, never
    // replay PUT. An absent record cannot prove that an unmark was committed.
    try {
      const { file, operation } = await readReviewOperationState(endpoint, {
        fetcher,
        timeoutMs: options.reconcileMs ?? 5000,
        operationId: payload.operation_id,
      });
      const resolution = reviewOperationResolution(file, payload, operation);
      if (resolution === "succeeded") {
        report("timeout_confirmed");
        return file;
      }
      if (resolution === "failed")
        throw new ReviewRejectedError(
          serverFailureMessage ?? tStandalone("review.saveEndedWithError"),
          file,
        );
    } catch (error) {
      if (error instanceof ReviewRejectedError) {
        report("rejected");
        throw error;
      }
      /* Preserve unknown, not a false failure or success. */
    }
    report("unknown");
    throw new ReviewSaveUnknownError(payload.operation_id);
  }
}

export function reviewStateMatches(
  file: EpisodeReviewsFile,
  update: Pick<ReviewUpdate, "episode_index" | "reviewer" | "reviewed">,
): boolean {
  const marked =
    file.episodes[String(update.episode_index)]?.some(
      (entry) => entry.reviewer === update.reviewer,
    ) ?? false;
  return marked === update.reviewed;
}

/** Only exceptional saves send a separate bounded, best-effort diagnostic. */
export function reportReviewSaveResult(
  event: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof saveReviewWithDeadline>[2]>["report"]
    >
  >[0],
): void {
  void deadline(async (signal) => {
    await fetch("/api/review-diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true,
      signal,
    });
  }, 2000).catch(() => undefined);
}

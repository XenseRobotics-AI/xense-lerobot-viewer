import {
  REVIEW_BUILD,
  type ReviewClientDiagnostics,
  type ReviewTimerDiagnostics,
  type TimerState,
} from "@/types/review-diagnostics.types";
import {
  parseReviewsFile,
  type EpisodeReviewsFile,
  type EpisodeReviewsResponse,
  type ReviewUpdate,
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

export async function readEpisodeReviewState(
  endpoint: string,
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    operationId?: string;
  } = {},
): Promise<EpisodeReviewsResponse> {
  const url = options.operationId
    ? endpoint +
      (endpoint.includes("?") ? "&" : "?") +
      "operation_id=" +
      encodeURIComponent(options.operationId)
    : endpoint;
  return deadline(
    async (signal) => {
      const response = await (options.fetcher ?? fetch)(url, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const raw = await response.json().catch(() => null);
        throw new Error(
          typeof raw?.error === "string" ? raw.error : String(response.status),
        );
      }
      const raw = (await response.json()) as EpisodeReviewsResponse;
      return {
        ...raw,
        file: parseReviewsFile(raw?.file),
        operation: parseReviewOperationReceipt(raw?.operation),
      };
    },
    options.timeoutMs ?? 10000,
    options.signal,
  );
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
        if (
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 499
        )
          throw new Error("Ambiguous server failure");
        const raw = await response.json().catch(() => null);
        if (raw?.code === "OPERATION_UNCONFIRMED")
          throw new Error("Operation needs verification");
        throw new ReviewRejectedError(
          typeof raw?.error === "string" ? raw.error : String(response.status),
        );
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
      const { file, operation } = await readEpisodeReviewState(endpoint, {
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
          tStandalone("review.saveEndedWithError"),
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

import { randomUUID } from "node:crypto";
import {
  recordReviewDiagnostic,
  reviewDiagnosticsStatus,
} from "@/lib/review-diagnostics";
import {
  readReviewRequestBody,
  ReviewBodyError,
} from "@/lib/review-request-body";
import {
  isReviewOperationId,
  parseReviewDiagnostics,
  type ReviewSaveOutcome,
} from "@/types/review-diagnostics.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
let windowStart = 0,
  received = 0;
let rateLimited = 0;
export function GET(): Response {
  return Response.json(
    { ...reviewDiagnosticsStatus(), client_results_rate_limited: rateLimited },
    { headers },
  );
}

/** Exceptional client results only; fixed fields, no raw errors or dataset paths. */
export async function POST(req: Request): Promise<Response> {
  const now = Date.now();
  if (now - windowStart >= 60000) {
    windowStart = now;
    received = 0;
  }
  if (++received > 120) {
    rateLimited++;
    return new Response(null, { status: 429, headers });
  }
  try {
    const raw = (await readReviewRequestBody(req, 2048)) as Record<
      string,
      unknown
    > | null;
    const client = parseReviewDiagnostics(raw?.diagnostics);
    if (
      !client ||
      !isReviewOperationId(raw?.operation_id) ||
      !["unknown", "timeout_confirmed", "rejected"].includes(
        raw?.result as string,
      ) ||
      !Number.isSafeInteger(raw?.duration_ms) ||
      (raw?.duration_ms as number) < 0 ||
      (raw?.duration_ms as number) > 86400000
    )
      return new Response(null, { status: 400, headers });
    recordReviewDiagnostic({
      event: "client_result",
      request_id: randomUUID(),
      operation_id: raw!.operation_id as string,
      client,
      result: raw!.result as ReviewSaveOutcome,
      duration_ms: raw!.duration_ms as number,
    });
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return new Response(null, {
      status: error instanceof ReviewBodyError ? 413 : 400,
      headers,
    });
  }
}

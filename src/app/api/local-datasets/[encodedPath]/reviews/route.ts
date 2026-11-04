import { NextRequest } from "next/server";
import {
  reviewOperationReceipts,
  reviewOperationScope,
} from "@/lib/review-operation-receipts";
import { randomUUID } from "node:crypto";
import {
  recordReviewDiagnostic,
  reviewDiagnosticIdentity,
  reviewErrorCode,
} from "@/lib/review-diagnostics";
import {
  readReviewRequestBody,
  ReviewBodyError,
} from "@/lib/review-request-body";
import {
  REVIEW_BUILD,
  isReviewOperationId,
  parseReviewDiagnostics,
  type ReviewDiagnosticEvent,
  type ReviewStoreTrace,
} from "@/types/review-diagnostics.types";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import {
  readEpisodeReviews,
  readReviewCollection,
  reviewDatasetKey,
  reviewsFilePath,
  updateEpisodeReview,
  persistFailedReviewOperation,
  ReviewStoreError,
} from "@/lib/episode-reviews-store";
import {
  readReviewerProfiles,
  resolveReviewBrowsePath,
} from "@/lib/episode-review-scope";
import { parseReviewUpdate } from "@/types/episode-review.types";
import { reviewReceiptMatches } from "@/types/review-operation.types";
import { BROWSE_PATH_COOKIE } from "@/utils/browsePath";
import { ReviewWriteLockError } from "@/lib/review-write-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ encodedPath: string }> };
const headers = { "Cache-Control": "no-store" };

function failure(error: unknown): Response {
  const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Failed to access episode reviews",
    },
    {
      status:
        error instanceof ReviewStoreError ||
        error instanceof ReviewWriteLockError
          ? error.status
          : missing
            ? 404
            : 500,
    },
  );
}

async function scope(req: NextRequest, ctx: Context) {
  const root = resolveDatasetRoot((await ctx.params).encodedPath);
  if (!root) throw new ReviewStoreError("Invalid dataset path", 400);
  const browsePath = await resolveReviewBrowsePath(
    req.nextUrl.searchParams.get("browsePath") ??
      req.cookies.get(BROWSE_PATH_COOKIE)?.value,
  );
  const key = await reviewDatasetKey(browsePath, root);
  return { root, browsePath, key };
}

export async function GET(req: NextRequest, ctx: Context): Promise<Response> {
  try {
    const { root, browsePath, key } = await scope(req, ctx);
    const operationId = req.nextUrl.searchParams.get("operation_id");
    if (operationId !== null && !isReviewOperationId(operationId))
      throw new ReviewStoreError("Invalid operation_id", 400);
    const verificationOnly = req.nextUrl.searchParams.get("verify") === "1";
    if (verificationOnly && !operationId)
      throw new ReviewStoreError("Verification requires operation_id", 400);
    if (req.nextUrl.searchParams.get("download") === "1")
      return Response.json(await readReviewCollection(browsePath), {
        headers: {
          ...headers,
          "Content-Disposition": 'attachment; filename="episode-reviews.json"',
        },
      });
    const file = await readEpisodeReviews(browsePath, root);
    const operation = operationId
      ? (file.operation_receipts?.find(
          (receipt) => receipt.operation_id === operationId,
        ) ??
        reviewOperationReceipts().get(
          reviewOperationScope(browsePath, key),
          operationId,
        ))
      : undefined;
    // Evidence must remain readable if the roster changes after a save.
    if (verificationOnly)
      return Response.json({ file, operation }, { headers });
    const profiles = await readReviewerProfiles(browsePath);
    return Response.json(
      {
        profiles,
        file,
        reviewers: profiles.map((profile) => profile.name),
        storage_path: reviewsFilePath(browsePath),
        dataset_key: key,
        ...(operationId ? { operation } : {}),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(req: NextRequest, ctx: Context): Promise<Response> {
  const started = performance.now();
  const requestId = randomUUID();
  const trace: ReviewStoreTrace = { timings: {} };
  const event: ReviewDiagnosticEvent = {
    event: "received",
    request_id: requestId,
    request_phase: "validation",
  };
  const responseHeaders = {
    ...headers,
    "X-Review-Request-Id": requestId,
    "X-Review-Build": REVIEW_BUILD,
  };
  let status = 500;
  let finishOperation: ((state: "succeeded" | "failed") => void) | undefined;
  let persistOperationFailure = false;
  let operationTarget: { browsePath: string; datasetPath: string } | undefined;
  const finish = (response: Response) => {
    status = response.status;
    for (const [key, value] of Object.entries(responseHeaders))
      response.headers.set(key, value);
    return response;
  };
  let update;
  try {
    const raw = (await readReviewRequestBody(req)) as Record<
      string,
      unknown
    > | null;
    const client = parseReviewDiagnostics(raw?.diagnostics);
    event.client = client;
    event.diagnostics_status =
      raw?.diagnostics === undefined ? "missing" : client ? "valid" : "invalid";
    if (isReviewOperationId(raw?.operation_id))
      event.operation_id = raw.operation_id;
    update = parseReviewUpdate(raw);
    event.reviewer_id = reviewDiagnosticIdentity(update.reviewer);
    event.episode_index = update.episode_index;
    event.reviewed = update.reviewed;
    event.snapshot = !update.reviewed
      ? "unmark"
      : update.stay_ms === undefined
        ? "missing"
        : "present";
  } catch (error) {
    recordReviewDiagnostic({
      ...event,
      event: "completed",
      status: error instanceof ReviewBodyError ? error.status : 400,
      error_code:
        error instanceof ReviewBodyError && error.status !== 413
          ? error.status === 408
            ? "REQUEST_TIMEOUT"
            : "REQUEST_CANCELLED"
          : "INVALID_REQUEST",
      duration_ms: Math.round(performance.now() - started),
    });
    return finish(
      Response.json(
        { error: error instanceof Error ? error.message : "Invalid JSON body" },
        { status: error instanceof ReviewBodyError ? error.status : 400 },
      ),
    );
  }
  recordReviewDiagnostic(event);
  try {
    event.request_phase = "scope";
    const { root, browsePath, key } = await scope(req, ctx);
    operationTarget = { browsePath, datasetPath: root };
    event.dataset_id = reviewDiagnosticIdentity(root);
    event.request_phase = "profile";
    // Register first so roster failures become terminal, verifiable outcomes.
    if (update.operation_id) {
      const registration = reviewOperationReceipts().begin(
        reviewOperationScope(browsePath, key),
        { ...update, operation_id: update.operation_id },
      );
      if (registration.state === "started") {
        persistOperationFailure = true;
        finishOperation = registration.finish;
      } else if (registration.state === "unavailable") {
        persistOperationFailure = true;
      } else if (registration.state === "conflict")
        return finish(
          Response.json(
            {
              error: "operation_id already belongs to another action",
              code: "OPERATION_CONFLICT",
            },
            { status: 409 },
          ),
        );
      else if (registration.state === "duplicate") {
        if (registration.receipt.state === "succeeded")
          return finish(
            Response.json(await readEpisodeReviews(browsePath, root), {
              headers,
            }),
          );
        return finish(
          Response.json(
            {
              error:
                "Operation is pending or ended with an error; verify its outcome",
              code: "OPERATION_UNCONFIRMED",
            },
            { status: 409 },
          ),
        );
      }
    }
    if (update.operation_id) {
      event.request_phase = "store";
      trace.phase = "read";
      const readAt = performance.now();
      const current = await readEpisodeReviews(browsePath, root)
        .catch((error) => {
          trace.failed_phase = "read";
          throw error;
        })
        .finally(() => {
          trace.timings.read =
            Math.round((performance.now() - readAt) * 100) / 100;
        });
      const previous = current.operation_receipts?.find(
        (receipt) => receipt.operation_id === update.operation_id,
      );
      if (previous) {
        const same = reviewReceiptMatches(previous, {
          ...update,
          operation_id: update.operation_id,
        });
        if (!same)
          return finish(
            Response.json(
              {
                error: "operation_id already belongs to another action",
                code: "OPERATION_CONFLICT",
              },
              { status: 409 },
            ),
          );
        if (previous.state === "succeeded")
          return finish(Response.json(current, { headers }));
        return finish(
          Response.json(
            {
              error:
                "Operation already ended with an error; verify its outcome",
              code: "OPERATION_REJECTED",
            },
            { status: 409 },
          ),
        );
      }
    }
    event.request_phase = "profile";
    const profile = (await readReviewerProfiles(browsePath)).find(
      (entry) => entry.name === update.reviewer,
    );
    if (!profile)
      throw new ReviewStoreError(
        "Select a preset inspector from the dropdown",
        400,
      );
    event.request_phase = "store";
    const file = await updateEpisodeReview(
      browsePath,
      root,
      { ...update, role: profile.role },
      trace,
    );
    event.request_phase = "response";
    return finish(Response.json(file, { headers }));
  } catch (error) {
    event.error_code = reviewErrorCode(error);
    return finish(failure(error));
  } finally {
    if (
      persistOperationFailure &&
      status >= 400 &&
      !trace.committed &&
      operationTarget
    )
      await persistFailedReviewOperation(
        operationTarget.browsePath,
        operationTarget.datasetPath,
        update,
      ).catch(() => undefined);
    finishOperation?.(status < 400 || trace.committed ? "succeeded" : "failed");
    recordReviewDiagnostic({
      ...event,
      event: "completed",
      status,
      store: trace,
      duration_ms: Math.round(performance.now() - started),
    });
  }
}

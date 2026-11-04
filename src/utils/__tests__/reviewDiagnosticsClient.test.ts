import { describe, expect, test } from "bun:test";
import {
  clientReviewDiagnostics,
  createReviewId,
  ReviewTimerProbe,
  saveReviewWithDeadline,
  ReviewSaveUnknownError,
  ReviewRejectedError,
  readEpisodeReviewState,
} from "../reviewDiagnosticsClient";
import { ReviewSaveQueue } from "../reviewSaveQueue";
import { isReviewOperationId } from "@/types/review-diagnostics.types";
import {
  parseReviewOperationReceipt,
  reviewOperationResolution,
} from "@/types/review-operation.types";

const payload = (reviewed = true) => ({
  episode_index: 2,
  reviewer: "Alice",
  source: "episodes" as const,
  reviewed,
  operation_id: createReviewId(),
  diagnostics: clientReviewDiagnostics(reviewed ? "present" : "unmark"),
});
const file = (operation_id?: string) => ({
  version: 1,
  episodes: {
    "2": [
      {
        reviewer: "Alice",
        source: "episodes",
        reviewed_at: "2026-11-03T08:00:00+08:00",
        ...(operation_id ? { operation_id } : {}),
      },
    ],
  },
});
const hang = () => new Promise<Response>(() => {});
const options = { timeoutMs: 5, reconcileMs: 5 };

describe("review timer diagnostic summary", () => {
  test("correlation IDs are valid and sessions remain stable", () => {
    expect(isReviewOperationId(createReviewId())).toBe(true);
    expect(createReviewId()).not.toBe(createReviewId());
    expect(clientReviewDiagnostics("present").session_id).toBe(
      clientReviewDiagnostics("not_ready").session_id,
    );
  });
  test("tracks readiness, visibility and storage failures without event history", () => {
    const probe = new ReviewTimerProbe();
    probe.transition("surface_not_ready");
    probe.transition("tracking");
    probe.transition("tracking");
    probe.transition("hidden");
    probe.transition("tracking");
    probe.storageFailure("read");
    probe.storageFailure("write");
    probe.restored();
    expect(probe.read()).toEqual({
      state: "tracking",
      starts: 2,
      pauses: 1,
      storage_read_failures: 1,
      storage_write_failures: 1,
      restored: true,
    });
    const copy = probe.read();
    copy.starts = 99;
    expect(probe.read().starts).toBe(2);
  });
  test("counters saturate rather than accumulating unbounded data", () => {
    const probe = new ReviewTimerProbe();
    for (let i = 0; i < 70000; i++) probe.storageFailure("write");
    expect(probe.read().storage_write_failures).toBe(65535);
  });
});

describe("review write deadline and reconciliation", () => {
  test("a completed exact unmark receipt closes a lost deletion response", async () => {
    const body = payload(false);
    const fetcher = (async (url, init) => {
      if (init?.method === "PUT") throw new Error("response lost");
      expect(String(url)).toContain("operation_id=" + body.operation_id);
      return Response.json({
        file: { version: 1, episodes: {} },
        operation: { ...body, state: "succeeded" },
      });
    }) as typeof fetch;
    expect(
      (
        await saveReviewWithDeadline("/reviews?browsePath=fixture", body, {
          ...options,
          fetcher,
        })
      ).episodes,
    ).toEqual({});
  });
  test("a pending receipt cannot confirm deletion or release the unknown operation", async () => {
    const body = payload(false);
    const fetcher = (async (_url, init) =>
      init?.method === "PUT"
        ? hang()
        : Response.json({
            file: { version: 1, episodes: {} },
            operation: { ...body, state: "pending" },
          })) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", body, { ...options, fetcher }),
    ).rejects.toBeInstanceOf(ReviewSaveUnknownError);
  });
  test("a failed terminal receipt is an ended request, not a pending save", async () => {
    const body = payload();
    const fetcher = (async (_url, init) =>
      init?.method === "PUT"
        ? new Response(null, { status: 500 })
        : Response.json({
            file: { version: 1, episodes: {} },
            operation: { ...body, state: "failed" },
          })) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", body, { ...options, fetcher }),
    ).rejects.toBeInstanceOf(ReviewRejectedError);
  });
  test("readback resolution is scoped to operation, person, episode and action", () => {
    const target = payload(false),
      empty = { version: 1 as const, episodes: {} };
    const receipt = {
      operation_id: target.operation_id,
      episode_index: target.episode_index,
      reviewer: target.reviewer,
      reviewed: false,
      state: "succeeded" as const,
    };
    expect(reviewOperationResolution(empty, target, receipt)).toBe("succeeded");
    for (const mismatch of [
      { operation_id: createReviewId() },
      { episode_index: 3 },
      { reviewer: "Bob" },
      { reviewed: true },
    ])
      expect(
        reviewOperationResolution(empty, target, { ...receipt, ...mismatch }),
      ).toBe("unknown");
    expect(reviewOperationResolution(empty, payload(false), receipt)).toBe(
      "unknown",
    );
    expect(
      parseReviewOperationReceipt({ ...receipt, state: "arbitrary" }),
    ).toBeUndefined();
    expect(
      parseReviewOperationReceipt({ ...receipt, reviewer: "x".repeat(81) }),
    ).toBeUndefined();
  });
  test("read deadlines include hanging bodies and an external abort releases the request", async () => {
    const fetcher = (async () =>
      ({
        ok: true,
        json: () => new Promise(() => {}),
      }) as Response) as typeof fetch;
    await expect(
      readEpisodeReviewState("/reviews", { fetcher, timeoutMs: 5 }),
    ).rejects.toThrow();
    const controller = new AbortController();
    const pending = readEpisodeReviewState("/reviews", {
      fetcher,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    const outcome = pending.catch((error: unknown) => error);
    controller.abort();
    expect(((await outcome) as Error).name).toBe("AbortError");
    expect(
      (
        await readEpisodeReviewState("/reviews", {
          fetcher: (async () =>
            Response.json({
              file: { version: 1, episodes: {} },
              reviewers: [],
              profiles: [],
              storage_path: "/fixture/reviews.json",
              dataset_key: ".",
            })) as typeof fetch,
        })
      ).file.episodes,
    ).toEqual({});
  });
  test("durable terminal evidence takes precedence and compares the full action", () => {
    const target = { ...payload(), stay_ms: 0, episode_duration_ms: 1000 };
    const exact = { ...target, state: "succeeded" as const };
    const stored = {
      version: 1 as const,
      episodes: {},
      operation_receipts: [exact],
    };
    expect(
      reviewOperationResolution(stored, target, { ...exact, state: "pending" }),
    ).toBe("succeeded");
    expect(
      reviewOperationResolution(
        { ...stored, operation_receipts: [{ ...exact, state: "failed" }] },
        target,
      ),
    ).toBe("failed");
    for (const change of [
      { source: "urdf" as const },
      { stay_ms: 1 },
      { episode_duration_ms: 2000 },
    ]) {
      expect(reviewOperationResolution(stored, { ...target, ...change })).toBe(
        "unknown",
      );
      expect(
        reviewOperationResolution(
          { version: 1, episodes: {} },
          { ...target, ...change },
          exact,
        ),
      ).toBe("unknown");
    }
    const legacy = {
      operation_id: target.operation_id,
      episode_index: target.episode_index,
      reviewer: target.reviewer,
      reviewed: true,
      state: "succeeded" as const,
    };
    expect(parseReviewOperationReceipt(legacy)).toEqual(legacy);
    expect(
      reviewOperationResolution({ version: 1, episodes: {} }, target, legacy),
    ).toBe("succeeded");
    for (const change of [
      { reviewer: " Alice " },
      { reviewer: "Al\nlice" },
      { stay_ms: 3, episode_duration_ms: 1 },
      { stay_ms: 0, episode_duration_ms: Number.MAX_SAFE_INTEGER },
      { reviewed: false, stay_ms: 0, episode_duration_ms: 1 },
    ])
      expect(
        parseReviewOperationReceipt({ ...exact, ...change }),
      ).toBeUndefined();
  });
  test("a 200 response with the wrong mark state is not an acknowledgment", async () => {
    let calls = 0;
    const fetcher = (async (_url, init) => {
      calls++;
      return Response.json(
        init?.method === "PUT"
          ? { version: 1, episodes: {} }
          : { file: { version: 1, episodes: {} } },
      );
    }) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", payload(), { ...options, fetcher }),
    ).rejects.toBeInstanceOf(ReviewSaveUnknownError);
    expect(calls).toBe(2);
  });
  test("an unacknowledged 408 must be reconciled rather than treated as a rejection", async () => {
    const body = payload();
    const fetcher = (async (_url, init) =>
      init?.method === "PUT"
        ? new Response(null, { status: 408 })
        : Response.json({ file: file(body.operation_id) })) as typeof fetch;
    expect(
      (await saveReviewWithDeadline("/reviews", body, { ...options, fetcher }))
        .episodes["2"][0].operation_id,
    ).toBe(body.operation_id);
  });
  test("normal save performs one PUT and no extra diagnostic request", async () => {
    const body = payload();
    let calls = 0,
      reports = 0;
    const fetcher = (async (_url, init) => {
      calls++;
      expect(init?.method).toBe("PUT");
      return Response.json(file(body.operation_id));
    }) as typeof fetch;
    const result = await saveReviewWithDeadline("/reviews", body, {
      fetcher,
      report: () => {
        reports++;
      },
    });
    expect(result.episodes["2"][0].operation_id).toBe(body.operation_id);
    expect(calls).toBe(1);
    expect(reports).toBe(0);
  });
  test("response loss after commit is confirmed only by the exact operation ID", async () => {
    const body = payload();
    const methods: (string | undefined)[] = [];
    let result = "";
    const fetcher = (async (_url, init) => {
      methods.push(init?.method);
      return init?.method === "PUT"
        ? hang()
        : Response.json({ file: file(body.operation_id) });
    }) as typeof fetch;
    await saveReviewWithDeadline("/reviews", body, {
      ...options,
      fetcher,
      report: (event) => {
        result = event.result;
      },
    });
    expect(methods).toEqual(["PUT", undefined]);
    expect(result).toBe("timeout_confirmed");
  });
  test("a matching old reviewer entry cannot prove that this operation committed", async () => {
    const body = payload();
    let puts = 0;
    const fetcher = (async (_url, init) => {
      if (init?.method === "PUT") {
        puts++;
        return hang();
      }
      return Response.json({ file: file(createReviewId()) });
    }) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", body, { ...options, fetcher }),
    ).rejects.toBeInstanceOf(ReviewSaveUnknownError);
    expect(puts).toBe(1);
  });
  test("unmark absence cannot be mistaken for an acknowledged deletion", async () => {
    const fetcher = (async (_url, init) =>
      init?.method === "PUT"
        ? hang()
        : Response.json({
            file: { version: 1, episodes: {} },
          })) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", payload(false), {
        ...options,
        fetcher,
      }),
    ).rejects.toBeInstanceOf(ReviewSaveUnknownError);
  });
  test("network errors and post-commit 500 responses can be reconciled", async () => {
    for (const response of ["network", "server"]) {
      const body = payload();
      const fetcher = (async (_url, init) => {
        if (init?.method === "PUT") {
          if (response === "network") throw new TypeError("disconnected");
          return new Response(null, { status: 500 });
        }
        return Response.json({ file: file(body.operation_id) });
      }) as typeof fetch;
      expect(
        (
          await saveReviewWithDeadline("/reviews", body, {
            ...options,
            fetcher,
          })
        ).episodes["2"][0].operation_id,
      ).toBe(body.operation_id);
    }
  });
  test("a definite validation rejection is not retried or read back", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ error: "Select inspector" }, { status: 400 });
    }) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", payload(), { ...options, fetcher }),
    ).rejects.toThrow("Select inspector");
    expect(calls).toBe(1);
  });
  test("deadline includes a hanging response body and a hanging readback", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = (async (_url, init) => {
      signals.push(init!.signal as AbortSignal);
      return { ok: true, json: () => new Promise(() => {}) } as Response;
    }) as typeof fetch;
    await expect(
      saveReviewWithDeadline("/reviews", payload(), { ...options, fetcher }),
    ).rejects.toBeInstanceOf(ReviewSaveUnknownError);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  test("a timed-out item does not block the next captured target in the save queue", async () => {
    const queue = new ReviewSaveQueue();
    const firstBody = payload(),
      secondBody = { ...payload(), episode_index: 3 };
    const targets: number[] = [];
    const first = queue.enqueue("first", async () => {
      await saveReviewWithDeadline("/reviews", firstBody, {
        ...options,
        fetcher: hang as typeof fetch,
      });
    });
    const firstOutcome = first.catch((error: unknown) => error);
    const second = queue.enqueue("second", async () => {
      await saveReviewWithDeadline("/reviews", secondBody, {
        fetcher: (async (_url, init) => {
          targets.push(JSON.parse(init!.body as string).episode_index);
          return Response.json({
            version: 1,
            episodes: { "3": file(secondBody.operation_id).episodes["2"] },
          });
        }) as typeof fetch,
      });
    });
    expect(await firstOutcome).toBeInstanceOf(ReviewSaveUnknownError);
    await second;
    expect(targets).toEqual([3]);
    expect(queue.size).toBe(0);
  });
  test("diagnostic reporter exceptions cannot invalidate confirmed writes", async () => {
    const body = payload();
    const fetcher = (async (_url, init) =>
      init?.method === "PUT"
        ? hang()
        : Response.json({ file: file(body.operation_id) })) as typeof fetch;
    expect(
      (
        await saveReviewWithDeadline("/reviews", body, {
          ...options,
          fetcher,
          report: () => {
            throw new Error("log failed");
          },
        })
      ).episodes["2"][0].operation_id,
    ).toBe(body.operation_id);
  });
});

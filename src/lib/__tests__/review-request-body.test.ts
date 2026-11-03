import { describe, expect, test } from "bun:test";
import { readReviewRequestBody } from "../review-request-body";

function stalled(signal?: AbortSignal) {
  let cancelled = false;
  const request = new Request("http://localhost/reviews", {
    method: "PUT",
    signal,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  return { request, cancelled: () => cancelled };
}
async function boundedFailure(request: Request, timeoutMs = 10) {
  return Promise.race([
    readReviewRequestBody(request, 8192, { timeoutMs }).catch(
      (error: unknown) => error,
    ),
    Bun.sleep(100).then(() => null),
  ]) as Promise<{ status?: number } | null>;
}
describe("review request resource boundaries", () => {
  test("UTF-8 split across tiny chunks is decoded without corrupting the payload", async () => {
    const expected = { reviewer: "质检员" };
    const bytes = new TextEncoder().encode(JSON.stringify(expected));
    const request = new Request("http://localhost/reviews", {
      method: "PUT",
      body: new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    });
    expect(await readReviewRequestBody(request)).toEqual(expected);
    expect(request.body?.locked).toBe(false);
  });
  test("failed streams release the reader and preserve the original failure", async () => {
    const request = new Request("http://localhost/reviews", {
      method: "PUT",
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("fixture read failure"));
        },
      }),
    });
    await expect(readReviewRequestBody(request)).rejects.toThrow(
      "fixture read failure",
    );
    expect(request.body?.locked).toBe(false);
  });
  test("body limits do not wait on a broken stream cancellation handler", async () => {
    const request = new Request("http://localhost/reviews", {
      method: "PUT",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8193));
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
    });
    expect((await boundedFailure(request))?.status).toBe(413);
    expect(request.body?.locked).toBe(false);
  });
  test("a stalled upload has a deadline and cancels its body", async () => {
    const fixture = stalled();
    expect((await boundedFailure(fixture.request))?.status).toBe(408);
    expect(fixture.cancelled()).toBe(true);
  });
  test("an aborted upload releases the reader without waiting for timeout", async () => {
    const controller = new AbortController();
    const fixture = stalled(controller.signal);
    const result = boundedFailure(fixture.request, 10000);
    controller.abort();
    expect((await result)?.status).toBe(499);
    expect(fixture.cancelled()).toBe(true);
  });
  test("a pre-aborted upload cannot be read as a valid request", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://localhost/reviews", {
      method: "PUT",
      signal: controller.signal,
      body: "{}",
    });
    expect((await boundedFailure(request))?.status).toBe(499);
  });
  test("declared oversize cancels the unread body immediately", async () => {
    const fixture = stalled();
    fixture.request.headers.set("content-length", "99999");
    expect((await boundedFailure(fixture.request))?.status).toBe(413);
    expect(fixture.cancelled()).toBe(true);
  });
});

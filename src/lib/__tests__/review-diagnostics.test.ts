import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ReviewDiagnosticWriter,
  createRotatingReviewSink,
  reviewErrorCode,
  reviewDiagnosticIdentity,
} from "../review-diagnostics";
import { readReviewRequestBody, ReviewBodyError } from "../review-request-body";
import {
  isReviewOperationId,
  parseReviewDiagnostics,
  type ReviewDiagnosticEvent,
} from "@/types/review-diagnostics.types";
import { GET, POST } from "@/app/api/review-diagnostics/route";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function folder() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "review-diagnostics-test-"),
  );
  folders.push(dir);
  return dir;
}
const event = (): ReviewDiagnosticEvent => ({
  event: "received",
  request_id: crypto.randomUUID(),
});
const client = () => ({
  version: 1,
  client_build: "test-sha",
  session_id: crypto.randomUUID(),
  snapshot: "present",
});

describe("bounded review diagnostic protocol", () => {
  test("legacy and malformed diagnostics remain unknown; arbitrary payload is stripped", () => {
    expect(parseReviewDiagnostics(undefined)).toBeUndefined();
    expect(parseReviewDiagnostics({ ...client(), version: 2 })).toBeUndefined();
    expect(
      parseReviewDiagnostics({ ...client(), client_build: "secret/path\n" }),
    ).toBeUndefined();
    const raw = {
      ...client(),
      token: "secret",
      path: "/private/data",
      timer: {
        state: "tracking",
        starts: 1,
        pauses: 0,
        storage_read_failures: 0,
        storage_write_failures: 0,
        restored: false,
        secret: "discard",
      },
    };
    const parsed = parseReviewDiagnostics(raw)!;
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(parsed.timer?.starts).toBe(1);
  });
  test("oversize counters and malformed IDs are not trusted", () => {
    expect(isReviewOperationId("x\n".repeat(500))).toBe(false);
    expect(
      parseReviewDiagnostics({
        ...client(),
        timer: { state: "tracking", starts: 65536 },
      })?.timer,
    ).toBeUndefined();
    expect(
      parseReviewDiagnostics({ ...client(), queue_ms: Infinity })?.queue_ms,
    ).toBeUndefined();
  });
  test("error codes and identities never contain raw paths or error messages", () => {
    expect(reviewErrorCode(new Error("/private/token"))).toBe("REQUEST_FAILED");
    expect(reviewErrorCode({ code: "EACCES", message: "secret" })).toBe(
      "EACCES",
    );
    expect(reviewErrorCode({ code: "/private" })).toBe("REQUEST_FAILED");
    expect(reviewDiagnosticIdentity("Alice/private/data")).toMatch(
      /^[a-f0-9]{24}$/,
    );
    expect(reviewDiagnosticIdentity("same")).toBe(
      reviewDiagnosticIdentity("same"),
    );
  });
});

describe("review diagnostic writer", () => {
  test("batches events in order, producing real JSON lines with UTC+8 timestamps", async () => {
    const writes: string[] = [];
    const writer = new ReviewDiagnosticWriter(
      async (value) => {
        writes.push(value);
      },
      { batchSize: 2 },
    );
    const events = [event(), event(), event()];
    events.forEach((value) => writer.record(value));
    await writer.flush();
    expect(writes).toHaveLength(2);
    const lines = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.request_id)).toEqual(
      events.map((entry) => entry.request_id),
    );
    expect(lines[0].at).toMatch(/\+08:00$/);
    expect(writer.status()).toMatchObject({
      written: 3,
      queued: 0,
      dropped: 0,
    });
  });
  test("a blocked disk cannot grow the waiting queue or block producers", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = new ReviewDiagnosticWriter(() => blocked, {
      capacity: 4,
      batchSize: 2,
    });
    writer.record(event());
    const flush = writer.flush();
    for (let i = 0; i < 100; i++) writer.record(event());
    expect(writer.status()).toMatchObject({
      queued: 4,
      dropped: 96,
      high_water: 4,
      flushing: true,
    });
    release();
    await flush;
    expect(writer.status().written).toBe(5);
  });
  test("unwritable sink loses diagnostic batches only and recovers on later events", async () => {
    let fail = true;
    const writer = new ReviewDiagnosticWriter(async () => {
      if (fail) throw Object.assign(new Error("private"), { code: "ENOSPC" });
    });
    writer.record(event());
    await writer.flush();
    expect(writer.status()).toMatchObject({
      dropped: 1,
      write_failures: 1,
      queued: 0,
    });
    fail = false;
    writer.record(event());
    await writer.flush();
    expect(writer.status().written).toBe(1);
  });
  test("disabled and oversized events allocate no queued work", async () => {
    let called = false;
    const disabled = new ReviewDiagnosticWriter(
      async () => {
        called = true;
      },
      { enabled: false },
    );
    disabled.record(event());
    await disabled.flush();
    expect(called).toBe(false);
    const writer = new ReviewDiagnosticWriter(async () => {});
    writer.record({ ...event(), request_id: "x".repeat(5000) });
    expect(writer.status()).toMatchObject({
      accepted: 0,
      dropped: 1,
      queued: 0,
    });
  });
  test("scheduled flush runs without an explicit flush call", async () => {
    let done!: () => void;
    const written = new Promise<void>((resolve) => {
      done = resolve;
    });
    const writer = new ReviewDiagnosticWriter(
      async () => {
        done();
      },
      { flushMs: 2 },
    );
    writer.record(event());
    await written;
    await writer.flush();
    expect(writer.status().written).toBe(1);
  });
  test("rotation caps files, expires old logs, and leaves unrelated files intact", async () => {
    const dir = await folder();
    const old = path.join(dir, "review-1-" + crypto.randomUUID() + "-0.jsonl");
    await fs.writeFile(old, "expired\n");
    await fs.utimes(old, new Date(0), new Date(0));
    await fs.writeFile(path.join(dir, "keep.json"), "untouched");
    const sink = createRotatingReviewSink(dir, {
      maxBytes: 30,
      maxFiles: 3,
      retentionMs: 1000,
    });
    for (let i = 0; i < 8; i++)
      await sink(JSON.stringify({ i, x: "padding" }) + "\n");
    const names = await fs.readdir(dir);
    expect(names.filter((name) => name.endsWith("jsonl"))).toHaveLength(3);
    expect(await fs.exists(old)).toBe(false);
    expect(await fs.readFile(path.join(dir, "keep.json"), "utf8")).toBe(
      "untouched",
    );
    for (const name of names.filter((value) => value.endsWith("jsonl")))
      expect((await fs.stat(path.join(dir, name))).size).toBeLessThanOrEqual(
        30,
      );
  });
  test("independent process writers do not share active file names", async () => {
    const dir = await folder();
    const a = createRotatingReviewSink(dir),
      b = createRotatingReviewSink(dir);
    await Promise.all([a('{"a":1}\n'), b('{"b":1}\n')]);
    expect(await fs.readdir(dir)).toHaveLength(2);
  });
});

describe("bounded diagnostic HTTP", () => {
  test("streams enforce the byte cap without trusting Content-Length", async () => {
    await expect(
      readReviewRequestBody(
        new Request("http://localhost", {
          method: "POST",
          body: "x".repeat(9000),
        }),
      ),
    ).rejects.toBeInstanceOf(ReviewBodyError);
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-length": "99999" },
      body: "{}",
    });
    await expect(readReviewRequestBody(request)).rejects.toBeInstanceOf(
      ReviewBodyError,
    );
    expect(
      await readReviewRequestBody(
        new Request("http://localhost", {
          method: "POST",
          body: '{"ok":true}',
        }),
      ),
    ).toEqual({ ok: true });
  });
  test("exception endpoint accepts fixed valid results and rejects malformed/large bodies", async () => {
    const request = (body: unknown) =>
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const valid = {
      operation_id: crypto.randomUUID(),
      diagnostics: client(),
      duration_ms: 15,
      result: "unknown",
    };
    expect((await POST(request(valid))).status).toBe(204);
    expect((await POST(request({ ...valid, duration_ms: -1 }))).status).toBe(
      400,
    );
    expect(
      (await POST(request({ ...valid, result: "arbitrary" }))).status,
    ).toBe(400);
    expect((await POST(request({ x: "x".repeat(3000) }))).status).toBe(413);
    const status = await GET().json();
    expect(status).toHaveProperty("dropped");
    expect(status).not.toHaveProperty("directory");
  });
  test("exception floods are rate-limited and counted", async () => {
    let limited = 0;
    for (let index = 0; index < 125; index++) {
      const response = await POST(
        new Request("http://localhost", { method: "POST", body: "{}" }),
      );
      if (response.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    expect(
      (await GET().json()).client_results_rate_limited,
    ).toBeGreaterThanOrEqual(limited);
  });
});

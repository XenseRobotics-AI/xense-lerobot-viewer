// Invoked by bun test after transpiling the production helpers into a temp dir.
// No uncaughtException/unhandledRejection handlers: either must fail this process.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEventListeners } from "node:events";
import {
  setTimeout as delay,
  setImmediate as tick,
} from "node:timers/promises";

assert.equal(
  process.versions.bun,
  undefined,
  "Run this suite with actual Node",
);
const modules = process.env.XENSE_STREAM_TEST_DIR;
const { createFileResponse, createFileBody } = await import(
  pathToFileURL(path.join(modules, "file-response.mjs"))
);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "viewer-stream-fixtures-"),
);
const filePath = path.join(root, "video.mp4");
const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
await fs.writeFile(filePath, bytes);
after(() => fs.rm(root, { recursive: true, force: true }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function assertDetached(signal) {
  for (let i = 0; i < 200 && getEventListeners(signal, "abort").length; i++) {
    await delay(2);
  }
  assert.equal(
    getEventListeners(signal, "abort").length,
    0,
    "abort listeners released",
  );
}
function assertSourceDetached(source) {
  assert.equal(source.closed, true, "file descriptor closed");
  for (const event of ["data", "end", "error", "close"]) {
    assert.equal(source.listenerCount(event), 0, event + " listeners released");
  }
}

// Node 18's Readable.toWeb adapter double-closes when cancellation happens
// after EOF but before the file descriptor closes. Exercise both listener
// orderings with actual fs streams, without suppressing process exceptions.
for (const action of ["cancel body", "cancel reader", "abort request"]) {
  for (const ordering of ["before", "after"]) {
    test(
      "file: " + action + " at EOF (" + ordering + " end listener)",
      async () => {
        const controller = new AbortController();
        const source = createReadStream(filePath, { start: 0, end: 3 });
        const completed = deferred();
        let body, reader;
        const finish = () => {
          assert.equal(source.closed, false, "EOF precedes descriptor close");
          if (action === "abort request") {
            controller.abort();
            completed.resolve();
          } else {
            const cancellation = reader ? reader.cancel() : body.cancel();
            completed.resolve(cancellation);
          }
        };
        if (ordering === "before") source.once("end", finish);
        body = createFileBody(source, controller.signal);
        if (ordering === "after") source.once("end", finish);
        const response = new Response(body);
        if (action === "cancel reader") reader = response.body.getReader();
        const consumed =
          action === "abort request"
            ? assert.rejects(response.arrayBuffer(), { name: "AbortError" })
            : undefined;
        const lateData = source.listeners("data")[0];
        const lateError = source.listeners("error")[0];
        const lateEnd = source.listeners("end").find((fn) => fn !== finish);
        await completed.promise;
        await consumed;
        if (!source.closed)
          await new Promise((resolve) => source.once("close", resolve));
        // Already queued callbacks must not enqueue or close after cancellation.
        lateData(Buffer.from("late"));
        lateError(new Error("late failure"));
        lateEnd();
        if (reader) reader.releaseLock();
        await tick();
        assertSourceDetached(source);
        await assertDetached(controller.signal);
      },
    );
  }
}

test("file: consumer backpressure bounds reads and cancellation closes the fd", async () => {
  const controller = new AbortController();
  const source = createReadStream(filePath, { highWaterMark: 65536 });
  const firstData = new Promise((resolve) => source.once("data", resolve));
  const body = createFileBody(source, controller.signal);
  await firstData;
  await tick();
  assert.equal(source.isPaused(), true);
  assert.ok(source.bytesRead <= 2 * 65536, "read-ahead remains bounded");
  await body.cancel();
  assertSourceDetached(source);
  await assertDetached(controller.signal);
});

test("file: unexpected source closure remains a transport error", async () => {
  const controller = new AbortController();
  const source = createReadStream(filePath);
  const response = new Response(createFileBody(source, controller.signal));
  source.destroy();
  await assert.rejects(response.arrayBuffer(), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
  assertSourceDetached(source);
  await assertDetached(controller.signal);
});

test("file: empty files finish once and release all listeners", async () => {
  const empty = path.join(root, "empty.mp4");
  await fs.writeFile(empty, "");
  const controller = new AbortController();
  const source = createReadStream(empty);
  const response = new Response(createFileBody(source, controller.signal));
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assertSourceDetached(source);
  await assertDetached(controller.signal);
});

for (const status of [200, 206]) {
  const range = status === 206 ? { start: 2, end: 5 } : undefined;
  test("file " + status + ": complete bytes and cleanup", async () => {
    const controller = new AbortController();
    const response = createFileResponse(
      filePath,
      controller.signal,
      { status },
      range,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      range ? bytes.subarray(2, 6) : bytes,
    );
    await assertDetached(controller.signal);
  });
  test("file " + status + ": pre-aborted requests open no file", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = createFileResponse(
      path.join(root, "missing"),
      controller.signal,
      { status },
      range,
    );
    assert.equal(response.status, 499);
    assert.equal(response.body, null);
    await tick();
    await assertDetached(controller.signal);
  });
  test(
    "file " +
      status +
      ": abort at signal subscription does not disturb the body",
    async () => {
      const controller = new AbortController();
      const subscribe = controller.signal.addEventListener.bind(
        controller.signal,
      );
      controller.signal.addEventListener = (...args) => {
        subscribe(...args);
        controller.abort();
      };
      const response = createFileResponse(
        filePath,
        controller.signal,
        { status },
        range,
      );
      await assert.rejects(response.arrayBuffer(), { name: "AbortError" });
      await assertDetached(controller.signal);
    },
  );
  test("file " + status + ": abort after response construction", async () => {
    const controller = new AbortController();
    const response = createFileResponse(
      filePath,
      controller.signal,
      { status },
      range,
    );
    controller.abort();
    await assert.rejects(response.arrayBuffer(), { name: "AbortError" });
    await assertDetached(controller.signal);
  });
  test(
    "file " +
      status +
      ": reader cancellation closes file without cancelling request",
    async () => {
      const controller = new AbortController();
      const response = createFileResponse(
        filePath,
        controller.signal,
        { status },
        range,
      );
      await response.body.cancel(new Error("page changed"));
      assert.equal(controller.signal.aborted, false);
      await assertDetached(controller.signal);
    },
  );
}

test("file: abort in the middle of a transfer", async () => {
  const controller = new AbortController();
  const response = createFileResponse(filePath, controller.signal, {
    status: 200,
  });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await tick();
  await assert.rejects(reader.read(), { name: "AbortError" });
  reader.releaseLock();
  await assertDetached(controller.signal);
});
test("file: real I/O errors remain observable and release listeners", async () => {
  const controller = new AbortController();
  const response = createFileResponse(
    path.join(root, "missing"),
    controller.signal,
    { status: 200 },
  );
  await assert.rejects(response.arrayBuffer(), { code: "ENOENT" });
  await assertDetached(controller.signal);
});
test("file: constructor failure releases the opened stream", async () => {
  const controller = new AbortController();
  assert.throws(
    () => createFileResponse(filePath, controller.signal, { status: 204 }),
    TypeError,
  );
  await assertDetached(controller.signal);
  await tick();
});
test("file: repeated rapid aborts leave no request listeners", async () => {
  const controllers = [];
  const reads = [];
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = createFileResponse(filePath, controller.signal, {
      status: 200,
    });
    controller.abort();
    reads.push(assert.rejects(response.arrayBuffer(), { name: "AbortError" }));
  }
  await Promise.all(reads);
  await Promise.all(
    controllers.map((controller) => assertDetached(controller.signal)),
  );
});

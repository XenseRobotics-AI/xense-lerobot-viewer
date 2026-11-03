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
import { spawn } from "node:child_process";
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
const { createTaskStreamResponse } = await import(
  pathToFileURL(path.join(modules, "task-stream-response.mjs"))
);
const { SharedAbortableTaskPool } = await import(
  pathToFileURL(path.join(modules, "shared-abortable-task.mjs"))
);
const { createBackgroundProcessResponse } = await import(
  pathToFileURL(path.join(modules, "background-process-response.mjs"))
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
const taskOptions = { timeoutMs: 5000, timeoutMessage: "Diagnosis timed out" };

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

test("task stream: pre-aborted request starts no work", async () => {
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  const response = createTaskStreamResponse(
    controller.signal,
    async () => {
      runs++;
    },
    taskOptions,
  );
  assert.equal(response.status, 499);
  await tick();
  assert.equal(runs, 0);
});
test("task stream: cancellation before start skips work", async () => {
  const controller = new AbortController();
  let runs = 0;
  const response = createTaskStreamResponse(
    controller.signal,
    async () => {
      runs++;
    },
    taskOptions,
  );
  await response.body.cancel();
  await tick();
  assert.equal(runs, 0);
  await assertDetached(controller.signal);
});
test("task stream: reader cancellation tolerates late progress and rejection", async () => {
  const controller = new AbortController();
  const pending = deferred();
  const started = deferred();
  let jobSignal, emit;
  const response = createTaskStreamResponse(
    controller.signal,
    async (send, signal) => {
      emit = send;
      jobSignal = signal;
      started.resolve();
      await pending.promise;
    },
    taskOptions,
  );
  await started.promise;
  await response.body.cancel();
  assert.equal(jobSignal.aborted, true);
  emit({ type: "progress" });
  pending.reject(new Error("late disk failure"));
  await tick();
  controller.abort();
  await assertDetached(controller.signal);
});
test("task stream: request cancellation closes even when work is awaiting I/O", async () => {
  const controller = new AbortController();
  const pending = deferred();
  const response = createTaskStreamResponse(
    controller.signal,
    async () => pending.promise,
    taskOptions,
  );
  await tick();
  controller.abort();
  assert.equal(await response.text(), "");
  pending.resolve();
  await tick();
  await assertDetached(controller.signal);
});
test("task stream: timeout emits one error and aborts unfinished work", async () => {
  const controller = new AbortController();
  const pending = deferred();
  let jobSignal;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const response = createTaskStreamResponse(
      controller.signal,
      async (_emit, signal) => {
        jobSignal = signal;
        await pending.promise;
      },
      { ...taskOptions, timeoutMs: 10 },
    );
    assert.deepEqual(JSON.parse(await response.text()), {
      type: "error",
      error: taskOptions.timeoutMessage,
    });
    assert.equal(jobSignal.reason.name, "TimeoutError");
    pending.resolve();
    await tick();
    await assertDetached(controller.signal);
  } finally {
    clearTimeout(keepAlive);
  }
});
test("task stream: actual task failures are not hidden as cancellations", async () => {
  const controller = new AbortController();
  const response = createTaskStreamResponse(
    controller.signal,
    async () => {
      throw new Error("disk offline");
    },
    taskOptions,
  );
  assert.deepEqual(JSON.parse(await response.text()), {
    type: "error",
    error: "disk offline",
  });
  await assertDetached(controller.signal);
});

test("shared task: cancelling one subscriber preserves the other's work", async () => {
  const pool = new SharedAbortableTaskPool();
  const first = new AbortController(),
    second = new AbortController();
  const pending = deferred();
  let runs = 0,
    jobSignal;
  const work = async (signal) => {
    runs++;
    jobSignal = signal;
    return pending.promise;
  };
  const a = pool.run("same", first.signal, work, taskOptions);
  const b = pool.run("same", second.signal, work, taskOptions);
  await tick();
  first.abort();
  await assert.rejects(a, { name: "AbortError" });
  assert.equal(jobSignal.aborted, false);
  pending.resolve(42);
  assert.equal(await b, 42);
  assert.equal(runs, 1);
  assert.equal(jobSignal.aborted, false);
  await assertDetached(first.signal);
  await assertDetached(second.signal);
});
test("shared task: last cancellation stops old work without evicting its replacement", async () => {
  const pool = new SharedAbortableTaskPool();
  const controller = new AbortController();
  const old = deferred(),
    fresh = deferred();
  let oldSignal,
    runs = 0;
  const a = pool.run(
    "same",
    controller.signal,
    async (signal) => {
      oldSignal = signal;
      return old.promise;
    },
    taskOptions,
  );
  await tick();
  controller.abort();
  await assert.rejects(a, { name: "AbortError" });
  assert.equal(oldSignal.aborted, true);
  const work = async () => {
    runs++;
    return fresh.promise;
  };
  const b = pool.run("same", new AbortController().signal, work, taskOptions);
  old.resolve(1);
  await tick();
  const c = pool.run("same", new AbortController().signal, work, taskOptions);
  fresh.resolve(2);
  assert.deepEqual(await Promise.all([b, c]), [2, 2]);
  assert.equal(runs, 1);
});
test("shared task: pre-aborted subscriber creates no job", async () => {
  const pool = new SharedAbortableTaskPool();
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  await assert.rejects(
    pool.run(
      "same",
      controller.signal,
      async () => {
        runs++;
      },
      taskOptions,
    ),
    { name: "AbortError" },
  );
  assert.equal(runs, 0);
});
test("shared task: timeout reaches all subscribers without waiting for I/O", async () => {
  const pool = new SharedAbortableTaskPool();
  const pending = deferred();
  let jobSignal;
  const work = async (signal) => {
    jobSignal = signal;
    return pending.promise;
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const a = pool.run("same", new AbortController().signal, work, {
      ...taskOptions,
      timeoutMs: 10,
    });
    const b = pool.run("same", new AbortController().signal, work, taskOptions);
    await Promise.all([
      assert.rejects(a, { name: "TimeoutError" }),
      assert.rejects(b, { name: "TimeoutError" }),
    ]);
    assert.equal(jobSignal.reason.name, "TimeoutError");
    pending.reject(new Error("late failure"));
    await tick();
  } finally {
    clearTimeout(keepAlive);
  }
});

test(
  "background write: cancelled readers resume paused stdout and retain the lock until exit",
  { timeout: 5000 },
  async () => {
    const controller = new AbortController();
    const finished = deferred();
    const marker = path.join(root, "completed-write.json");
    let child,
      releases = 0;
    const response = createBackgroundProcessResponse(
      () => {
        child = spawn(process.execPath, [
          "-e",
          "const fs=require('node:fs'); const line=JSON.stringify({type:'progress',value:'x'.repeat(4096)})+'\\n'; for(let i=0;i<1000;i++) process.stdout.write(line); process.stdout.write(JSON.stringify({type:'result'})+'\\n',()=>fs.writeFileSync(process.argv[1],'complete'));",
          marker,
        ]);
        return child;
      },
      () => {
        releases++;
        finished.resolve();
      },
      controller.signal,
    );
    await delay(100);
    assert.equal(
      child.stdout.isPaused(),
      true,
      "slow reader applies backpressure",
    );
    assert.equal(releases, 0, "write lease is still held");
    await response.body.cancel();
    assert.equal(child.killed, false);
    assert.equal(
      releases,
      0,
      "reader cancellation does not release write lease",
    );
    await finished.promise;
    assert.equal(releases, 1);
    assert.equal(await fs.readFile(marker, "utf8"), "complete");
    await assertDetached(controller.signal);
  },
);
test(
  "background write: request disconnect detaches output and lets writes finish",
  { timeout: 5000 },
  async () => {
    const controller = new AbortController();
    const finished = deferred();
    let child,
      releases = 0;
    const response = createBackgroundProcessResponse(
      () => {
        child = spawn(process.execPath, [
          "-e",
          "setTimeout(()=>process.stdout.write(JSON.stringify({type:'result'})+'\\n'),50)",
        ]);
        return child;
      },
      () => {
        releases++;
        finished.resolve();
      },
      controller.signal,
    );
    controller.abort();
    assert.equal(await response.text(), "");
    assert.equal(child.killed, false);
    assert.equal(releases, 0);
    await finished.promise;
    assert.equal(releases, 1);
    await assertDetached(controller.signal);
  },
);
test("background write: pre-aborted requests do not spawn a subprocess", () => {
  const controller = new AbortController();
  controller.abort();
  let spawns = 0,
    releases = 0;
  const response = createBackgroundProcessResponse(
    () => {
      spawns++;
      throw new Error("unexpected spawn");
    },
    () => {
      releases++;
    },
    controller.signal,
  );
  assert.equal(response.status, 499);
  assert.equal(spawns, 0);
  assert.equal(releases, 1);
});
test("background write: launch errors close output and release lease exactly once", async () => {
  const controller = new AbortController();
  const finished = deferred();
  let releases = 0;
  const response = createBackgroundProcessResponse(
    () => spawn(path.join(root, "missing-executable")),
    () => {
      releases++;
      finished.resolve();
    },
    controller.signal,
  );
  const event = JSON.parse(await response.text());
  assert.equal(event.type, "error");
  await finished.promise;
  assert.equal(releases, 1);
  await assertDetached(controller.signal);
});
test("background write: real subprocess failures remain visible", async () => {
  const controller = new AbortController();
  const finished = deferred();
  const response = createBackgroundProcessResponse(
    () =>
      spawn(process.execPath, [
        "-e",
        "process.stderr.write('disk unavailable');process.exitCode=1",
      ]),
    () => finished.resolve(),
    controller.signal,
  );
  assert.deepEqual(JSON.parse(await response.text()), {
    type: "error",
    error: "disk unavailable",
  });
  await finished.promise;
  await assertDetached(controller.signal);
});

test("task stream: invalid event serialization is reported as a task error", async () => {
  const controller = new AbortController();
  const response = createTaskStreamResponse(
    controller.signal,
    async (emit) => {
      const event = {};
      event.circular = event;
      emit(event);
    },
    taskOptions,
  );
  const event = JSON.parse(await response.text());
  assert.equal(event.type, "error");
  assert.match(event.error, /circular/i);
  await assertDetached(controller.signal);
});

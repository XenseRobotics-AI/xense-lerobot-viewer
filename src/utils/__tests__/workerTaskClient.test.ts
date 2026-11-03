import { expect, test } from "bun:test";
import {
  WorkerTaskClient,
  WorkerUnavailableError,
  SupersededWorkerTaskError,
  type TaskWorker,
} from "../workerTaskClient";
class FakeWorker implements TaskWorker {
  onmessage: TaskWorker["onmessage"] = null;
  onerror: TaskWorker["onerror"] = null;
  onmessageerror: TaskWorker["onmessageerror"] = null;
  sent: { id: number; input: string }[] = [];
  terminated = false;
  postMessage(message: unknown) {
    this.sent.push(message as { id: number; input: string });
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: string, id = this.sent.at(-1)!.id) {
    this.onmessage?.({ data: { id, data } } as MessageEvent);
  }
  error() {
    this.onerror?.({ preventDefault() {} } as ErrorEvent);
  }
}
function setup(extra: { maxQueued?: number; timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const client = new WorkerTaskClient<string, string>({
    create: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    idleMs: 15,
    ...extra,
  });
  return { client, workers };
}

test("decoder gives latest queued selection priority without overlapping a channel", async () => {
  const { client, workers } = setup();
  const one = client.run("one"),
    two = client.run("two"),
    three = client.run("three");
  const worker = workers[0];
  expect(worker.sent.map((m) => m.input)).toEqual(["one"]);
  worker.reply("1");
  expect(await one).toBe("1");
  expect(worker.sent.map((m) => m.input)).toEqual(["one", "three"]);
  worker.reply("3");
  expect(await three).toBe("3");
  worker.reply("2");
  expect(await two).toBe("2");
});
test("independent worker clients do not share a queue", async () => {
  const front = setup(),
    back = setup();
  const a = front.client.run("current"),
    b = back.client.run("speculative");
  front.workers[0].reply("ready");
  expect(await a).toBe("ready");
  expect(back.workers[0].terminated).toBe(false);
  back.workers[0].reply("warm");
  expect(await b).toBe("warm");
});
test("obsolete queue is bounded while its active read is preserved", async () => {
  const { client, workers } = setup({ maxQueued: 1 });
  const active = client.run("active");
  const old = client.run("old").catch((error: unknown) => error);
  const next = client.run("next");
  expect(await old).toBeInstanceOf(SupersededWorkerTaskError);
  expect(workers[0].terminated).toBe(false);
  workers[0].reply("a");
  await active;
  workers[0].reply("n");
  expect(await next).toBe("n");
});
test("idle expiry does not terminate an active read and permits lazy restart", async () => {
  const { client, workers } = setup();
  const read = client.run("read");
  await Bun.sleep(30);
  expect(workers[0].terminated).toBe(false);
  workers[0].reply("done");
  await read;
  await Bun.sleep(30);
  expect(workers[0].terminated).toBe(true);
  const next = client.run("next");
  expect(workers).toHaveLength(2);
  workers[1].reply("new");
  expect(await next).toBe("new");
});
test("stale responses cannot resolve another task", async () => {
  const { client, workers } = setup();
  const read = client.run("read");
  const worker = workers[0];
  worker.reply("late", 99);
  worker.reply("correct");
  expect(await read).toBe("correct");
});
test("real decode errors reject without disabling a healthy channel", async () => {
  const { client, workers } = setup();
  const read = client.run("bad");
  workers[0].onmessage?.({
    data: { id: 1, error: "Corrupt parquet" },
  } as MessageEvent);
  await expect(read).rejects.toThrow("Corrupt parquet");
  const next = client.run("good");
  workers[0].reply("good");
  expect(await next).toBe("good");
  expect(workers).toHaveLength(1);
});
test("worker failure rejects active and queued jobs exactly once for controlled fallback", async () => {
  const { client, workers } = setup();
  const first = client.run("one").catch((e: unknown) => e),
    second = client.run("two").catch((e: unknown) => e);
  workers[0].error();
  expect(await first).toBeInstanceOf(WorkerUnavailableError);
  expect(await second).toBeInstanceOf(WorkerUnavailableError);
  expect(workers[0].terminated).toBe(true);
  await expect(client.run("retry")).rejects.toBeInstanceOf(
    WorkerUnavailableError,
  );
});
test("unavailable Worker constructor permits controlled fallback", async () => {
  const client = new WorkerTaskClient<string, string>({
    create: () => {
      throw new Error("CSP");
    },
    idleMs: 10,
  });
  await expect(client.run("read")).rejects.toBeInstanceOf(
    WorkerUnavailableError,
  );
});
test("decoder deadline is distinct from tab visibility and allows a retry", async () => {
  const { client, workers } = setup({ timeoutMs: 15 });
  const first = client.run("stuck");
  await expect(first).rejects.toThrow("deadline exceeded");
  expect(workers[0].terminated).toBe(true);
  const next = client.run("retry");
  workers[1].reply("success");
  expect(await next).toBe("success");
});

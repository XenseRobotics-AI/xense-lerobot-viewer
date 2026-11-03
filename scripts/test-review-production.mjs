// Run against a production build using temporary fixtures only.
import {
  saveReviewWithDeadline,
  ReviewSaveUnknownError,
  ReviewRejectedError,
  clientReviewDiagnostics,
} from "../src/utils/reviewDiagnosticsClient.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const nodeBin = process.env.NODE_BIN || "node";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "review-closure-http-"));
const dataTemp = process.env.REVIEW_TEST_DATA_PARENT
  ? await fs.mkdtemp(
      path.join(
        path.resolve(process.env.REVIEW_TEST_DATA_PARENT),
        ".xense-review-validation-",
      ),
    )
  : tmp;
const root = path.join(dataTemp, "datasets"),
  dataset = path.join(root, "nested", "sample"),
  logDir = path.join(tmp, "logs");
await fs.mkdir(path.join(dataset, "meta"), { recursive: true });
await fs.mkdir(path.join(root, ".xense-viewer"), { recursive: true });
await fs.writeFile(
  path.join(dataset, "meta", "info.json"),
  JSON.stringify({ total_episodes: 2, total_frames: 60, fps: 30 }),
);
await fs.writeFile(
  path.join(root, ".xense-viewer", "reviewers.json"),
  JSON.stringify(["Closure Fixture", "Second Fixture"]),
);
const checks = [];
const servers = [];
let server,
  output = "",
  base;
async function stop() {
  const p = servers.pop();
  if (!p) return;
  server = servers.at(-1);
  const exited = new Promise((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) resolve();
    else p.once("exit", resolve);
  });
  p.kill("SIGTERM");
  let timeout;
  await Promise.race([
    exited,
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 4000);
    }),
  ]);
  clearTimeout(timeout);
  if (p.exitCode === null && p.signalCode === null) {
    p.kill("SIGKILL");
    await exited;
  }
}
async function start(logTarget) {
  const reservation = net.createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  output = "";
  server = spawn(
    nodeBin,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOCAL_DATASET_ROOT: root,
        REVIEW_DIAGNOSTICS_ENABLED: "1",
        REVIEW_DIAGNOSTICS_DIR: logTarget,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  servers.push(server);
  server.on("error", (error) => {
    output = String(error);
  });
  server.stdout.on("data", (x) => (output = (output + x).slice(-65536)));
  server.stderr.on("data", (x) => (output = (output + x).slice(-65536)));
  const url = "http://127.0.0.1:" + port;
  const startupDeadline = Date.now() + 15000;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(url + "/api/review-diagnostics", {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return url;
    } catch {}
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(output);
    if (Date.now() >= startupDeadline) break;
    await Bun.sleep(100);
  }
  throw new Error("Startup timed out: " + output);
}
const route =
  "/api/local-datasets/" +
  Buffer.from(dataset).toString("base64url") +
  "/reviews";
async function get(id) {
  const r = await fetch(base + route + (id ? "?operation_id=" + id : ""), {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function put(body, status = 200) {
  const r = await fetch(base + route, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(r.status, status, await r.clone().text());
  assert.ok(r.headers.get("X-Review-Request-Id"));
  assert.ok(r.headers.get("X-Review-Build"));
  return r.json();
}
const payload = (reviewed, episode_index = 0) => ({
  reviewer: "Closure Fixture",
  episode_index,
  reviewed,
  source: "episodes",
  ...(reviewed ? { stay_ms: 0, episode_duration_ms: 2000 } : {}),
  operation_id: crypto.randomUUID(),
});
try {
  base = await start(logDir);
  const mark = payload(true);
  let body = await put(mark);
  assert.equal(body.episodes["0"][0].stay_ms, 0);
  let state = await get(mark.operation_id);
  assert.equal(state.operation.state, "succeeded");
  assert.equal(state.file.episodes["0"][0].operation_id, mark.operation_id);
  checks.push("real mark and zero-duration snapshot with confirmed receipt");
  const reviewFile = path.join(root, ".xense-viewer", "episode-reviews.json");
  const before = await fs.stat(reviewFile);
  await put(mark);
  const after = await fs.stat(reviewFile);
  assert.equal(after.mtimeMs, before.mtimeMs);
  checks.push("duplicate operation does not rewrite business file");
  const conflict = await put(
    { ...payload(false), operation_id: mark.operation_id },
    409,
  );
  assert.equal(conflict.code, "OPERATION_CONFLICT");
  checks.push("same operation id cannot change action");
  const unmark = payload(false);
  await put(unmark);
  state = await get(unmark.operation_id);
  assert.equal(state.operation.state, "succeeded");
  assert.equal(state.file.episodes["0"], undefined);
  checks.push("real unmark confirmed by receipt rather than empty file alone");
  const finalMark = payload(true, 1);
  await put(finalMark);
  const rosterFile = path.join(root, ".xense-viewer", "reviewers.json");
  const savedRoster = await fs.readFile(rosterFile, "utf8");
  const savedReviews = await fs.readFile(reviewFile, "utf8");
  let rejectedPuts = 0;
  const verifyRejected = async (body, expectedStatus) => {
    const fetcher = async (url, init) => {
      if (init?.method === "PUT") {
        rejectedPuts++;
        const response = await fetch(url, init);
        assert.equal(response.status, expectedStatus);
        await response.text();
        throw new TypeError("Lost rejection response");
      }
      return fetch(url, init);
    };
    const outcome = await saveReviewWithDeadline(
      base + route,
      {
        ...body,
        diagnostics: clientReviewDiagnostics(
          body.reviewed ? "not_ready" : "unmark",
        ),
      },
      { fetcher },
    ).catch((error) => error);
    assert.ok(outcome instanceof ReviewRejectedError);
    assert.equal(await fs.readFile(reviewFile, "utf8"), savedReviews);
    const evidence = await (
      await fetch(base + route + "?verify=1&operation_id=" + body.operation_id)
    ).json();
    assert.equal(evidence.operation.state, "failed");
  };
  await fs.writeFile(rosterFile, JSON.stringify(["Second Fixture"]));
  await verifyRejected(payload(false, 1), 400);
  assert.equal(rejectedPuts, 1);
  checks.push(
    "a lost rejection for a removed reviewer is terminal and preserves existing reviews",
  );
  await fs.writeFile(rosterFile, "{broken configuration");
  await verifyRejected(payload(true, 0), 500);
  assert.equal(rejectedPuts, 2);
  assert.equal((await fetch(base + route)).status, 500);
  assert.equal((await fetch(base + route + "?verify=1")).status, 400);
  checks.push(
    "proof-only verification survives corrupt rosters while ordinary reads still report configuration errors",
  );
  await fs.writeFile(rosterFile, savedRoster);
  await Bun.sleep(1400);
  const health = await (await fetch(base + "/api/review-diagnostics")).json();
  assert.equal(health.dropped, 0);
  assert.equal(health.write_failures, 0);
  assert.ok(health.written >= 6);
  const logs = await fs.readdir(logDir);
  let events = [];
  for (const file of logs) {
    if (file.endsWith(".jsonl")) {
      const raw = await fs.readFile(path.join(logDir, file), "utf8");
      assert.ok(!raw.includes("Closure Fixture"));
      assert.ok(!raw.includes(root));
      events.push(
        ...raw
          .trim()
          .split(String.fromCharCode(10))
          .filter(Boolean)
          .map(JSON.parse),
      );
    }
  }
  assert.ok(
    events.some(
      (x) =>
        x.operation_id === finalMark.operation_id &&
        x.event === "completed" &&
        x.store?.committed,
    ),
  );
  checks.push("asynchronous anonymized logs and commit evidence");

  const firstBase = base,
    secondBase = await start(logDir);
  const lostResponse = async (url, init) => {
    if (init?.method === "PUT") {
      const response = await fetch(firstBase + route, init);
      assert.equal(response.status, 200);
      await response.text();
      throw new TypeError("Lost after commit");
    }
    const readUrl = new URL(String(url));
    return fetch(secondBase + readUrl.pathname + readUrl.search, init);
  };
  const crossMark = {
    ...payload(true),
    diagnostics: clientReviewDiagnostics("present"),
  };
  const crossResult = await saveReviewWithDeadline(
    firstBase + route,
    crossMark,
    { fetcher: lostResponse, timeoutMs: 5000, reconcileMs: 5000 },
  );
  assert.equal(
    crossResult.episodes["0"][0].operation_id,
    crossMark.operation_id,
  );
  const crossUnmark = {
    ...payload(false),
    diagnostics: clientReviewDiagnostics("unmark"),
  };
  await assert.rejects(
    saveReviewWithDeadline(firstBase + route, crossUnmark, {
      fetcher: lostResponse,
      timeoutMs: 5000,
      reconcileMs: 5000,
    }),
    ReviewSaveUnknownError,
  );
  checks.push(
    "two real processes reconcile a persistent mark but never infer an unmark from missing remote receipt",
  );
  const concurrentMark = payload(true),
    peerMark = { ...payload(true), reviewer: "Second Fixture" };
  await Promise.all([
    put(concurrentMark),
    (async () => {
      const response = await fetch(secondBase + route, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(peerMark),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      await response.json();
    })(),
  ]);
  const merged = await get();
  assert.deepEqual(
    new Set(merged.file.episodes["0"].map((record) => record.reviewer)),
    new Set(["Closure Fixture", "Second Fixture"]),
  );
  checks.push(
    "concurrent production processes merge both reviewers without lost updates",
  );
  await stop();
  const beforeStall = await fs.readFile(reviewFile, "utf8");
  const stalledStatus = await new Promise((resolve, reject) => {
    const code =
      "const {request}=require('node:http');const timer=setTimeout(()=>{console.error('Upload deadline exceeded');process.exit(1)},15000);const req=request(process.argv[1],{method:'PUT',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>{clearTimeout(timer);console.log(res.statusCode);req.destroy()})});req.on('error',error=>{clearTimeout(timer);console.error(error.message);process.exit(1)});req.write('{');req.flushHeaders();";
    const client = spawn(nodeBin, ["-e", code, base + route], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let result = "",
      error = "";
    client.stdout.on("data", (chunk) => (result += chunk));
    client.stderr.on("data", (chunk) => (error += chunk));
    client.once("error", reject);
    client.once("close", (status) =>
      status === 0
        ? resolve(Number(result.trim()))
        : reject(new Error(error || "Upload client failed")),
    );
  });
  assert.equal(stalledStatus, 408);
  assert.equal(await fs.readFile(reviewFile, "utf8"), beforeStall);
  checks.push(
    "real partial upload terminates with HTTP 408 without creating a review",
  );

  await stop();
  base = await start(logDir);
  state = await get(unmark.operation_id);
  assert.equal(state.operation, undefined);
  state = await get(finalMark.operation_id);
  assert.equal(state.operation, undefined);
  assert.equal(
    state.file.episodes["1"][0].operation_id,
    finalMark.operation_id,
  );
  checks.push(
    "restart loses transient receipts without fabricating outcomes and preserves mark operation id",
  );
  await stop();
  const blocked = path.join(tmp, "not-a-directory");
  await fs.writeFile(blocked, "fixture");
  base = await start(blocked);
  const withLogFailure = payload(false, 1);
  await put(withLogFailure);
  state = await get(withLogFailure.operation_id);
  assert.equal(state.operation.state, "succeeded");
  assert.equal(state.file.episodes["1"], undefined);
  await Bun.sleep(1400);
  const failedLogHealth = await (
    await fetch(base + "/api/review-diagnostics")
  ).json();
  assert.ok(failedLogHealth.write_failures > 0);
  assert.ok(failedLogHealth.dropped > 0);
  checks.push(
    "unwritable diagnostic directory cannot block business save or receipt",
  );
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks,
        events: events.length,
        health,
        failedLogHealth,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("Completed checks:", checks);
  console.error(output);
  throw error;
} finally {
  while (servers.length) await stop();
  await fs.rm(tmp, { recursive: true, force: true });
  if (dataTemp !== tmp) await fs.rm(dataTemp, { recursive: true, force: true });
}

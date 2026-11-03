// Real Chromium checks for React review state and stay-time lifecycle.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(
  path.join(os.tmpdir(), "xense-review-lifecycle-"),
);
let server, browser, socket;
try {
  const chrome =
    process.env.CHROME_BIN ||
    ["google-chrome", "chromium", "chromium-browser"]
      .map((name) => Bun.which(name))
      .find(Boolean);
  assert.ok(chrome, "Install Chrome/Chromium or set CHROME_BIN");
  const built = await Bun.build({
    entrypoints: [
      path.join(repo, "scripts/fixtures/review-save-lifecycle.jsx"),
    ],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  });
  assert.ok(built.success, JSON.stringify(built.logs));
  const bundle = await built.outputs[0].text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/app.js")
        return new Response(bundle, {
          headers: { "content-type": "application/javascript" },
        });
      return new Response(
        '<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.reviewBrowserErrors=[];addEventListener("error",e=>reviewBrowserErrors.push(e.message));addEventListener("unhandledrejection",e=>reviewBrowserErrors.push(String(e.reason)));</script><script type="module" src="/app.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const profile = path.join(temp, "chrome");
  browser = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let active;
  for (let i = 0; i < 150; i++) {
    try {
      active = await fs.readFile(
        path.join(profile, "DevToolsActivePort"),
        "utf8",
      );
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  assert.ok(active, "Chrome did not start");
  const [port, endpoint] = active.trim().split("\n");
  socket = new WebSocket("ws://127.0.0.1:" + port + endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Browser command timed out: " + method));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const target = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  await call("Target.activateTarget", { targetId: target.targetId });
  await call("Page.enable", {}, sessionId);
  await call(
    "Page.navigate",
    { url: "http://127.0.0.1:" + server.port },
    sessionId,
  );
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await call(
      "Runtime.evaluate",
      {
        expression: "typeof window.runReviewLifecycleTests==='function'",
        returnByValue: true,
      },
      sessionId,
    );
    if (value.result?.value) {
      ready = true;
      break;
    }
    await Bun.sleep(50);
  }
  assert.ok(ready, "Browser fixture failed to initialize");
  const result = await call(
    "Runtime.evaluate",
    {
      expression: "window.runReviewLifecycleTests()",
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  assert.equal(result.result.value.result, "passed");
  const old = await call(
    "Runtime.evaluate",
    { expression: "window.reviewFixtureInstance", returnByValue: true },
    sessionId,
  );
  await call("Page.reload", {}, sessionId);
  let reloaded = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await call(
        "Runtime.evaluate",
        {
          expression:
            "!!window.reviewFixtureInstance && window.reviewFixtureInstance!==" +
            JSON.stringify(old.result.value) +
            " && typeof window.runReviewReloadTests==='function'",
          returnByValue: true,
        },
        sessionId,
      );
      if (value.result?.value) {
        reloaded = true;
        break;
      }
    } catch {
      /* The old execution context may have just been destroyed. */
    }
    await Bun.sleep(50);
  }
  assert.ok(reloaded, "Browser fixture failed to reload");
  const recovery = await call(
    "Runtime.evaluate",
    {
      expression: "window.runReviewReloadTests()",
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  assert.ok(
    !recovery.exceptionDetails,
    JSON.stringify(recovery.exceptionDetails),
  );
  assert.equal(recovery.result.value.result, "passed");
  console.log(
    JSON.stringify(
      {
        ...result.result.value,
        checks: [
          ...result.result.value.checks,
          ...recovery.result.value.checks,
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      try {
        socket.send(
          JSON.stringify({
            id: Number.MAX_SAFE_INTEGER,
            method: "Browser.close",
          }),
        );
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  socket?.close();
  server?.stop(true);
  if (browser) {
    browser.kill();
    await browser.exited;
  }
  await fs.rm(temp, { recursive: true, force: true });
}

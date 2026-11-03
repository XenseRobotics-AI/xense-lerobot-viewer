import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EpisodeReviewsProvider,
  useEpisodeReviews,
} from "../../src/context/episode-reviews-context";
import { useEpisodeStayTime } from "../../src/hooks/use-episode-stay-time";
import { makeLocalRepoId } from "../../src/utils/datasetRoute";
import { reviewSaveKey } from "../../src/utils/reviewSaveQueue";

const states = new Map();
const calls = [];
const backend = { mode: "normal", deferred: [] };
const getState = (key) => {
  if (!states.has(key))
    states.set(key, {
      file: { version: 1, episodes: {} },
      operations: new Map(),
    });
  return states.get(key);
};
function complete(state, payload, succeeded) {
  state.operations.set(payload.operation_id, {
    operation_id: payload.operation_id,
    episode_index: payload.episode_index,
    reviewer: payload.reviewer,
    reviewed: payload.reviewed,
    state: succeeded ? "succeeded" : "failed",
  });
  if (!succeeded) return;
  const key = String(payload.episode_index);
  const records = (state.file.episodes[key] ?? []).filter(
    (entry) => entry.reviewer !== payload.reviewer,
  );
  if (payload.reviewed)
    records.push({
      reviewer: payload.reviewer,
      source: payload.source,
      reviewed_at: "2026-11-03T12:00:00+08:00",
      operation_id: payload.operation_id,
      ...(payload.stay_ms !== undefined
        ? {
            stay_ms: payload.stay_ms,
            episode_duration_ms: payload.episode_duration_ms,
          }
        : {}),
    });
  if (records.length) state.file.episodes[key] = records;
  else delete state.file.episodes[key];
}
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.href);
  if (url.pathname === "/api/review-diagnostics")
    return new Response(null, { status: 204 });
  const state = getState(url.pathname);
  if (init.method === "PUT") {
    const payload = JSON.parse(init.body);
    calls.push({ endpoint: url.pathname, payload });
    state.operations.set(payload.operation_id, {
      operation_id: payload.operation_id,
      episode_index: payload.episode_index,
      reviewer: payload.reviewer,
      reviewed: payload.reviewed,
      state: "pending",
    });
    if (backend.mode === "hold")
      throw new TypeError("Simulated lost response while server is pending");
    if (backend.mode === "deferred")
      await new Promise((resolve) => backend.deferred.push(resolve));
    complete(state, payload, true);
    return Response.json(state.file);
  }
  return Response.json({
    file: state.file,
    profiles: [
      { name: "Alice", role: "inspector" },
      { name: "Bob", role: "admin" },
    ],
    reviewers: ["Alice", "Bob"],
    storage_path: "/fixture/reviews.json",
    dataset_key: ".",
    operation: state.operations.get(url.searchParams.get("operation_id")),
  });
};

const timerKey =
  "xense-episode-stay:" + JSON.stringify(["timer-fixture", "Alice", 0]);
sessionStorage.setItem(
  timerKey,
  JSON.stringify({ stay_ms: 4000, episode_duration_ms: 10000 }),
);
function StayHarness() {
  const [ready, setReady] = useState(false);
  const stay = useEpisodeStayTime({
    datasetKey: "timer-fixture",
    episodeId: 0,
    reviewer: "Alice",
    durationSeconds: 10,
    enabled: ready,
    reviewSurfaceReady: ready,
  });
  useEffect(() => {
    window.stayFixture = { ...stay, setReady };
  });
  return null;
}
function ReviewHarness() {
  const state = useEpisodeReviews();
  useEffect(() => {
    window.reviewFixture = state;
  });
  return <output>{state.loaded ? "ready" : "loading"}</output>;
}
function App() {
  const [scope, setScope] = useState("/fixture-a");
  useEffect(() => {
    window.switchReviewScope = setScope;
  }, []);
  return (
    <>
      <StayHarness />
      <EpisodeReviewsProvider
        repoId={makeLocalRepoId(scope)}
        browsePath="/fixture"
      >
        <ReviewHarness />
      </EpisodeReviewsProvider>
    </>
  );
}
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, message) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error("Timed out: " + message);
}
const latest = (episode, reviewed = true) =>
  calls.findLast(
    (call) =>
      call.payload.episode_index === episode &&
      call.payload.reviewed === reviewed,
  );
function finishCall(call, succeeded) {
  complete(getState(call.endpoint), call.payload, succeeded);
}
window.runReviewLifecycleTests = async () => {
  const checks = [];
  await until(
    () => window.reviewFixture?.loaded && window.stayFixture,
    "provider load",
  );
  ensure(
    JSON.parse(sessionStorage.getItem(timerKey)).stay_ms === 4000,
    "unready mount overwrote restored stay",
  );
  ensure(
    window.stayFixture.readStaySnapshot() === undefined,
    "unready visit fabricated a snapshot",
  );
  window.stayFixture.setReady(true);
  await until(
    () => window.stayFixture.readStaySnapshot()?.stay_ms >= 4000,
    "stay restoration",
  );
  await sleep(30);
  window.dispatchEvent(new Event("pagehide"));
  const paused = window.stayFixture.readStayMs();
  await sleep(150);
  ensure(
    window.stayFixture.readStayMs() === paused,
    "pagehide did not pause stay time",
  );
  window.dispatchEvent(new Event("pageshow"));
  await sleep(30);
  ensure(
    window.stayFixture.readStayMs() > paused,
    "pageshow did not resume stay time",
  );
  checks.push("restore-before-ready and page lifecycle");

  await window.reviewFixture.mark(
    9,
    "episodes",
    true,
    window.stayFixture.readStaySnapshot(),
    window.stayFixture.readDiagnostics(),
  );
  await until(
    () => window.reviewFixture.file.episodes["9"]?.length === 1,
    "normal save",
  );
  ensure(latest(9).payload.stay_ms >= 4000, "save lost restored snapshot");
  checks.push("normal save and diagnostic snapshot");

  backend.mode = "hold";
  const zero = reviewSaveKey(0, "Alice"),
    one = reviewSaveKey(1, "Alice");
  await window.reviewFixture.mark(0, "episodes", true);
  await until(
    () => window.reviewFixture.uncertainSaves[zero],
    "first unknown save",
  );
  await window.reviewFixture.mark(1, "episodes", true);
  await until(
    () => window.reviewFixture.uncertainSaves[one],
    "second unknown save",
  );
  const before = calls.length;
  await window.reviewFixture.mark(0, "episodes", true);
  ensure(calls.length === before, "unknown save was blindly retried");
  await window.reviewFixture.refresh(zero);
  ensure(
    window.reviewFixture.uncertainSaves[zero],
    "pending receipt unlocked a save",
  );
  checks.push("unknown latch and pending verification");

  finishCall(latest(0), true);
  await window.reviewFixture.refresh(zero);
  await until(
    () => !window.reviewFixture.uncertainSaves[zero],
    "exact save verification",
  );
  ensure(
    window.reviewFixture.uncertainSaves[one] &&
      window.reviewFixture.saveErrors[one],
    "verifying one save cleared another unknown",
  );
  finishCall(latest(1), false);
  await window.reviewFixture.refresh(one);
  await until(
    () =>
      !window.reviewFixture.uncertainSaves[one] &&
      window.reviewFixture.saveErrors[one],
    "terminal failure verification",
  );
  backend.mode = "normal";
  await window.reviewFixture.mark(1, "episodes", true);
  await until(
    () =>
      window.reviewFixture.file.episodes["1"]?.length &&
      !window.reviewFixture.saveErrors[one],
    "explicit retry after terminal failure",
  );
  checks.push("targeted verification and retry after ended error");

  backend.mode = "hold";
  await window.reviewFixture.mark(0, "episodes", false);
  await until(
    () => window.reviewFixture.uncertainSaves[zero],
    "unmark response loss",
  );
  await window.reviewFixture.refresh(zero);
  ensure(
    window.reviewFixture.uncertainSaves[zero],
    "pending unmark was confirmed from absence",
  );
  finishCall(latest(0, false), true);
  await window.reviewFixture.refresh(zero);
  await until(
    () =>
      !window.reviewFixture.uncertainSaves[zero] &&
      !window.reviewFixture.file.episodes["0"],
    "completed unmark verification",
  );
  checks.push("unmark response-loss closure");

  const four = reviewSaveKey(4, "Alice");
  await window.reviewFixture.mark(4, "episodes", true);
  await until(
    () => window.reviewFixture.uncertainSaves[four],
    "missing receipt setup",
  );
  const missing = latest(4);
  getState(missing.endpoint).operations.delete(missing.payload.operation_id);
  await window.reviewFixture.refresh(four);
  ensure(
    window.reviewFixture.uncertainSaves[four],
    "missing receipt was mistaken for completion",
  );
  checks.push("missing receipt stays unknown");

  backend.mode = "deferred";
  const saving = window.reviewFixture.mark(6, "episodes", true);
  await until(() => backend.deferred.length > 0, "captured old-scope save");
  const oldEndpoint = window.reviewFixture.endpoint;
  window.switchReviewScope("/fixture-b");
  await until(
    () =>
      window.reviewFixture.loaded &&
      window.reviewFixture.endpoint !== oldEndpoint,
    "new scope load",
  );
  backend.deferred.shift()();
  await saving;
  await sleep(50);
  ensure(
    !window.reviewFixture.file.episodes["6"],
    "late old-scope response changed the new scope",
  );
  ensure(
    latest(6).endpoint === new URL(oldEndpoint, location.href).pathname,
    "queued write retargeted after navigation",
  );
  ensure(
    window.reviewBrowserErrors.length === 0,
    "browser errors: " + window.reviewBrowserErrors.join("; "),
  );
  checks.push("captured target and late response after scope navigation");
  return { result: "passed", checks, put_requests: calls.length };
};

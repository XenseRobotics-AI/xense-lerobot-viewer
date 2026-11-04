import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EpisodeReviewsProvider,
  useEpisodeReviews,
} from "../../src/context/episode-reviews-context";
import { useEpisodeStayTime } from "../../src/hooks/use-episode-stay-time";
import { makeLocalRepoId } from "../../src/utils/datasetRoute";
import { reviewSaveKey } from "../../src/utils/reviewSaveQueue";
import { REVIEW_PENDING_STORAGE_KEY } from "../../src/utils/reviewPendingOperations";
import EpisodeReviewPanel from "../../src/components/episode-review-panel";
import { LocaleProvider } from "../../src/context/locale-context";

window.reviewFixtureInstance = crypto.randomUUID();

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
  const receipt = {
    operation_id: payload.operation_id,
    episode_index: payload.episode_index,
    reviewer: payload.reviewer,
    reviewed: payload.reviewed,
    source: payload.source,
    ...(payload.stay_ms === undefined
      ? {}
      : {
          stay_ms: payload.stay_ms,
          episode_duration_ms: payload.episode_duration_ms,
        }),
    state: succeeded ? "succeeded" : "failed",
  };
  state.operations.set(payload.operation_id, receipt);
  state.file.operation_receipts = [
    ...(state.file.operation_receipts ?? []),
    receipt,
  ].slice(-4096);
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
  if (backend.mode === "hang-read") {
    backend.hangingReads = (backend.hangingReads ?? 0) + 1;
    return new Promise(() => {});
  }
  if (url.searchParams.get("verify") === "1")
    return Response.json({
      file: state.file,
      operation: state.operations.get(url.searchParams.get("operation_id")),
    });
  const profiles = backend.profiles ?? [
    { name: "Alice", role: "inspector" },
    { name: "Bob", role: "admin" },
  ];
  return Response.json({
    file: state.file,
    profiles,
    reviewers:
      backend.mode === "malformed-read"
        ? undefined
        : profiles.map((profile) => profile.name),
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
  return (
    <>
      <output>{state.loaded ? "ready" : "loading"}</output>
      <EpisodeReviewPanel
        episodeId={7}
        source="episodes"
        disabled={false}
        episodeDurationMs={10000}
        readStayMs={() => 0}
        readStaySnapshot={() => undefined}
        readDiagnostics={() => window.stayFixture.readDiagnostics()}
      />
    </>
  );
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
    <LocaleProvider initialLocale="en">
      <App />
    </LocaleProvider>
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
  throw new Error(
    "Timed out: " +
      message +
      " " +
      JSON.stringify({
        loaded: window.reviewFixture?.loaded,
        reviewer: window.reviewFixture?.reviewer,
        error: window.reviewFixture?.error,
        saveErrors: window.reviewFixture?.saveErrors,
        pending: window.reviewFixture?.pendingSaves,
        uncertain: window.reviewFixture?.uncertainSaves,
        browserErrors: window.reviewBrowserErrors,
        puts: calls.length,
      }),
  );
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

  const scopeBeforeReturn = window.reviewFixture.endpoint;
  window.switchReviewScope("/fixture-other");
  await until(
    () =>
      window.reviewFixture.loaded &&
      window.reviewFixture.endpoint !== scopeBeforeReturn,
    "leave uncertain scope",
  );
  window.switchReviewScope("/fixture-a");
  await until(
    () =>
      window.reviewFixture.loaded &&
      window.reviewFixture.endpoint === scopeBeforeReturn,
    "return to uncertain scope",
  );
  ensure(
    window.reviewFixture.uncertainSaves[four],
    "returning to a scope lost its uncertain operation guard",
  );
  const callsBeforeReturn = calls.length;
  await window.reviewFixture.mark(4, "episodes", true);
  ensure(
    calls.length === callsBeforeReturn,
    "returning to a scope resubmitted an unknown operation",
  );
  checks.push("return navigation preserves unresolved operation guards");

  backend.mode = "deferred";
  const dispatchedSave = window.reviewFixture.mark(11, "episodes", true);
  await until(
    () => backend.deferred.length > 0,
    "dispatched save before page exit",
  );
  const queuedSave = window.reviewFixture.mark(12, "episodes", true);
  window.dispatchEvent(new Event("pagehide"));
  backend.deferred.shift()();
  await Promise.all([dispatchedSave, queuedSave]);
  await until(
    () => window.reviewFixture.saveErrors[reviewSaveKey(12, "Alice")],
    "unsent queue cancellation message",
  );
  ensure(!latest(12), "unsent mark was dispatched after leaving the page");
  ensure(
    !JSON.parse(
      sessionStorage.getItem(REVIEW_PENDING_STORAGE_KEY),
    ).entries.some((entry) => entry.operation.episode_index === 12),
    "unsent mark became an unrecoverable unknown",
  );
  window.dispatchEvent(new Event("pageshow"));
  checks.push(
    "page exit cancels unsent queue entries without losing dispatched operations",
  );

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

window.runReviewReloadTests = async () => {
  await until(() => window.reviewFixture?.loaded, "reloaded provider");
  const key = reviewSaveKey(4, "Alice");
  ensure(
    window.reviewFixture.uncertainSaves[key],
    "full reload lost its unknown operation guard",
  );
  await window.reviewFixture.refresh(key);
  ensure(
    window.reviewFixture.uncertainSaves[key],
    "reload inferred success from an empty backend",
  );
  await window.reviewFixture.mark(4, "episodes", false);
  ensure(calls.length === 0, "reload replayed an unresolved operation");

  backend.mode = "malformed-read";
  await window.reviewFixture.refresh();
  await until(() => window.reviewFixture.error, "malformed metadata surfaced");
  ensure(
    window.reviewFixture.reviewers.length === 2,
    "malformed response corrupted the previous roster",
  );
  backend.mode = "normal";
  await window.reviewFixture.refresh();
  await until(() => !window.reviewFixture.error, "valid metadata recovery");

  backend.mode = "hang-read";
  const automatic = window.reviewFixture.refresh();
  await until(() => backend.hangingReads > 0, "hanging automatic refresh");
  backend.mode = "normal";
  await window.reviewFixture.refresh(key);
  await automatic;
  ensure(
    window.reviewFixture.uncertainSaves[key],
    "interrupted refresh released an unknown operation",
  );

  const recovered = JSON.parse(
    sessionStorage.getItem(REVIEW_PENDING_STORAGE_KEY),
  ).entries.find((entry) => entry.operation.episode_index === 4);
  ensure(recovered, "recovery evidence disappeared");
  complete(
    getState(new URL(window.reviewFixture.endpoint, location.href).pathname),
    recovered.operation,
    true,
  );
  await window.reviewFixture.refresh(key);
  await until(
    () => !window.reviewFixture.uncertainSaves[key],
    "late commit after reload",
  );
  await window.reviewFixture.mark(7, "episodes", true);
  await until(
    () => window.reviewFixture.file.episodes["7"],
    "healthy save after recovered reads",
  );
  backend.mode = "hold";
  await window.reviewFixture.mark(8, "episodes", true);
  await window.reviewFixture.mark(10, "episodes", true);
  const eight = reviewSaveKey(8, "Alice"),
    ten = reviewSaveKey(10, "Alice");
  await until(
    () =>
      window.reviewFixture.uncertainSaves[eight] &&
      window.reviewFixture.uncertainSaves[ten],
    "removed reviewer unknown operations",
  );
  backend.mode = "normal";
  backend.profiles = [{ name: "Bob", role: "admin" }];
  await window.reviewFixture.refresh();
  await until(
    () => window.reviewFixture.reviewer === "Bob",
    "reviewer removed from roster",
  );
  const beforeVerification = calls.length;
  const verify = (episode) => {
    const operation = latest(episode).payload.operation_id;
    const row = document.querySelector(
      `[data-review-operation-id="${operation}"]`,
    );
    ensure(row, "no recovery entry for removed reviewer on another episode");
    const button = row.querySelector("button");
    ensure(
      button && !button.disabled,
      "recovery button cannot verify a removed reviewer",
    );
    button.click();
  };
  finishCall(latest(8), true);
  verify(8);
  await until(
    () => !window.reviewFixture.uncertainSaves[eight],
    "removed reviewer independent verification",
  );
  ensure(
    window.reviewFixture.uncertainSaves[ten],
    "orphan verification cleared a different target",
  );
  await until(
    () =>
      document
        .querySelector('[data-review-verification-result="succeeded"]')
        ?.textContent.includes("Alice"),
    "orphan success result was not visible",
  );
  ensure(
    calls.length === beforeVerification,
    "orphan verification replayed a write",
  );
  backend.profiles = [];
  await window.reviewFixture.refresh();
  await until(() => window.reviewFixture.reviewer === "", "empty roster");
  backend.mode = "malformed-read";
  await window.reviewFixture.refresh();
  await until(
    () => window.reviewFixture.error,
    "corrupt roster normal refresh error",
  );
  const pendingMessage = window.reviewFixture.saveErrors[ten];
  verify(10);
  await until(
    () => window.reviewFixture.saveErrors[ten] !== pendingMessage,
    "pending receipt verification finished",
  );
  ensure(
    window.reviewFixture.uncertainSaves[ten],
    "empty roster accepted a pending receipt",
  );
  finishCall(latest(10), false);
  verify(10);
  await until(
    () => !window.reviewFixture.uncertainSaves[ten],
    "empty roster recovery",
  );
  await until(
    () =>
      document
        .querySelector('[data-review-verification-result="failed"]')
        ?.textContent.includes("Alice"),
    "orphan terminal failure disappeared without a visible result",
  );
  ensure(
    calls.length === beforeVerification,
    "empty roster verification replayed a write",
  );
  ensure(
    window.reviewFixture.error,
    "proof-only verification incorrectly cleared a metadata error",
  );
  backend.mode = "normal";
  await window.reviewFixture.refresh();
  await until(
    () => !window.reviewFixture.error,
    "roster configuration repaired",
  );
  backend.profiles = [
    { name: "Alice", role: "inspector" },
    { name: "Bob", role: "admin" },
  ];
  await window.reviewFixture.refresh();
  await until(
    () => window.reviewFixture.reviewer === "Alice",
    "restore inspectors for durable recovery",
  );
  await window.reviewFixture.mark(14, "episodes", true);
  backend.mode = "hold";
  await window.reviewFixture.mark(14, "episodes", false);
  const unmarkKey = reviewSaveKey(14, "Alice");
  await until(
    () => window.reviewFixture.uncertainSaves[unmarkKey],
    "unmark unknown before simulated restart",
  );
  const unmark = latest(14, false);
  finishCall(unmark, true);
  getState(unmark.endpoint).operations.clear();
  const beforeRecovery = calls.length;
  backend.mode = "normal";
  await window.reviewFixture.refresh(unmarkKey);
  await until(
    () => !window.reviewFixture.uncertainSaves[unmarkKey],
    "durable unmark after transient receipt loss",
  );
  ensure(
    !window.reviewFixture.file.episodes["14"],
    "unmark readback restored a removed mark",
  );
  ensure(
    calls.length === beforeRecovery,
    "durable recovery replayed the write",
  );
  ensure(
    !JSON.parse(
      sessionStorage.getItem(REVIEW_PENDING_STORAGE_KEY),
    ).entries.some(
      (entry) => entry.operation.operation_id === unmark.payload.operation_id,
    ),
    "confirmed unmark remains in browser recovery storage",
  );
  ensure(
    window.reviewBrowserErrors.length === 0,
    "browser errors after reload: " + window.reviewBrowserErrors.join("; "),
  );
  return {
    result: "passed",
    checks: [
      "full reload retains guards without replay",
      "malformed metadata preserves previous UI state and recovers",
      "manual verification interrupts hanging automatic refresh",
      "late commit after reload can be verified and later saves continue",
      "removed reviewers and other episodes retain independent recovery controls",
      "targeted recovery preserves other guards without replaying writes",
      "an empty roster does not hide pending-operation verification",
      "orphan verification reports success and terminal failure while pending stays protected",
      "proof-only verification works during roster failure without hiding metadata errors",
      "durable unmark evidence releases guards after transient receipts disappear",
    ],
  };
};

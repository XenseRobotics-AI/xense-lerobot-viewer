import { afterAll, describe, expect, test } from "bun:test";
import { createCoalescedSeeker } from "../coalescedSeek";
import {
  VideoFramePresentation,
  seekVideoWithFrameGate,
  type VideoFrameState,
} from "../videoFramePresentation";

const previousMedia = globalThis.HTMLMediaElement;
const previousRequestFrame = globalThis.requestAnimationFrame;
const previousCancelFrame = globalThis.cancelAnimationFrame;
Object.defineProperty(globalThis, "HTMLMediaElement", {
  configurable: true,
  value: { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 },
});
let nextFrameId = 0;
const scheduledFrames = new Map<number, FrameRequestCallback>();
globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextFrameId;
  scheduledFrames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  scheduledFrames.delete(id);
};
function paintTwoFrames() {
  for (let pass = 0; pass < 2; pass++) {
    const current = [...scheduledFrames];
    scheduledFrames.clear();
    for (const [, callback] of current) callback(16 * (pass + 1));
  }
}
function paintOneFrame() {
  const current = [...scheduledFrames];
  scheduledFrames.clear();
  for (const [, callback] of current) callback(16);
}
afterAll(() => {
  scheduledFrames.clear();
  Object.defineProperty(globalThis, "HTMLMediaElement", {
    configurable: true,
    value: previousMedia,
  });
  if (previousRequestFrame)
    globalThis.requestAnimationFrame = previousRequestFrame;
  else
    delete (globalThis as { requestAnimationFrame?: unknown })
      .requestAnimationFrame;
  if (previousCancelFrame)
    globalThis.cancelAnimationFrame = previousCancelFrame;
  else
    delete (globalThis as { cancelAnimationFrame?: unknown })
      .cancelAnimationFrame;
});

class MockVideo extends EventTarget {
  ownerDocument = { baseURI: "http://viewer.test/" } as Document;
  paused = true;
  readyState = 0;
  seeking = false;
  error: MediaError | null = null;
  preload = "";
  loads = 0;
  playbacks = new Map<
    number,
    (now: number, info: { mediaTime: number }) => void
  >();
  private time = 0;
  private address = "";
  private callbackId = 0;
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    if (this.readyState >= 1) this.seeking = true;
  }
  get src() {
    return this.address;
  }
  set src(value: string) {
    this.address = new URL(value, this.ownerDocument.baseURI).href;
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loads++;
    this.readyState = 0;
    this.time = 0;
  }
  requestVideoFrameCallback(
    callback: (now: number, info: { mediaTime: number }) => void,
  ) {
    const id = ++this.callbackId;
    this.playbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number) {
    this.playbacks.delete(id);
  }
  presentFrame() {
    const callbacks = [...this.playbacks.values()];
    this.playbacks.clear();
    callbacks.forEach((callback) => callback(16, { mediaTime: this.time }));
  }
  finishSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
}

function setup() {
  const video = new MockVideo() as unknown as HTMLVideoElement & MockVideo;
  const states: VideoFrameState[] = [];
  const presentation = new VideoFramePresentation(video, (state) =>
    states.push(state),
  );
  const load = (source: string, identity: string, target = 0) =>
    presentation.update(source, identity, target, false);
  const readyAt = (target = 0) => {
    video.readyState = 2;
    video.dispatchEvent(new Event("loadedmetadata"));
    video.currentTime = target;
    video.finishSeek();
  };
  return { video, states, presentation, load, readyAt };
}

describe("video frame presentation", () => {
  test("distinguishes file reading from decoding and shows a new source's first loaded frame without extra RAFs", () => {
    const { video, states, presentation, load } = setup();
    load("/camera.mp4", "dataset-a:episode-0");
    expect(states.at(-1)).toEqual({ phase: "loading", stage: "fetching" });
    video.readyState = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(states.at(-1)).toEqual({ phase: "loading", stage: "decoding" });
    video.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));
    expect(states.at(-1)?.phase).toBe("ready");
    expect(video.playbacks.size).toBe(0);
    expect(video.loads).toBe(1);
    presentation.dispose();
  });

  test("first-data events never reveal a mismatched episode segment", () => {
    const { video, states, presentation, load } = setup();
    load("/camera.mp4", "dataset-a:episode-1", 12);
    video.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));
    expect(states.at(-1)?.phase).toBe("loading");
    expect(video.seeking).toBe(true);
    video.finishSeek();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("an explicit return to zero still validates its requested frame", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-0", 12);
    readyAt(12);
    video.presentFrame();
    seekVideoWithFrameGate(video, 0);
    video.finishSeek();
    video.dispatchEvent(new Event("loadeddata"));
    expect(states.at(-1)?.phase).toBe("loading");
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });
  test("recovers when slow decoding misses the first RAF pair and no compositor callback arrives", async () => {
    const { video, states, presentation, load } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    video.readyState = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    paintTwoFrames();
    expect(states.at(-1)?.phase).toBe("loading");
    // No further media event or requestVideoFrameCallback reaches the gate.
    video.readyState = 2;
    await new Promise((resolve) => setTimeout(resolve, 300));
    paintTwoFrames();
    expect(states.at(-1)?.phase).toBe("ready");
    expect(video.loads).toBe(1);
    expect(video.seeking).toBe(false);
    presentation.dispose();
  });

  test("a fallback retry never reveals the previous source after a switch", async () => {
    const { states, presentation, load, readyAt } = setup();
    load("/camera-a.mp4", "dataset-a:episode-3");
    paintTwoFrames();
    load("/camera-b.mp4", "dataset-a:episode-4", 12);
    await new Promise((resolve) => setTimeout(resolve, 300));
    paintTwoFrames();
    expect(states.at(-1)?.phase).toBe("loading");
    readyAt(12);
    paintTwoFrames();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("disposal cancels low-frequency readiness retries", async () => {
    const { states, presentation, load } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    paintTwoFrames();
    const count = states.length;
    presentation.dispose();
    await new Promise((resolve) => setTimeout(resolve, 300));
    paintTwoFrames();
    expect(states).toHaveLength(count);
  });

  test("retains the decoded frame during drift recovery but gates an explicit seek", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    const count = states.length;
    seekVideoWithFrameGate(video, 2, { retainFrame: true });
    expect(video.seeking).toBe(true);
    expect(states).toHaveLength(count);
    video.finishSeek();
    video.presentFrame();
    expect(states).toHaveLength(count);
    seekVideoWithFrameGate(video, 4);
    expect(states.at(-1)?.phase).toBe("loading");
    presentation.dispose();
  });

  test("drift recovery never reveals a frame from a previous episode", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    load("/camera.mp4", "dataset-a:episode-4", 20);
    seekVideoWithFrameGate(video, 21, { retainFrame: true });
    expect(states.at(-1)?.phase).toBe("loading");
    video.finishSeek();
    video.finishSeek();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("coalesces slider seeks while keeping the tile covered until the final frame is decoded", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    const seeker = createCoalescedSeeker(video, 0.2, (target) =>
      seekVideoWithFrameGate(video, target),
    );

    for (let target = 1; target <= 20; target++) seeker.request(target);
    expect(video.currentTime).toBe(1);
    expect(states.at(-1)?.phase).toBe("loading");
    video.finishSeek();
    expect(video.currentTime).toBe(20);
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("loading");
    video.finishSeek();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    seeker.dispose();
    presentation.dispose();
  });

  test("keeps a camera covered until a decoded frame matches the requested media time", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3", 15);
    expect(states.at(-1)?.phase).toBe("loading");
    readyAt(15);
    expect(states.at(-1)?.phase).toBe("loading");
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("does not reveal a stale callback or the wrong decoded time after a rapid switch", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera-a.mp4", "dataset-a:episode-3");
    readyAt();
    const staleCallback = [...video.playbacks.values()][0];
    load("/camera-b.mp4", "dataset-a:episode-4", 22);
    staleCallback?.(16, { mediaTime: 0 });
    expect(states.at(-1)?.phase).toBe("loading");
    expect(video.playbacks.size).toBe(1);
    readyAt(20);
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("loading");
    video.currentTime = 22;
    video.finishSeek();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("marks seeks and frame errors before exposing new pixels; retry starts a fresh decode", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");

    seekVideoWithFrameGate(video, 5);
    video.currentTime = 5;
    video.finishSeek();
    expect(states.at(-1)?.phase).toBe("loading");
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");

    video.error = { code: 2 } as MediaError;
    video.dispatchEvent(new Event("error"));
    expect(states.at(-1)?.phase).toBe("error");
    presentation.retry();
    expect(video.loads).toBe(2);
    expect(states.at(-1)?.phase).toBe("loading");
    presentation.dispose();
  });

  test("does not hide the current decoded frame for a playback clock update", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");

    video.paused = false;
    presentation.update("/camera.mp4", "dataset-a:episode-3", 0.2, false);
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("keeps the displayed frame when a pause flush reports a stale playback clock", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    video.currentTime = 0.5;
    video.seeking = false;
    presentation.update("/camera.mp4", "dataset-a:episode-3", 0.2, false);
    expect(states.at(-1)?.phase).toBe("ready");
    expect(video.currentTime).toBe(0.5);
    presentation.dispose();
  });

  test("gates a paused video when the requested time is not decoded yet", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    seekVideoWithFrameGate(video, 2);
    expect(states.at(-1)?.phase).toBe("loading");
    presentation.dispose();
  });

  test("does not flash loading when playback emits a same-time seeking event", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");

    video.seeking = true;
    video.dispatchEvent(new Event("seeking"));
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("a repeated pending seek keeps its decoded-frame callback alive", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    seekVideoWithFrameGate(video, 2);
    video.finishSeek();
    expect(video.playbacks.size).toBe(1);
    seekVideoWithFrameGate(video, 2);
    expect(video.playbacks.size).toBe(1);
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("does not reissue a settled seek for late paused clocks or media events", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    seekVideoWithFrameGate(video, 2);
    video.finishSeek();
    video.currentTime = 2.0089;
    video.seeking = false;
    presentation.update("/camera.mp4", "dataset-a:episode-3", 2, false);
    for (const event of ["loadeddata", "canplay", "seeked", "playing"])
      video.dispatchEvent(new Event(event));
    expect(video.currentTime).toBe(2.0089);
    expect(video.seeking).toBe(false);
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("retains a pending command before metadata despite clock samples", () => {
    const { video, states, presentation, load } = setup();
    load("/camera.mp4", "dataset-a:episode-3", 2);
    presentation.update("/camera.mp4", "dataset-a:episode-3", 9, false);
    video.readyState = 2;
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(2);
    video.finishSeek();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("applies the newest explicit command after an earlier seek settles", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    seekVideoWithFrameGate(video, 2);
    seekVideoWithFrameGate(video, 3);
    expect(video.currentTime).toBe(2);
    video.finishSeek();
    expect(video.currentTime).toBe(3);
    expect(video.seeking).toBe(true);
    video.finishSeek();
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("presents a naturally advanced frame after playback pauses during decode", () => {
    const { video, states, presentation, load, readyAt } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    video.presentFrame();
    seekVideoWithFrameGate(video, 2);
    video.finishSeek();
    video.paused = false;
    video.currentTime = 2.5;
    video.seeking = false;
    presentation.update("/camera.mp4", "dataset-a:episode-3", 2.5, false);
    video.pause();
    presentation.update("/camera.mp4", "dataset-a:episode-3", 1.9, false);
    expect(video.currentTime).toBe(2.5);
    video.presentFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("clock updates between fallback frames do not postpone presentation", () => {
    const { video, states, presentation, load, readyAt } = setup();
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: undefined,
    });
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    paintOneFrame();
    presentation.update("/camera.mp4", "dataset-a:episode-3", 0, false);
    paintOneFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("suspension and disposal suppress late media events without changing source", () => {
    const { video, states, presentation, load } = setup();
    load("/camera.mp4", "dataset-a:episode-3");
    const loads = video.loads;
    presentation.update("/next.mp4", "dataset-a:episode-4", 0, true);
    expect(video.src).toBe("http://viewer.test/camera.mp4");
    expect(video.loads).toBe(loads);
    expect(states.at(-1)?.phase).toBe("loading");
    presentation.dispose();
    const count = states.length;
    video.error = { code: 2 } as MediaError;
    video.dispatchEvent(new Event("error"));
    paintTwoFrames();
    expect(states).toHaveLength(count);
  });

  test("uses two animation frames when decoded-frame callbacks are unavailable", () => {
    const { video, states, presentation, load, readyAt } = setup();
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: undefined,
    });
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();

    paintOneFrame();
    expect(states.at(-1)?.phase).toBe("loading");
    paintOneFrame();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("ignores canceled animation-frame callbacks after a source switch", () => {
    const { video, states, presentation, load, readyAt } = setup();
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: undefined,
    });
    load("/camera-a.mp4", "dataset-a:episode-3");
    const canceledFirstFrame = [...scheduledFrames.values()][0];

    load("/camera-b.mp4", "dataset-a:episode-4");
    canceledFirstFrame?.(16);
    expect(states.at(-1)?.phase).toBe("loading");
    expect(scheduledFrames.size).toBe(1);

    readyAt();
    paintTwoFrames();
    expect(states.at(-1)?.phase).toBe("ready");
    presentation.dispose();
  });

  test("cancels the second fallback frame on disposal", () => {
    const { video, states, presentation, load, readyAt } = setup();
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: undefined,
    });
    load("/camera.mp4", "dataset-a:episode-3");
    readyAt();
    paintOneFrame();
    const canceledSecondFrame = [...scheduledFrames.values()][0];
    const stateCount = states.length;

    presentation.dispose();
    canceledSecondFrame?.(32);
    expect(states).toHaveLength(stateCount);
    expect(states.at(-1)?.phase).toBe("loading");
  });

  test("reports an invalid source as a controlled media error", () => {
    const { video, states, presentation, load } = setup();
    load("   ", "dataset-a:episode-invalid");
    expect(video.loads).toBe(0);
    expect(states.at(-1)?.phase).toBe("error");
    presentation.dispose();
  });
});

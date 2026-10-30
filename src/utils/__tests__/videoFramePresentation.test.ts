import { afterAll, describe, expect, test } from "bun:test";
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
});

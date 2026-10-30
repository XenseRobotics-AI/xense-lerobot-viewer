export type VideoFrameState = {
  phase: "loading" | "ready" | "error";
};

type FrameVideo = HTMLVideoElement & {
  cancelVideoFrameCallback?: (handle: number) => void;
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { mediaTime: number }) => void,
  ) => number;
};

const presentations = new WeakMap<HTMLVideoElement, VideoFramePresentation>();
const FRAME_TOLERANCE_SECONDS = 0.12;

/** Hide a tile before a seek and show it again after the target frame is decoded. */
export function seekVideoWithFrameGate(
  video: HTMLVideoElement,
  targetSeconds: number,
): void {
  const presentation = presentations.get(video);
  if (presentation) presentation.seek(targetSeconds);
  else if (
    video.readyState >= HTMLMediaElement.HAVE_METADATA &&
    Math.abs(video.currentTime - targetSeconds) > 1 / 120
  ) {
    video.currentTime = targetSeconds;
  }
}

export class VideoFramePresentation {
  private source?: string;
  private identity?: string;
  private targetSeconds = 0;
  private generation = 0;
  private suspended = false;
  private pending = true;
  private state: VideoFrameState = { phase: "loading" };
  private frameCallback?: number;
  private rafCallback?: number;
  private disposed = false;

  constructor(
    private video: HTMLVideoElement,
    private onState: (state: VideoFrameState) => void,
  ) {
    presentations.set(video, this);
    video.addEventListener("loadedmetadata", this.onMediaChange);
    video.addEventListener("loadeddata", this.onMediaChange);
    video.addEventListener("canplay", this.onMediaChange);
    video.addEventListener("seeking", this.onMediaChange);
    video.addEventListener("seeked", this.onMediaChange);
    video.addEventListener("playing", this.onMediaChange);
    video.addEventListener("error", this.onError);
  }

  update(
    source: string,
    identity: string,
    targetSeconds: number,
    suspended: boolean,
  ) {
    if (this.disposed) return;
    const nextTarget = Number.isFinite(targetSeconds)
      ? Math.max(0, targetSeconds)
      : 0;
    const sourceChanged = source !== this.source || identity !== this.identity;

    if (suspended) {
      if (!this.suspended) this.begin(nextTarget);
      this.suspended = true;
      this.targetSeconds = nextTarget;
      return;
    }

    this.suspended = false;
    if (sourceChanged) {
      this.begin(nextTarget);
      this.source = source;
      this.identity = identity;
      this.video.pause();
      // Keep the visible element buffering its first playable segment while
      // the poster covers it. This lets play() continue the same media load
      // instead of starting a second request after the warm frame.
      this.video.preload = "auto";
      if (
        this.video.src !==
        new URL(source, this.video.ownerDocument.baseURI).href
      ) {
        this.video.src = source;
        this.video.load();
      }
      this.seekToTarget();
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
      return;
    }

    if (this.state.phase === "error") return;
    const targetChanged = Math.abs(this.targetSeconds - nextTarget) > 1 / 120;
    this.targetSeconds = nextTarget;
    if (targetChanged && this.video.paused) {
      this.begin(nextTarget);
      this.seek(nextTarget);
    } else if (this.pending) {
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
    }
  }

  seek(targetSeconds: number): void {
    if (this.disposed || this.suspended || this.state.phase === "error") return;
    this.targetSeconds = Number.isFinite(targetSeconds)
      ? Math.max(0, targetSeconds)
      : 0;
    if (
      this.pending ||
      Math.abs(this.video.currentTime - this.targetSeconds) > 1 / 120
    ) {
      this.begin(this.targetSeconds);
      this.seekToTarget();
    }
  }

  retry(): void {
    if (this.disposed || !this.source) return;
    this.begin(this.targetSeconds);
    this.video.load();
    this.seekToTarget();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cancelCallbacks();
    this.video.removeEventListener("loadedmetadata", this.onMediaChange);
    this.video.removeEventListener("loadeddata", this.onMediaChange);
    this.video.removeEventListener("canplay", this.onMediaChange);
    this.video.removeEventListener("seeking", this.onMediaChange);
    this.video.removeEventListener("seeked", this.onMediaChange);
    this.video.removeEventListener("playing", this.onMediaChange);
    this.video.removeEventListener("error", this.onError);
    if (presentations.get(this.video) === this)
      presentations.delete(this.video);
  }

  private begin(targetSeconds: number): void {
    this.cancelCallbacks();
    this.generation++;
    this.pending = true;
    this.targetSeconds = targetSeconds;
    this.emit("loading");
  }

  private seekToTarget(): void {
    if (
      this.video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      !this.video.seeking &&
      Math.abs(this.video.currentTime - this.targetSeconds) > 1 / 120
    ) {
      this.video.currentTime = this.targetSeconds;
    }
  }

  private tryPresent(generation: number, mediaTime?: number): void {
    if (
      this.disposed ||
      generation !== this.generation ||
      !this.pending ||
      this.suspended ||
      this.video.seeking ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !this.source ||
      this.video.src !==
        new URL(this.source, this.video.ownerDocument.baseURI).href ||
      Math.abs(this.video.currentTime - this.targetSeconds) >
        FRAME_TOLERANCE_SECONDS ||
      (mediaTime !== undefined &&
        Math.abs(mediaTime - this.video.currentTime) > FRAME_TOLERANCE_SECONDS)
    )
      return;

    this.pending = false;
    this.cancelCallbacks();
    this.emit("ready");
  }

  private scheduleFrameCheck(generation: number): void {
    if (this.disposed || generation !== this.generation || !this.pending)
      return;
    const video = this.video as FrameVideo;
    if (video.requestVideoFrameCallback) {
      if (this.frameCallback !== undefined)
        video.cancelVideoFrameCallback?.(this.frameCallback);
      this.frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
        this.frameCallback = undefined;
        this.tryPresent(generation, metadata.mediaTime);
        if (this.pending) this.scheduleFrameCheck(generation);
      });
      return;
    }

    this.rafCallback = requestAnimationFrame(() => {
      this.rafCallback = requestAnimationFrame(() => {
        this.rafCallback = undefined;
        this.tryPresent(generation);
      });
    });
  }

  private cancelCallbacks(): void {
    const video = this.video as FrameVideo;
    if (this.frameCallback !== undefined) {
      video.cancelVideoFrameCallback?.(this.frameCallback);
      this.frameCallback = undefined;
    }
    if (this.rafCallback !== undefined) {
      cancelAnimationFrame(this.rafCallback);
      this.rafCallback = undefined;
    }
  }

  private emit(phase: VideoFrameState["phase"]): void {
    this.state = { phase };
    this.onState(this.state);
  }

  private onMediaChange = (): void => {
    if (this.disposed || this.suspended) return;
    if (this.video.seeking) {
      this.begin(this.targetSeconds);
      return;
    }
    if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.seekToTarget();
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
    }
  };

  private scheduleRafCheck(generation: number): void {
    if (this.disposed || generation !== this.generation || !this.pending)
      return;
    if (this.rafCallback !== undefined) cancelAnimationFrame(this.rafCallback);
    this.rafCallback = requestAnimationFrame(() => {
      this.rafCallback = requestAnimationFrame(() => {
        this.rafCallback = undefined;
        this.tryPresent(generation);
      });
    });
  }

  private onError = (): void => {
    if (
      this.disposed ||
      this.suspended ||
      this.video.error === null ||
      !this.source ||
      this.video.src !==
        new URL(this.source, this.video.ownerDocument.baseURI).href
    )
      return;
    this.cancelCallbacks();
    this.emit("error");
  };
}

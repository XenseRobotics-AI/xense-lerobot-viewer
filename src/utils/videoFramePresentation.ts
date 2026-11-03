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
  private seekTargetSeconds?: number;
  private hasPlayedSinceSeek = false;
  private generation = 0;
  private suspended = false;
  private pending = true;
  private state: VideoFrameState = { phase: "loading" };
  private frameCallback?: number;
  private frameCheckVersion = 0;
  private rafCallback?: number;
  private rafSecondCallback?: number;
  private rafCheckVersion = 0;
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
      this.seekTargetSeconds = nextTarget;
      return;
    }

    this.suspended = false;
    if (sourceChanged) {
      this.begin(nextTarget);
      this.source = source;
      this.identity = identity;
      const absoluteSource = this.resolveSource(source);
      if (!absoluteSource) {
        this.emit("error");
        return;
      }
      this.video.pause();
      // Keep the visible element buffering its first playable segment so play()
      // can continue the same media load without a second initialization.
      this.video.preload = "auto";
      if (this.video.src !== absoluteSource) {
        this.video.src = source;
        this.video.load();
      }
      this.seekToTarget();
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
      return;
    }

    if (this.state.phase === "error") return;
    // Clock observations do not replace a pending explicit decoder command.
    if (!this.pending) this.targetSeconds = nextTarget;
    if (this.pending) {
      this.seekToTarget();
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
    }
  }

  seek(targetSeconds: number): void {
    if (this.disposed || this.suspended || this.state.phase === "error") return;
    const nextTarget = Number.isFinite(targetSeconds)
      ? Math.max(0, targetSeconds)
      : 0;
    const targetChanged = Math.abs(nextTarget - this.targetSeconds) > 1 / 120;
    this.targetSeconds = nextTarget;
    if (
      this.pending ||
      Math.abs(this.video.currentTime - this.targetSeconds) > 1 / 120
    ) {
      // Repeating the same command must not discard the callback that is
      // already waiting to present its frame. No new seeked event is owed
      // when currentTime is already at that pending target.
      if (!this.pending || targetChanged) this.begin(this.targetSeconds);
      this.seekToTarget();
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
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
    this.seekTargetSeconds = targetSeconds;
    this.hasPlayedSinceSeek = false;
    this.emit("loading");
  }

  private seekToTarget(): void {
    if (this.seekTargetSeconds === undefined) {
      if (!this.video.paused) this.hasPlayedSinceSeek = true;
      return;
    }
    if (
      this.video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      !this.video.seeking
    ) {
      const target = this.seekTargetSeconds;
      this.seekTargetSeconds = undefined;
      this.hasPlayedSinceSeek = !this.video.paused;
      // Native events and clock commits may arrive after a seek has settled.
      // Apply each command once, then wait for its decoded frame without
      // pulling a naturally advancing or newly paused clock back to a row.
      if (Math.abs(this.video.currentTime - target) > 1 / 120)
        this.video.currentTime = target;
    }
  }

  private tryPresent(generation: number, mediaTime?: number): void {
    const absoluteSource = this.source ? this.resolveSource(this.source) : null;
    if (
      this.disposed ||
      generation !== this.generation ||
      !this.pending ||
      this.suspended ||
      this.seekTargetSeconds !== undefined ||
      this.video.seeking ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !absoluteSource ||
      this.video.src !== absoluteSource ||
      (!this.hasPlayedSinceSeek &&
        Math.abs(this.video.currentTime - this.targetSeconds) >
          FRAME_TOLERANCE_SECONDS) ||
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
      if (this.frameCallback !== undefined) return;
      const checkVersion = ++this.frameCheckVersion;
      this.frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
        if (checkVersion !== this.frameCheckVersion) return;
        this.frameCallback = undefined;
        this.tryPresent(generation, metadata.mediaTime);
        if (this.pending) this.scheduleFrameCheck(generation);
      });
    }
  }

  private cancelCallbacks(): void {
    this.frameCheckVersion++;
    this.rafCheckVersion++;
    const video = this.video as FrameVideo;
    if (this.frameCallback !== undefined) {
      video.cancelVideoFrameCallback?.(this.frameCallback);
      this.frameCallback = undefined;
    }
    if (this.rafCallback !== undefined) {
      cancelAnimationFrame(this.rafCallback);
      this.rafCallback = undefined;
    }
    if (this.rafSecondCallback !== undefined) {
      cancelAnimationFrame(this.rafSecondCallback);
      this.rafSecondCallback = undefined;
    }
  }

  private emit(phase: VideoFrameState["phase"]): void {
    this.state = { phase };
    this.onState(this.state);
  }

  private onMediaChange = (): void => {
    if (this.disposed || this.suspended) return;
    // A native seeking event is not a new application command. If a newer
    // command is queued, apply it only after the current native seek settles.
    if (this.video.seeking) return;
    if (
      this.pending &&
      this.video.readyState >= HTMLMediaElement.HAVE_METADATA
    ) {
      this.seekToTarget();
      this.scheduleFrameCheck(this.generation);
      this.scheduleRafCheck(this.generation);
    }
  };

  private scheduleRafCheck(generation: number): void {
    if (this.disposed || generation !== this.generation || !this.pending)
      return;
    // Clock renders and media events may arrive more often than RAF. Keep
    // the scheduled pair instead of endlessly restarting its second frame.
    if (this.rafCallback !== undefined || this.rafSecondCallback !== undefined)
      return;
    const checkVersion = ++this.rafCheckVersion;
    this.rafCallback = requestAnimationFrame(() => {
      if (checkVersion !== this.rafCheckVersion) return;
      this.rafCallback = undefined;
      if (
        this.disposed ||
        generation !== this.generation ||
        !this.pending ||
        this.suspended
      )
        return;
      this.rafSecondCallback = requestAnimationFrame(() => {
        if (checkVersion !== this.rafCheckVersion) return;
        this.rafSecondCallback = undefined;
        if (
          this.disposed ||
          generation !== this.generation ||
          !this.pending ||
          this.suspended
        )
          return;
        this.tryPresent(generation);
      });
    });
  }

  private onError = (): void => {
    const absoluteSource = this.source ? this.resolveSource(this.source) : null;
    if (
      this.disposed ||
      this.suspended ||
      this.video.error === null ||
      !this.source ||
      !absoluteSource ||
      this.video.src !== absoluteSource
    )
      return;
    this.cancelCallbacks();
    this.emit("error");
  };

  private resolveSource(source: string): string | null {
    if (!source.trim()) return null;
    try {
      return new URL(source, this.video.ownerDocument.baseURI).href;
    } catch {
      return null;
    }
  }
}

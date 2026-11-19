/** Correct playback drift without repeatedly decoding from an MP4 keyframe. */
export const REPLAY_VIDEO_SYNC = {
  CHECK_INTERVAL_MS: 250,
  DEADBAND_SECONDS: 0.05,
  HARD_SEEK_SECONDS: 1,
  SEEK_COOLDOWN_MS: 2000,
  MAX_RATE_CHANGE: 0.1,
} as const;

export class ReplayVideoSynchronizer {
  private lastCheck = -Infinity;
  private lastSeek = -Infinity;

  reset(): void {
    this.lastCheck = -Infinity;
    this.lastSeek = -Infinity;
  }

  correct(
    video: HTMLVideoElement,
    targetSeconds: number,
    now: number,
    seek: (target: number) => void,
  ): void {
    if (
      !Number.isFinite(targetSeconds) ||
      !Number.isFinite(now) ||
      video.seeking ||
      video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
      now - this.lastCheck < REPLAY_VIDEO_SYNC.CHECK_INTERVAL_MS
    )
      return;
    this.lastCheck = now;

    const drift = targetSeconds - video.currentTime;
    if (
      Math.abs(drift) >= REPLAY_VIDEO_SYNC.HARD_SEEK_SECONDS &&
      now - this.lastSeek >= REPLAY_VIDEO_SYNC.SEEK_COOLDOWN_MS
    ) {
      this.lastSeek = now;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      seek(targetSeconds);
      return;
    }

    const rate =
      Math.abs(drift) <= REPLAY_VIDEO_SYNC.DEADBAND_SECONDS
        ? 1
        : 1 +
          Math.max(
            -REPLAY_VIDEO_SYNC.MAX_RATE_CHANGE,
            Math.min(REPLAY_VIDEO_SYNC.MAX_RATE_CHANGE, drift * 0.5),
          );
    // Avoid ratechange events and decoder work for insignificant rate changes.
    if (Math.abs(video.playbackRate - rate) >= 0.005) video.playbackRate = rate;
  }
}

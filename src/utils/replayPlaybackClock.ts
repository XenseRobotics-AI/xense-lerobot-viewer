type ClockSample = { frames: number; alpha: number };

/** Preserve fractional rows across play/pause; explicit seeks reset them. */
export class ReplayPlaybackClock {
  private remainder = 0;
  private lastTime: number | undefined;

  start(now: number): void {
    if (this.lastTime === undefined && Number.isFinite(now))
      this.lastTime = now;
  }

  advance(now: number, rowsPerSecond: number): ClockSample {
    if (!Number.isFinite(rowsPerSecond) || rowsPerSecond <= 0)
      return { frames: 0, alpha: 0 };
    if (this.lastTime !== undefined && Number.isFinite(now)) {
      const elapsed = (now - this.lastTime) / 1000;
      this.lastTime = now;
      // A suspended tab or long main-thread stall is not playback time to
      // catch up in a single jump. Retain the fractional row, not the gap.
      if (elapsed > 0 && elapsed < 0.5) this.remainder += elapsed;
    }
    const rows = this.remainder * rowsPerSecond;
    const frames = Math.floor(rows + 1e-9);
    this.remainder = Math.max(0, this.remainder - frames / rowsPerSecond);
    return { frames, alpha: Math.min(this.remainder * rowsPerSecond, 1) };
  }

  pause(now: number, rowsPerSecond: number): ClockSample {
    // Include the last partial RAF interval even if pause happens before the
    // first RAF. Otherwise every quick toggle silently loses another slice.
    const sample = this.advance(now, rowsPerSecond);
    this.lastTime = undefined;
    return sample;
  }

  reset(): void {
    this.remainder = 0;
    this.lastTime = undefined;
  }
}

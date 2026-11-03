import type { EpisodeStaySnapshot } from "@/types/episode-review.types";

type EpisodeStayTotal = EpisodeStaySnapshot;

export function parseStoredEpisodeStayMs(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return 0;
    const stayMs = (parsed as { stay_ms?: unknown }).stay_ms;
    return Number.isSafeInteger(stayMs) && (stayMs as number) >= 0
      ? (stayMs as number)
      : 0;
  } catch {
    return 0;
  }
}

export function shouldTrackEpisodeStay(input: {
  pageHidden: boolean;
  episodeReady: boolean;
  reviewerSelected: boolean;
  reviewSurfaceReady: boolean;
}): boolean {
  return (
    !input.pageHidden &&
    input.episodeReady &&
    input.reviewerSelected &&
    input.reviewSurfaceReady
  );
}

function elapsedMilliseconds(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.floor(Math.max(0, now - startedAt));
}

/** Accumulates foreground time per episode and caps it at twice its duration. */
export class EpisodeStayTimer {
  private totals = new Map<string, EpisodeStayTotal>();
  private active: { key: string; startedAt: number } | null = null;

  start(
    key: string,
    episodeDurationMs: number,
    now: number,
    initialStayMs = 0,
  ): void {
    if (this.active?.key === key) return;
    this.pause(now);
    const duration =
      Number.isSafeInteger(episodeDurationMs) &&
      Number.isSafeInteger(episodeDurationMs * 2)
        ? Math.max(0, episodeDurationMs)
        : 0;
    const previous = this.totals.get(key);
    const restored = Number.isSafeInteger(initialStayMs)
      ? Math.max(0, initialStayMs)
      : 0;
    const total: EpisodeStayTotal = {
      episode_duration_ms: duration,
      stay_ms: Math.min(previous?.stay_ms ?? restored, duration * 2),
    };
    this.totals.set(key, total);
    if (duration > 0) this.active = { key, startedAt: now };
  }

  pause(now: number): void {
    if (!this.active) return;
    const total = this.totals.get(this.active.key);
    if (total) {
      const elapsed = elapsedMilliseconds(this.active.startedAt, now);
      total.stay_ms = Math.min(
        total.stay_ms + elapsed,
        total.episode_duration_ms * 2,
      );
    }
    this.active = null;
  }

  read(key: string, now: number): EpisodeStaySnapshot {
    const total = this.totals.get(key);
    if (!total) return { stay_ms: 0, episode_duration_ms: 0 };
    const activeElapsed =
      this.active?.key === key
        ? elapsedMilliseconds(this.active.startedAt, now)
        : 0;
    return {
      episode_duration_ms: total.episode_duration_ms,
      stay_ms: Math.min(
        total.stay_ms + activeElapsed,
        total.episode_duration_ms * 2,
      ),
    };
  }
}

/**
 * Coalesce rapid seeks on a single media element.
 *
 * Dragging the playback slider fires a seek on every `input` event. Writing
 * `video.currentTime` while the element is still seeking makes the browser
 * abort the in-flight seek and start decoding again from the previous
 * keyframe. With eight cameras on screen (1080p wrist + 1280×960 head since
 * 2026-11) the decoders never catch up and the tiles freeze until the user
 * pauses and plays again.
 *
 * Rule: at most one seek in flight per element. A request that arrives while
 * a seek is running only replaces the pending target; when the running seek
 * lands (`seeked`), the element jumps once to the newest target. Intermediate
 * slider positions are dropped, the final one is always honoured.
 */

/** The subset of HTMLMediaElement this needs (kept small so tests can fake it). */
export interface SeekableMedia {
  currentTime: number;
  readonly seeking: boolean;
  addEventListener(type: "seeked", listener: () => void): void;
  removeEventListener(type: "seeked", listener: () => void): void;
}

export interface CoalescedSeeker {
  /** Ask the element to show `target` (seconds, media time). */
  request(target: number): void;
  /** Detach the `seeked` listener and drop any pending target. */
  dispose(): void;
}

/**
 * `tolerance`: a request closer than this to where the element already is
 * (or is already going) is ignored, like the old `VIDEO_SYNC_TOLERANCE` check.
 * `applySeek`: optionally route each actual seek through a frame presenter.
 */
export function createCoalescedSeeker(
  media: SeekableMedia,
  tolerance: number,
  applySeek: (target: number) => void = (target) => {
    media.currentTime = target;
  },
): CoalescedSeeker {
  let pending: number | null = null;
  let inFlight: number | null = null;

  const apply = (target: number) => {
    inFlight = target;
    applySeek(target);
  };

  const onSeeked = () => {
    inFlight = null;
    if (pending === null) return;
    const next = pending;
    pending = null;
    if (Math.abs(media.currentTime - next) > tolerance) apply(next);
  };

  media.addEventListener("seeked", onSeeked);

  return {
    request(target: number) {
      if (media.seeking || inFlight !== null) {
        // Already heading somewhere: remember only the newest wish.
        if (inFlight !== null && Math.abs(inFlight - target) <= tolerance) {
          pending = null;
        } else {
          pending = target;
        }
        return;
      }
      if (Math.abs(media.currentTime - target) > tolerance) apply(target);
    },
    dispose() {
      pending = null;
      inFlight = null;
      media.removeEventListener("seeked", onSeeked);
    },
  };
}

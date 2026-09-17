/**
 * Tactile-atom candidate boundaries (Phase 2 of the TactileAtom project —
 * see `TactileAtom/materials/schema.md` §4.1 for the cross-repo schema).
 *
 * TacFlow-Engine's `detect_tactile_boundaries.py --publish` writes one file
 * per episode to `meta/tacflow/tactile_atom/<boundary_source>/ep_{index:06d}.json`
 * inside the dataset directory. This is a **read-only** candidate — no
 * region labels yet (that's `label_source=human`/`vlm`, a later phase), just
 * per-hand boundary frame/time lists. This module only coerces that shape;
 * it does not write anything back.
 */

export interface HandBoundaries {
  boundary_frames: number[];
  boundary_times: number[];
}

export interface TactileAtomBoundaryProvenance {
  boundary_source: string;
  algo_config_fingerprint?: string;
  detected_at?: string;
  [extra: string]: unknown;
}

export interface TactileAtomBoundaries {
  episode_index: number;
  dataset: string;
  fps: number | null;
  hands: Record<string, HandBoundaries>;
  provenance: TactileAtomBoundaryProvenance;
}

function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is number => typeof x === "number" && Number.isFinite(x),
  );
}

function coerceHand(raw: unknown): HandBoundaries | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const boundary_frames = toNumberArray(r.boundary_frames);
  const boundary_times = toNumberArray(r.boundary_times);
  if (boundary_frames.length === 0) return null;
  return { boundary_frames, boundary_times };
}

/**
 * Coerce an unknown parsed-JSON value into {@link TactileAtomBoundaries}, or
 * `null` if it doesn't look like one. Defensive on purpose: this file is
 * produced by a separate repo (TacFlow-Engine) on its own release cadence,
 * so a shape drift should degrade to "no candidates shown", not a crash.
 */
export function coerceTactileAtomBoundaries(
  raw: unknown,
): TactileAtomBoundaries | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hands: Record<string, HandBoundaries> = {};
  if (r.hands && typeof r.hands === "object") {
    for (const [hand, value] of Object.entries(
      r.hands as Record<string, unknown>,
    )) {
      const coerced = coerceHand(value);
      if (coerced) hands[hand] = coerced;
    }
  }
  if (Object.keys(hands).length === 0) return null;
  const provenanceRaw =
    r.provenance && typeof r.provenance === "object"
      ? (r.provenance as Record<string, unknown>)
      : {};
  return {
    episode_index: typeof r.episode_index === "number" ? r.episode_index : -1,
    dataset: typeof r.dataset === "string" ? r.dataset : "",
    fps: typeof r.fps === "number" ? r.fps : null,
    hands,
    provenance: {
      boundary_source:
        typeof provenanceRaw.boundary_source === "string"
          ? provenanceRaw.boundary_source
          : "unknown",
      ...provenanceRaw,
    },
  };
}

/** Stable, sorted hand keys (`left` before `right`, anything else after, alphabetically). */
export function orderedHands(boundaries: TactileAtomBoundaries): string[] {
  const priority: Record<string, number> = { left: 0, right: 1 };
  return Object.keys(boundaries.hands).sort((a, b) => {
    const pa = priority[a] ?? 2;
    const pb = priority[b] ?? 2;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

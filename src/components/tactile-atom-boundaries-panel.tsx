"use client";

/**
 * Read-only viewer for TactileAtom candidate boundaries (Phase 3 of the
 * TactileAtom project — see `TactileAtom/materials/schema.md`).
 *
 * TacFlow-Engine's `detect_tactile_boundaries.py --publish` writes
 * `meta/tacflow/tactile_atom/<boundary_source>/ep_{index:06d}.json` inside the
 * dataset directory (a "旁路产物" mirror of its own work-dir output, D39/O4).
 * This panel fetches that file through the generic dataset-file route
 * (`/api/local-datasets/<encodedPath>/<...>`, the same one thumbnails and
 * parquet browsing use — no dedicated API route needed for a static,
 * per-episode, read-only sidecar) and renders one tick strip per hand,
 * synced to video playback via `useTime()`.
 *
 * **Read-only on purpose**: Phase 2 only produces candidate *boundaries*, not
 * labeled regions — there is nothing to edit yet. Human review/labeling
 * (`label_source=human`) is a later phase with its own editable sidecar
 * (`meta/tactile_atoms.json`), not this file.
 */

import React, { useEffect, useState } from "react";
import { useTime } from "@/context/time-context";
import { useT } from "@/context/locale-context";
import {
  coerceTactileAtomBoundaries,
  orderedHands,
  type TactileAtomBoundaries,
} from "@/types/tactile-atom.types";

const BOUNDARY_SOURCES = ["algo", "vlm"] as const;

const STRIP_COLORS: Record<string, string> = {
  left: "#38bdf8",
  right: "#f472b6",
};

function fallbackColor(index: number): string {
  const palette = ["#facc15", "#34d399", "#a78bfa", "#fb923c"];
  return palette[index % palette.length];
}

type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; data: TactileAtomBoundaries };

function candidatePath(episodeId: number, boundarySource: string): string {
  return `meta/tacflow/tactile_atom/${boundarySource}/ep_${String(episodeId).padStart(6, "0")}.json`;
}

/**
 * Tries each known `boundary_source` in order and keeps the first one that
 * exists. Only `algo` is produced today; `vlm` is a listed-but-not-yet-real
 * Phase 5 source — trying it now means this panel needs no changes once it
 * lands.
 */
async function fetchFirstAvailable(
  encodedPath: string,
  episodeId: number,
  signal: AbortSignal,
): Promise<TactileAtomBoundaries | null> {
  for (const source of BOUNDARY_SOURCES) {
    const url = `/api/local-datasets/${encodedPath}/${candidatePath(episodeId, source)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) continue;
    const raw: unknown = await res.json();
    const coerced = coerceTactileAtomBoundaries(raw);
    if (coerced) return coerced;
  }
  return null;
}

interface StripProps {
  hand: string;
  boundaries: HandStripData;
  duration: number;
  onSeek: (time: number) => void;
}

interface HandStripData {
  boundary_frames: number[];
  boundary_times: number[];
}

const HandStrip: React.FC<StripProps> = ({
  hand,
  boundaries,
  duration,
  onSeek,
}) => {
  const t = useT();
  const { currentTime } = useTime();
  const span = Math.max(duration, 1e-6);
  const color = STRIP_COLORS[hand] ?? fallbackColor(hand.length);
  const playheadLeft = `${Math.min(100, (currentTime / span) * 100)}%`;

  return (
    <div className="flex items-center gap-2">
      <span
        className="w-14 shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-400"
        style={{ color }}
      >
        {hand}
      </span>
      <div className="relative h-6 flex-1 overflow-hidden rounded-md border border-white/10 bg-[var(--surface-0)]">
        {boundaries.boundary_times.map((time, i) => (
          <div
            key={`${boundaries.boundary_frames[i]}-${i}`}
            role="button"
            tabIndex={0}
            title={t("tactileAtom.tickTitle", {
              time: time.toFixed(2),
              frame: boundaries.boundary_frames[i],
            })}
            onClick={() => onSeek(time)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSeek(time);
            }}
            className="absolute top-0 h-full w-px cursor-pointer opacity-80 hover:w-0.5 hover:opacity-100"
            style={{ left: `${(time / span) * 100}%`, background: color }}
          />
        ))}
        <div
          className="pointer-events-none absolute top-0 h-full w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
          style={{ left: playheadLeft }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-[10px] text-slate-500 tabular">
        {t("tactileAtom.boundaryCount", {
          count: boundaries.boundary_frames.length,
        })}
      </span>
    </div>
  );
};

interface Props {
  encodedPath: string | null;
  episodeId: number;
  duration: number;
}

export const TactileAtomBoundariesPanel: React.FC<Props> = ({
  encodedPath,
  episodeId,
  duration,
}) => {
  const t = useT();
  const { seek, setIsPlaying } = useTime();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!encodedPath) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchFirstAvailable(encodedPath, episodeId, controller.signal)
      .then((data) =>
        setState(data ? { status: "ready", data } : { status: "empty" }),
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("tactile-atom boundaries fetch failed", err);
        setState({ status: "error" });
      });
    return () => controller.abort();
  }, [encodedPath, episodeId]);

  const onSeek = (time: number) => {
    seek(time, "external");
    setIsPlaying(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-slate-200">
          {t("tactileAtom.title")}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {t("tactileAtom.subtitle")}
        </p>
      </div>

      {state.status === "loading" && (
        <p className="text-xs text-slate-500">{t("tactileAtom.loading")}</p>
      )}
      {state.status === "error" && (
        <p className="text-xs text-rose-400">{t("tactileAtom.error")}</p>
      )}
      {state.status === "empty" && (
        <p className="text-xs text-slate-500">{t("tactileAtom.empty")}</p>
      )}

      {state.status === "ready" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            {orderedHands(state.data).map((hand) => (
              <HandStrip
                key={hand}
                hand={hand}
                boundaries={state.data.hands[hand]}
                duration={duration}
                onSeek={onSeek}
              />
            ))}
          </div>
          <div className="rounded-md border border-white/5 bg-[var(--surface-0)] px-3 py-2 text-[11px] text-slate-500">
            <p>
              {t("tactileAtom.source", {
                source: state.data.provenance.boundary_source,
              })}
            </p>
            {typeof state.data.provenance.detected_at === "string" && (
              <p>
                {t("tactileAtom.detectedAt", {
                  time: state.data.provenance.detected_at,
                })}
              </p>
            )}
            {typeof state.data.provenance.algo_config_fingerprint ===
              "string" && (
              <p className="truncate">
                {t("tactileAtom.configFingerprint", {
                  fingerprint:
                    state.data.provenance.algo_config_fingerprint.slice(0, 16),
                })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

"use client";

import React from "react";
import { FaBackward, FaForward, FaUndoAlt } from "react-icons/fa";
import { useT } from "@/context/locale-context";

interface UrdfPlaybackBarProps {
  frame: number;
  totalFrames: number;
  /**
   * Rows advanced per second of playback. `frame` indexes the *downsampled*
   * chart rows, so this is not the dataset fps unless the episode was short
   * enough to escape downsampling.
   */
  rowsPerSecond: number;
  playing: boolean;
  onBackward: () => void;
  onForward: () => void;
  onPlayPause: () => void;
  onReplay: () => void;
  trailEnabled: boolean;
  onTrailToggle: () => void;
  onFrameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}

export default function UrdfPlaybackBar({
  frame,
  totalFrames,
  rowsPerSecond,
  playing,
  onBackward,
  onForward,
  onPlayPause,
  onReplay,
  trailEnabled,
  onTrailToggle,
  onFrameChange,
  disabled = false,
}: UrdfPlaybackBarProps) {
  const t = useT();
  const rate = rowsPerSecond > 0 ? rowsPerSecond : 1;
  const currentTime = totalFrames > 0 ? (frame / rate).toFixed(2) : "0.00";
  const totalTime = (totalFrames / rate).toFixed(2);

  return (
    <div
      className={`flex items-center gap-3 ${disabled ? "opacity-50" : ""}`}
      aria-busy={disabled}
    >
      {/* Match the Episodes playback controls: back, play, forward, rewind. */}
      <button
        type="button"
        title={t("player.back5")}
        aria-label={t("player.back5")}
        onClick={onBackward}
        disabled={disabled}
        className="w-8 h-8 flex items-center justify-center rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-300 disabled:bg-white/5 disabled:border-white/5 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        <FaBackward aria-hidden="true" size={14} />
      </button>

      <button
        type="button"
        title={playing ? t("player.pause") : t("player.play")}
        aria-label={playing ? t("player.pause") : t("player.play")}
        onClick={onPlayPause}
        disabled={disabled}
        className="w-8 h-8 flex items-center justify-center rounded-md bg-cyan-400/10 border border-cyan-400/30 text-cyan-300 hover:bg-cyan-400/15 disabled:bg-white/5 disabled:border-white/5 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        {playing ? (
          <svg width="12" height="14" viewBox="0 0 12 14">
            <rect x="1" y="1" width="3" height="12" fill="white" />
            <rect x="8" y="1" width="3" height="12" fill="white" />
          </svg>
        ) : (
          <svg width="12" height="14" viewBox="0 0 12 14">
            <polygon points="2,1 11,7 2,13" fill="white" />
          </svg>
        )}
      </button>

      <button
        type="button"
        title={t("player.forward5")}
        aria-label={t("player.forward5")}
        onClick={onForward}
        disabled={disabled}
        className="w-8 h-8 flex items-center justify-center rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-300 disabled:bg-white/5 disabled:border-white/5 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        <FaForward aria-hidden="true" size={14} />
      </button>

      {/* Replay from the first frame */}
      <button
        type="button"
        aria-label={t("player.rewind")}
        title={t("player.rewind")}
        onClick={onReplay}
        disabled={disabled}
        className="w-8 h-8 flex items-center justify-center rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-300 disabled:bg-white/5 disabled:border-white/5 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        <FaUndoAlt aria-hidden="true" size={14} />
      </button>

      {/* Trail toggle */}
      <button
        type="button"
        onClick={onTrailToggle}
        disabled={disabled}
        className={`px-2 h-8 text-xs rounded transition-colors shrink-0 disabled:cursor-not-allowed ${
          trailEnabled
            ? "bg-cyan-400/15 text-cyan-300 border border-cyan-400/40"
            : "bg-white/5 text-slate-400 border border-white/10"
        }`}
        title={trailEnabled ? t("urdf.hideTrail") : t("urdf.showTrail")}
      >
        {t("urdf.trail")}
      </button>

      {/* Scrubber */}
      <input
        type="range"
        min={0}
        max={Math.max(totalFrames - 1, 0)}
        value={frame}
        onChange={onFrameChange}
        disabled={disabled}
        className="flex-1 h-1.5 accent-cyan-400 cursor-pointer disabled:cursor-not-allowed"
      />
      <span className="text-xs text-slate-400 tabular-nums w-28 text-right shrink-0">
        {currentTime}s / {totalTime}s
      </span>
      <span className="text-xs text-slate-500 tabular-nums w-20 text-right shrink-0">
        F {frame}/{Math.max(totalFrames - 1, 0)}
      </span>

      {/* Keyboard hints */}
      <div className="text-xs text-slate-500 select-none hidden md:flex flex-col gap-y-0.5 ml-2 shrink-0">
        <p>
          <span className="px-1.5 py-0.5 rounded border border-white/10 bg-[var(--surface-1)] text-slate-400 text-xs">
            Space
          </span>{" "}
          {t("player.hintSpace")}
        </p>
        <p>
          <span className="font-mono">↑/↓</span> {t("player.hintArrows")}
        </p>
        <p>
          <span className="font-mono">←/→</span> {t("urdf.hintSeek5")}
        </p>
      </div>
    </div>
  );
}

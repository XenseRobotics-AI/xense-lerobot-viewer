"use client";

import { useT } from "@/context/locale-context";
import type { VideoCompatibility } from "@/hooks/use-video-compatibility";

export function VideoCompatibilityControl({
  state,
  className = "",
}: {
  state: VideoCompatibility;
  className?: string;
}) {
  const t = useT();
  if (!state.available) return null;
  return (
    <div className={`flex items-center gap-2 text-xs ${className}`}>
      <button
        type="button"
        onClick={state.toggle}
        title={t("player.compatibilityHelp")}
        data-video-compatibility={state.phase}
        className="rounded border border-white/15 bg-slate-950/90 px-2.5 py-1.5 text-slate-200 shadow hover:border-cyan-400/60 hover:text-cyan-200"
      >
        {state.phase === "preparing"
          ? t("player.compatibilityPreparing", {
              done: state.done,
              total: state.total,
            })
          : state.phase === "compatible"
            ? t("player.originalPlayback")
            : t("player.smoothPlayback")}
      </button>
      {state.phase === "compatible" && (
        <span className="text-cyan-300">{t("player.compatibilityActive")}</span>
      )}
      {state.phase === "error" && (
        <span className="text-amber-300">{t("player.compatibilityError")}</span>
      )}
      {state.phase === "unavailable" && (
        <span className="text-slate-400">
          {t("player.compatibilityUnavailable")}
        </span>
      )}
    </div>
  );
}

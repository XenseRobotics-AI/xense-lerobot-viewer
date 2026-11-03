"use client";

/**
 * Read-only view of TacFlow's ④ automatic annotation for the current episode.
 *
 * The labels are a vision-language model's reading of the head-camera footage, written by TacFlow into the
 * corpus registry (see `src/lib/auto-annotations.ts`). This panel shows them against playback so a reviewer
 * can check each claim: the band and the step list follow the playhead, and clicking a step or a finding
 * seeks the video there. Nothing is edited here — corrections go back through TacFlow.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useTime } from "@/context/time-context";
import { useT } from "@/context/locale-context";
import {
  activeRowAt,
  type AutoAnnotationResponse,
  type AutoFinding,
} from "@/types/auto-annotation.types";

interface Props {
  /** null for a dataset that is not on the local filesystem: nothing to read */
  encodedPath: string | null;
  episodeId: number;
}

const ARM_COLOR: Record<string, string> = {
  left: "#3b82f6",
  right: "#f59e0b",
  both: "#a855f7",
};

const OUTCOME_CLASS: Record<string, string> = {
  success: "bg-emerald-500/20 text-emerald-200",
  success_then_undone: "bg-amber-500/20 text-amber-200",
  partial: "bg-amber-500/20 text-amber-200",
  unclear: "bg-amber-500/20 text-amber-200",
  failure: "bg-rose-500/20 text-rose-200",
};

type Load =
  | { state: "loading" }
  | { state: "none"; reason: string }
  | { state: "ok"; data: AutoAnnotationResponse };

function fmt(s: number | null): string {
  return s === null ? "—" : `${s.toFixed(1)}s`;
}

export function AutoAnnotationPanel({ encodedPath, episodeId }: Props) {
  const t = useT();
  const { currentTime, duration, seek, setIsPlaying } = useTime();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    if (!encodedPath) {
      setLoad({ state: "none", reason: "not a local dataset" });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    fetch(
      `/api/local-datasets/${encodedPath}/auto-annotations?episode=${episodeId}`,
      {
        cache: "no-store",
      },
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok)
          setLoad({ state: "ok", data: body as AutoAnnotationResponse });
        else
          setLoad({
            state: "none",
            reason: String((body as { reason?: string }).reason ?? res.status),
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ state: "none", reason: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [encodedPath, episodeId]);

  const episode = load.state === "ok" ? load.data.episode : null;
  const rows = useMemo(() => episode?.timeline ?? [], [episode]);
  const active = activeRowAt(rows, currentTime);
  const span =
    Math.max(duration || 0, rows.length ? rows[rows.length - 1].end_s : 0) || 1;

  const jump = (s: number | null) => {
    if (s === null) return;
    setIsPlaying(false);
    seek(Math.max(0, s), "external");
  };

  if (load.state === "loading") {
    return (
      <div className="panel p-4 text-sm text-slate-500">
        {t("autoAnn.loading")}
      </div>
    );
  }
  if (load.state === "none") {
    return (
      <div className="panel p-4 text-sm text-slate-500">
        {t("autoAnn.none")}
        <span className="block text-[11px] text-slate-600">{load.reason}</span>
      </div>
    );
  }
  const { data } = load;
  if (!episode) {
    return (
      <div className="panel p-4 text-sm text-slate-500">
        {t("autoAnn.noEpisode")}
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-slate-200">
          {t("autoAnn.title")}
        </h3>
        {episode.usable ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              OUTCOME_CLASS[episode.outcome ?? ""] ??
              "bg-slate-500/20 text-slate-200"
            }`}
          >
            {episode.outcome ?? "—"}
          </span>
        ) : (
          <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-200">
            {t("autoAnn.unusable")}
          </span>
        )}
        <span className="ml-auto text-[10px] text-slate-500">
          {data.models.join(", ")}
          {data.annotated_at ? ` · ${data.annotated_at.slice(0, 10)}` : ""}
        </span>
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
        {t("autoAnn.disclaimer")}
      </p>

      {!episode.usable && (
        <ul className="list-disc pl-5 text-sm text-rose-200">
          {episode.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {episode.summary && (
        <p className="mb-2 text-sm text-slate-200">{episode.summary}</p>
      )}
      {episode.outcome_reason && (
        <p className="mb-2 text-xs text-slate-400">{episode.outcome_reason}</p>
      )}

      {/* timeline band: one span per step, coloured by hand, with the playhead and the findings */}
      <div
        className="relative my-3 h-5 overflow-hidden rounded bg-white/5"
        aria-hidden
      >
        {rows.map((r, i) => (
          <button
            key={`${r.start_s}-${i}`}
            type="button"
            tabIndex={-1}
            title={`${fmt(r.start_s)}–${fmt(r.end_s)} ${r.arm ?? ""}: ${r.action ?? ""}`}
            onClick={() => jump(r.start_s)}
            className={`absolute top-0 bottom-0 border-r border-black/40 ${
              r.contribution === "idle" ? "opacity-40" : ""
            } ${r.contribution === "wasteful" ? "ring-2 ring-inset ring-rose-400" : ""}`}
            style={{
              left: `${(100 * r.start_s) / span}%`,
              width: `${(100 * (r.end_s - r.start_s)) / span}%`,
              background: ARM_COLOR[(r.arm ?? "").toLowerCase()] ?? "#64748b",
            }}
          />
        ))}
        {episode.findings
          .filter((f) => f.t_s !== null)
          .map((f, i) => (
            <span
              key={`mark-${i}`}
              className="absolute top-0 bottom-0 w-0.5 bg-rose-500"
              style={{ left: `${(100 * (f.t_s as number)) / span}%` }}
            />
          ))}
        <span
          className="absolute top-0 bottom-0 w-0.5 bg-white"
          style={{ left: `${(100 * Math.min(currentTime, span)) / span}%` }}
        />
      </div>

      {episode.findings.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-rose-300/80">
            {t("autoAnn.findings")}
          </p>
          <ul className="space-y-1">
            {episode.findings.map((f: AutoFinding, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => jump(f.t_s)}
                  className="w-full rounded-md border border-rose-400/20 bg-rose-400/5 px-2 py-1 text-left text-xs text-slate-200 hover:bg-rose-400/10"
                >
                  <span className="tabular text-slate-500">
                    {fmt(f.t_s)}–{fmt(f.end_s)}
                  </span>{" "}
                  <span className="text-rose-200">
                    {f.kind === "data_issue"
                      ? t("autoAnn.dataIssue")
                      : t("autoAnn.mistake")}
                    {f.category ? ` · ${f.category}` : ""}
                    {f.severity ? ` · ${f.severity}` : ""}
                  </span>
                  <span className="block">{f.issue}</span>
                  {f.evidence && (
                    <span className="block text-slate-500">{f.evidence}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
        {t("autoAnn.steps")} ({rows.length})
      </p>
      <ol className="space-y-0.5">
        {rows.map((r, i) => (
          <li key={`${r.start_s}-${i}`}>
            <button
              type="button"
              onClick={() => jump(r.start_s)}
              aria-current={i === active ? "step" : undefined}
              className={`flex w-full gap-2 rounded px-2 py-1 text-left text-xs ${
                i === active
                  ? "bg-cyan-400/10 text-slate-100"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <span className="tabular w-20 shrink-0 text-slate-500">
                {r.start_s.toFixed(1)}–{r.end_s.toFixed(1)}
              </span>
              <span
                className="mt-1 h-2 w-2 shrink-0 rounded-sm"
                style={{
                  background:
                    ARM_COLOR[(r.arm ?? "").toLowerCase()] ?? "#64748b",
                }}
              />
              <span>
                {r.action}
                {r.object ? ` · ${r.object}` : ""}
                {r.destination ? ` → ${r.destination}` : ""}
                {r.notes && (
                  <span className="block text-slate-500">{r.notes}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {episode.performance_review && (
        <p className="mt-3 text-xs text-slate-400">
          {episode.performance_review}
        </p>
      )}
    </div>
  );
}

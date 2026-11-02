"use client";

/**
 * Read-only view of TacFlow's ④ automatic annotation for the current episode.
 *
 * The labels are a vision-language model's reading of the head-camera footage, written by TacFlow into the
 * corpus registry (see `src/lib/auto-annotations.ts`). Laid out after the Argus board, top to bottom: the dataset's
 * instruction and the model's own reading of the work (with whether the two agree), the outcome, the problems —
 * data issues and operator mistakes as separate cards — then the timeline band and the step feed. Everything that
 * carries a time seeks the video there; the step under the playhead is highlighted and kept in view while playing.
 * Nothing is edited here — corrections go back through TacFlow.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTime } from "@/context/time-context";
import { useT } from "@/context/locale-context";
import type { MessageKey } from "@/i18n/messages";
import {
  activeRowAt,
  contributionCounts,
  type AutoAnnotationResponse,
  type AutoFinding,
  type AutoTimelineRow,
} from "@/types/auto-annotation.types";

interface Props {
  /** null for a dataset that is not on the local filesystem: nothing to read */
  encodedPath: string | null;
  episodeId: number;
  /** the dataset's instruction for this episode (meta/tasks), the anchor the outcome is judged against */
  task?: string | null;
}

type T = ReturnType<typeof useT>;

const ARM_COLOR: Record<string, string> = {
  left: "#5b8def",
  right: "#e0a43a",
  both: "#a87fe0",
};

const OUTCOME_TONE: Record<string, string> = {
  success: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  success_then_undone: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  partial: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  unclear: "border-slate-400/40 bg-slate-500/10 text-slate-200",
  failure: "border-rose-400/40 bg-rose-500/10 text-rose-200",
};

const CONTRIB_TONE: Record<string, string> = {
  advancing: "bg-white/10 text-slate-200",
  wasteful: "bg-indigo-400/20 text-indigo-200",
  idle: "bg-white/5 text-slate-400",
};

type Load =
  | { state: "loading" }
  | { state: "none"; reason: string }
  | { state: "ok"; data: AutoAnnotationResponse };

function fmt(s: number | null): string {
  return s === null ? "—" : `${s.toFixed(1)}s`;
}

function armOf(r: { arm: string | null }): string {
  return (r.arm ?? "").toLowerCase();
}

/** A model-written enum value (outcome, hand, contribution, alignment) in the UI language; unknown values as written. */
function label(t: T, group: string, value: string | null): string {
  if (!value) return "—";
  const key = `autoAnn.${group}.${value}`;
  const text = t(key as MessageKey);
  return text === key ? value : text;
}

export function AutoAnnotationPanel({ encodedPath, episodeId, task }: Props) {
  const t = useT();
  const { currentTime, duration, isPlaying, seek, setIsPlaying } = useTime();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const feedRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!encodedPath) {
      setLoad({ state: "none", reason: "not a local dataset" });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    fetch(
      `/api/local-datasets/${encodedPath}/auto-annotations?episode=${episodeId}`,
      { cache: "no-store" },
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

  // Keep the step under the playhead in view while playing. Only the feed scrolls (it has its own scroll box):
  // scrollIntoView would also scroll the panel and push the instruction and outcome out of sight.
  useEffect(() => {
    const feed = feedRef.current;
    if (!isPlaying || active < 0 || !feed) return;
    const row = feed.querySelector<HTMLElement>(`[data-row="${active}"]`);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < feed.scrollTop) feed.scrollTop = top;
    else if (bottom > feed.scrollTop + feed.clientHeight)
      feed.scrollTop = bottom - feed.clientHeight;
  }, [active, isPlaying]);

  const jump = (s: number | null) => {
    if (s === null) return;
    setIsPlaying(false);
    seek(Math.max(0, s), "external");
  };

  if (load.state === "loading") {
    return (
      <div className="panel p-5 text-sm text-slate-400">
        {t("autoAnn.loading")}
      </div>
    );
  }
  if (load.state === "none") {
    return (
      <div className="panel p-5 text-sm text-slate-400">
        {t("autoAnn.none")}
        <span className="mt-1 block text-xs text-slate-500">{load.reason}</span>
      </div>
    );
  }
  const { data } = load;
  if (!episode) {
    return (
      <div className="panel p-5 text-sm text-slate-400">
        {t("autoAnn.noEpisode")}
      </div>
    );
  }

  const dataIssues = episode.findings.filter((f) => f.kind === "data_issue");
  const mistakes = episode.findings.filter(
    (f) => f.kind === "operator_mistake",
  );
  const counts = contributionCounts(rows);
  const alignment = episode.alignment;
  const aligned =
    alignment?.relation === "aligned" || alignment?.matches === true;

  return (
    <div className="panel space-y-5 p-5 text-[15px] leading-relaxed text-slate-200">
      {/* header: what this is and where it came from */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-slate-100">
          {t("autoAnn.title")}
        </h3>
        <span className="ml-auto text-xs text-slate-500">
          {data.models.join(", ")}
          {data.annotated_at ? ` · ${data.annotated_at.slice(0, 10)}` : ""}
        </span>
        <p className="basis-full text-xs text-slate-500">
          {t("autoAnn.disclaimer")}
        </p>
      </div>

      {!episode.usable && (
        <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-4">
          <p className="text-sm font-semibold text-rose-200">
            {t("autoAnn.unusable")}
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-rose-100">
            {episode.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* instruction banner: the dataset's instruction, then the model's reading of the work */}
      <section className="rounded-lg border border-white/10 border-l-2 border-l-slate-300 bg-white/[0.03] px-5 py-4">
        {task && (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t("autoAnn.instruction")}
            </p>
            <p className="mt-1 text-[17px] font-medium leading-snug text-slate-50">
              {task}
            </p>
          </>
        )}
        {episode.summary && (
          <div
            className={
              task ? "mt-3 border-t border-dashed border-white/10 pt-3" : ""
            }
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t("autoAnn.modelRead")}
            </p>
            <p className="mt-1 text-[15px] leading-snug text-slate-200">
              {episode.summary}
            </p>
          </div>
        )}
        {alignment?.relation && (
          <span
            className={`mt-3 inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              aligned
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                : "border-amber-400/40 bg-amber-500/10 text-amber-200"
            }`}
            title={alignment.note ?? undefined}
          >
            {label(t, "align", alignment.relation)}
          </span>
        )}
      </section>

      {/* outcome */}
      {episode.usable && (
        <section
          className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-5 py-3 ${
            OUTCOME_TONE[episode.outcome ?? ""] ?? OUTCOME_TONE.unclear
          }`}
        >
          <span className="text-base font-semibold">
            {label(t, "outcome", episode.outcome ?? "unclear")}
          </span>
          {episode.completed_at_s !== null && (
            <button
              type="button"
              onClick={() => jump(episode.completed_at_s)}
              className="text-sm tabular underline-offset-2 hover:underline"
            >
              {t("autoAnn.completedAt", { t: fmt(episode.completed_at_s) })}
            </button>
          )}
          {episode.outcome_reason && (
            <p className="basis-full text-sm leading-snug text-slate-300">
              {episode.outcome_reason}
            </p>
          )}
        </section>
      )}

      {/* problems: one card per kind */}
      {episode.usable &&
        (episode.findings.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/15 px-5 py-3 text-sm text-slate-400">
            {t("autoAnn.noFindings")}
          </p>
        ) : (
          <div className="space-y-3">
            <FindingCard
              tone="rose"
              title={t("autoAnn.dataIssues")}
              items={dataIssues}
              onJump={jump}
              t={t}
            />
            <FindingCard
              tone="indigo"
              title={t("autoAnn.mistakes")}
              items={mistakes}
              onJump={jump}
              t={t}
            />
          </div>
        ))}

      {/* timeline band and step feed */}
      {rows.length > 0 && (
        <section>
          <SectionTitle text={t("autoAnn.steps")} count={rows.length} />
          <div className="relative h-7 overflow-hidden rounded border border-white/10 bg-white/5">
            {rows.map((r, i) => (
              <button
                key={`${r.start_s}-${i}`}
                type="button"
                tabIndex={-1}
                aria-label={`${fmt(r.start_s)} ${r.action ?? ""}`}
                title={`${fmt(r.start_s)}–${fmt(r.end_s)} ${r.arm ?? ""}: ${r.action ?? ""}`}
                onClick={() => jump(r.start_s)}
                className={`absolute top-0 bottom-0 border-r border-black/40 ${r.contribution === "idle" ? "opacity-40" : ""} ${
                  r.contribution === "wasteful"
                    ? "ring-2 ring-inset ring-indigo-300"
                    : ""
                }`}
                style={{
                  left: `${(100 * r.start_s) / span}%`,
                  width: `${(100 * (r.end_s - r.start_s)) / span}%`,
                  background: ARM_COLOR[armOf(r)] ?? "#64748b",
                }}
              />
            ))}
            {episode.findings
              .filter((f) => f.t_s !== null)
              .map((f, i) => (
                <span
                  key={`m-${i}`}
                  className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-rose-400"
                  style={{ left: `${(100 * (f.t_s as number)) / span}%` }}
                />
              ))}
            <span
              className="absolute top-0 bottom-0 w-0.5 bg-white"
              style={{ left: `${(100 * Math.min(currentTime, span)) / span}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-xs tabular text-slate-500">
            <span>0s</span>
            <span>{fmt(span / 2)}</span>
            <span>{fmt(span)}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {Object.entries(ARM_COLOR).map(([arm, color]) => (
              <span
                key={arm}
                className="inline-flex items-center gap-1.5 text-slate-400"
              >
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ background: color }}
                />
                {label(t, "arm", arm)}
              </span>
            ))}
            <span className="mx-1 text-slate-600">|</span>
            {Object.entries(counts).map(([k, v]) => (
              <span
                key={k}
                className={`rounded px-2 py-0.5 font-medium ${CONTRIB_TONE[k] ?? "bg-white/5 text-slate-300"}`}
              >
                {label(t, "contrib", k)} {v}
              </span>
            ))}
          </div>

          <ol
            ref={feedRef}
            className="relative mt-3 max-h-[60vh] divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/5"
          >
            {rows.map((r, i) => (
              <StepRow
                key={`${r.start_s}-${i}`}
                row={r}
                index={i}
                active={i === active}
                onJump={jump}
                t={t}
              />
            ))}
          </ol>
        </section>
      )}

      {episode.performance_review && (
        <section>
          <SectionTitle text={t("autoAnn.review")} />
          <p className="text-[15px] leading-relaxed text-slate-300">
            {episode.performance_review}
          </p>
        </section>
      )}
    </div>
  );
}

function SectionTitle({ text, count }: { text: string; count?: number }) {
  return (
    <h4 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-slate-100">
      <span className="h-4 w-[3px] rounded-sm bg-slate-300" />
      {text}
      {count !== undefined && (
        <span className="text-xs font-normal tabular text-slate-500">
          {count}
        </span>
      )}
    </h4>
  );
}

function FindingCard({
  tone,
  title,
  items,
  onJump,
  t,
}: {
  tone: "rose" | "indigo";
  title: string;
  items: AutoFinding[];
  onJump: (s: number | null) => void;
  t: T;
}) {
  if (!items.length) return null;
  const c =
    tone === "rose"
      ? {
          box: "border-rose-400/35 border-t-rose-400 bg-rose-500/[0.06]",
          head: "text-rose-200",
          pill: "bg-rose-400/20 text-rose-100",
        }
      : {
          box: "border-indigo-400/35 border-t-indigo-400 bg-indigo-500/[0.06]",
          head: "text-indigo-200",
          pill: "bg-indigo-400/20 text-indigo-100",
        };
  return (
    <section
      className={`overflow-hidden rounded-lg border border-t-[3px] ${c.box}`}
    >
      <div
        className={`flex items-baseline justify-between px-4 pt-3 ${c.head}`}
      >
        <h4 className="text-[15px] font-semibold">{title}</h4>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular ${c.pill}`}
        >
          {items.length}
        </span>
      </div>
      <ul className="space-y-2 p-3">
        {items.map((f, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onJump(f.t_s)}
              className={`w-full rounded-md border border-white/5 bg-black/20 px-3 py-2.5 text-left hover:bg-black/30 ${
                f.resolution ? "opacity-60" : ""
              }`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="tabular font-semibold text-slate-200">
                  {fmt(f.t_s)}–{fmt(f.end_s)}
                </span>
                {f.category && <span className={c.head}>{f.category}</span>}
                {f.severity && (
                  <span className="text-slate-500">{f.severity}</span>
                )}
                {f.resolution && (
                  <span
                    className="ml-auto rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-200"
                    title={f.resolution.note ?? undefined}
                  >
                    {label(t, "resolution", f.resolution.resolution)}
                    {f.resolution.by ? ` · ${f.resolution.by}` : ""}
                  </span>
                )}
              </span>
              <span className="mt-1 block text-[15px] leading-snug text-slate-100">
                {f.issue}
              </span>
              {f.evidence && (
                <span className="mt-1 block text-sm leading-snug text-slate-400">
                  {f.evidence}
                </span>
              )}
              {f.resolution?.note && (
                <span className="mt-1 block text-sm leading-snug text-emerald-200/80">
                  {f.resolution.note}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StepRow({
  row,
  index,
  active,
  onJump,
  t,
}: {
  row: AutoTimelineRow;
  index: number;
  active: boolean;
  onJump: (s: number | null) => void;
  t: T;
}) {
  const arm = armOf(row);
  const where = [row.object, row.destination ? `→ ${row.destination}` : null]
    .filter(Boolean)
    .join(" ");
  const contrib = (row.contribution ?? "").toLowerCase();
  return (
    <li data-row={index}>
      <button
        type="button"
        onClick={() => onJump(row.start_s)}
        aria-current={active ? "step" : undefined}
        className={`grid w-full grid-cols-[3.25rem_3rem_minmax(0,1fr)_auto] items-baseline gap-x-3 border-l-[3px] px-3 py-3 text-left ${
          active
            ? "border-l-cyan-400 bg-cyan-400/10"
            : "border-l-transparent hover:bg-white/5"
        }`}
      >
        <span
          className={`text-right text-[13px] tabular ${active ? "font-semibold text-cyan-200" : "text-slate-500"}`}
        >
          {row.start_s.toFixed(1)}s
        </span>
        <span
          className="text-[13px] font-semibold"
          style={{ color: ARM_COLOR[arm] ?? "#94a3b8" }}
        >
          {label(t, "arm", arm || null)}
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] leading-snug text-slate-100">
            {row.action}
          </span>
          {where && (
            <span className="mt-0.5 block text-[13px] text-slate-400">
              {where}
            </span>
          )}
          {row.notes && (
            <span className="mt-0.5 block text-[13px] italic text-slate-500">
              {row.notes}
            </span>
          )}
        </span>
        {contrib && (
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${CONTRIB_TONE[contrib] ?? "bg-white/5 text-slate-300"}`}
          >
            {label(t, "contrib", contrib)}
          </span>
        )}
      </button>
    </li>
  );
}

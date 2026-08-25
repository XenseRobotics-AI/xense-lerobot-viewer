"use client";

/**
 * Episodes-tab Subtask labeler (Pi-style segmentation).
 *
 * Type the current subtask while browsing; it starts a segment at the current
 * frame and **persists until the next subtask** (contiguous frame ranges). The
 * active subtask tracks playback. Edits live in memory + sessionStorage; the
 * explicit Save writes the Pi-style `meta/annotations.json`, and Export compiles
 * it into lerobot-native per-frame `subtask_index` + `meta/subtasks.parquet`.
 *
 * Self-contained (not wired to the atom-based AnnotationsProvider): the Pi model
 * carries skill / paraphrases / success-frame that the language-atom schema
 * can't express, and this is the layer that produces the trainable subtask_index.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTime } from "@/context/time-context";
import {
  activeSegmentIndexAt,
  emptyAnnotation,
  frameToTime,
  insertSubtaskAt,
  removeSegment,
  timeToFrame,
  updateSegment,
  type EpisodeSubtaskAnnotation,
  type SubtaskSegment,
} from "@/types/subtask.types";
import {
  exportSubtasksToDataset,
  fetchEpisodeSubtasks,
  saveEpisodeSubtasks,
} from "@/utils/subtasksClient";
import { useLocale, useT } from "@/context/locale-context";

const COMMON_SKILLS = [
  "Pick",
  "Place",
  "Grasp",
  "Align",
  "Insert",
  "Open",
  "Close",
  "Push",
  "Pull",
  "Move",
  "Rotate",
  "Wipe",
  "Press",
  "Pour",
];

const STORAGE_PREFIX = "lerobot-subtasks:v1:";
function storageKey(encodedPath: string, episodeId: number): string {
  return `${STORAGE_PREFIX}${encodedPath}::${episodeId}`;
}

function parseParaphrases(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Props {
  encodedPath: string | null;
  episodeId: number;
  fps: number;
  task?: string;
  frameTimestamps?: number[];
}

export const SubtaskPanel: React.FC<Props> = ({
  encodedPath,
  episodeId,
  fps,
  task,
  frameTimestamps,
}) => {
  const { t, tp } = useLocale();
  const { currentTime, duration, seek, setIsPlaying } = useTime();

  const [ann, setAnn] = useState<EpisodeSubtaskAnnotation>(() =>
    emptyAnnotation(episodeId, task ?? ""),
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Quick-add inputs.
  const [qaInstruction, setQaInstruction] = useState("");
  const [qaSkill, setQaSkill] = useState("");
  const [qaParaphrases, setQaParaphrases] = useState("");

  const savedSnapshotRef = useRef<string>("");

  const lastFrame = useMemo(() => {
    if (frameTimestamps && frameTimestamps.length) {
      return frameTimestamps.length - 1;
    }
    return Math.max(0, Math.round(duration * (fps || 1)));
  }, [frameTimestamps, duration, fps]);

  const segments = ann.instruction_segments;

  // ---- hydrate on episode / dataset change --------------------------------
  useEffect(() => {
    if (!encodedPath) return;
    let cancelled = false;

    const seed = emptyAnnotation(episodeId, task ?? "");

    // Precedence: unsaved session edits > saved sidecar > seed-from-task.
    let sessionAnn: EpisodeSubtaskAnnotation | null = null;
    try {
      const raw = sessionStorage.getItem(storageKey(encodedPath, episodeId));
      if (raw) sessionAnn = JSON.parse(raw) as EpisodeSubtaskAnnotation;
    } catch {
      /* ignore */
    }

    if (sessionAnn && sessionAnn.instruction_segments?.length) {
      setAnn(sessionAnn);
      savedSnapshotRef.current = JSON.stringify(seed);
      setDirty(JSON.stringify(sessionAnn) !== savedSnapshotRef.current);
      setSelectedId(null);
      return;
    }

    setAnn(seed);
    savedSnapshotRef.current = JSON.stringify(seed);
    setDirty(false);
    setSelectedId(null);
    setStatus(null);

    fetchEpisodeSubtasks(encodedPath, episodeId)
      .then((saved) => {
        if (cancelled || !saved) return;
        // Prefer the dataset's high-level task when the sidecar lacks one.
        const merged: EpisodeSubtaskAnnotation = {
          ...saved,
          high_level_instruction: saved.high_level_instruction || task || "",
        };
        setAnn(merged);
        savedSnapshotRef.current = JSON.stringify(merged);
        setDirty(false);
      })
      .catch(() => {
        /* no sidecar yet — keep the seed */
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodedPath, episodeId]);

  // ---- persist to sessionStorage + recompute dirty ------------------------
  useEffect(() => {
    if (!encodedPath) return;
    try {
      sessionStorage.setItem(
        storageKey(encodedPath, episodeId),
        JSON.stringify(ann),
      );
    } catch {
      /* ignore */
    }
    setDirty(JSON.stringify(ann) !== savedSnapshotRef.current);
  }, [ann, encodedPath, episodeId]);

  const currentFrame = timeToFrame(currentTime, fps, frameTimestamps);
  const activeIdx = activeSegmentIndexAt(segments, currentFrame);
  const activeSeg = activeIdx >= 0 ? segments[activeIdx] : null;
  const selectedSeg =
    selectedId != null
      ? (segments.find((s) => s.segment_id === selectedId) ?? null)
      : null;

  const jumpToFrame = useCallback(
    (frame: number) => {
      const f = Math.max(0, Math.min(lastFrame, Math.round(frame)));
      // External seek writes currentTime synchronously and pauses, so the
      // playhead lands exactly on frame `f` (even the last one, which the video
      // won't otherwise settle on).
      seek(frameToTime(f, fps, frameTimestamps), "external");
      setIsPlaying(false);
    },
    [seek, setIsPlaying, fps, frameTimestamps, lastFrame],
  );

  const mutate = useCallback(
    (segs: SubtaskSegment[]) =>
      setAnn((prev) => ({ ...prev, instruction_segments: segs })),
    [],
  );

  const handleAdd = () => {
    const instruction = qaInstruction.trim();
    if (!instruction) return;
    const next = insertSubtaskAt(
      segments,
      {
        startFrame: currentFrame,
        instruction,
        skill: qaSkill.trim(),
        paraphrases: parseParaphrases(qaParaphrases),
      },
      lastFrame,
    );
    mutate(next);
    // The first subtask is pinned to frame 0, so select whichever segment now
    // covers the current frame rather than matching on start_frame_index.
    const addedIdx = activeSegmentIndexAt(next, currentFrame);
    if (addedIdx >= 0) setSelectedId(next[addedIdx].segment_id);
    setQaInstruction("");
    setQaParaphrases("");
  };

  const handleMarkSuccess = () => {
    if (!activeSeg) return;
    const atSuccess = activeSeg.success_frame_index === currentFrame;
    mutate(
      updateSegment(
        segments,
        activeSeg.segment_id,
        { success_frame_index: atSuccess ? null : currentFrame },
        lastFrame,
      ),
    );
    setSelectedId(activeSeg.segment_id);
    setStatus(
      atSuccess
        ? t("subtask.statusCleared", { id: activeSeg.segment_id })
        : t("subtask.statusMarked", {
            frame: currentFrame,
            id: activeSeg.segment_id,
            instruction: activeSeg.instruction,
          }),
    );
  };

  const handleSave = async () => {
    if (!encodedPath) return;
    setSaving(true);
    setStatus(null);
    try {
      const { path } = await saveEpisodeSubtasks(encodedPath, ann, lastFrame);
      savedSnapshotRef.current = JSON.stringify(ann);
      setDirty(false);
      setStatus(
        path
          ? t("subtask.statusSaved", { path })
          : t("subtask.statusSavedPlain"),
      );
    } catch (e) {
      setStatus(
        t("subtask.statusSaveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    if (!encodedPath) return;
    if (dirty) {
      setStatus(t("subtask.statusSaveFirst"));
      return;
    }
    if (!window.confirm(t("subtask.exportConfirm"))) {
      return;
    }
    setExporting(true);
    setStatus(t("subtask.statusExporting"));
    const r = await exportSubtasksToDataset(encodedPath);
    setStatus(r.message);
    setExporting(false);
  };

  if (!encodedPath) return null;

  return (
    <div className="panel p-4">
      {/* No title row heading — the editor sub-tab above already says
          `subtask.title`. Status and the frame counter stay. */}
      <div className="flex items-center gap-3 mb-3">
        {dirty && (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
            {t("subtask.unsaved")}
          </span>
        )}
        <span className="ml-auto tabular text-[10px] text-slate-500">
          {t("subtask.frameOf", { current: currentFrame, last: lastFrame })}
        </span>
      </div>

      {/* High-level instruction */}
      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
        {t("subtask.highLevel")}
      </label>
      <input
        type="text"
        value={ann.high_level_instruction}
        placeholder={task || t("subtask.highLevelPlaceholder")}
        onChange={(e) =>
          setAnn((prev) => ({
            ...prev,
            high_level_instruction: e.target.value,
          }))
        }
        className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none"
      />

      {/* Active subtask banner */}
      <div className="mt-3 rounded-md border border-cyan-400/20 bg-cyan-400/5 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-cyan-300/80">
          {t("subtask.activeAt", { frame: currentFrame })}
        </p>
        {activeSeg ? (
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="tabular text-[11px] text-slate-500">
              #{activeSeg.segment_id}
            </span>
            {activeSeg.skill && (
              <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-medium text-cyan-100">
                {activeSeg.skill}
              </span>
            )}
            <span className="text-sm text-slate-100">
              {activeSeg.instruction}
            </span>
            <span className="ml-auto tabular text-[10px] text-slate-500">
              [{activeSeg.start_frame_index}→{activeSeg.end_frame_index}]
            </span>
          </div>
        ) : (
          <p className="mt-0.5 text-sm text-slate-500 italic">
            {t("subtask.none")}
          </p>
        )}
        {activeSeg && (
          <p className="mt-1 tabular text-[10px] text-slate-500">
            {t("subtask.successFrameShort")}{" "}
            {activeSeg.success_frame_index != null ? (
              <span className="text-emerald-300">
                {activeSeg.success_frame_index}
              </span>
            ) : (
              <span className="text-slate-600">
                {t("subtask.unmarked", {
                  button: t("subtask.markSuccess"),
                })}
              </span>
            )}
          </p>
        )}
      </div>

      {/* Quick-add */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Precise frame nav — step to the exact frame the video won't settle on */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => jumpToFrame(currentFrame - 1)}
            title={t("subtask.prevFrame")}
            className="rounded border border-white/10 px-1.5 py-1 text-[11px] text-slate-300 hover:text-cyan-200"
          >
            ◀
          </button>
          <span className="tabular bg-white/5 px-2 py-1 text-[11px] text-slate-400">
            {t("subtask.frame", { frame: currentFrame })}
          </span>
          <button
            onClick={() => jumpToFrame(currentFrame + 1)}
            title={t("subtask.nextFrame")}
            className="rounded border border-white/10 px-1.5 py-1 text-[11px] text-slate-300 hover:text-cyan-200"
          >
            ▶
          </button>
          <button
            onClick={() => jumpToFrame(lastFrame)}
            title={t("subtask.jumpLastTitle", { frame: lastFrame })}
            className="rounded border border-white/10 px-1.5 py-1 text-[11px] text-slate-300 hover:text-cyan-200"
          >
            ⤓ {t("subtask.lastBtn")}
          </button>
        </div>
        <input
          list="subtask-skills"
          value={qaSkill}
          placeholder={t("subtask.skillPlaceholder")}
          onChange={(e) => setQaSkill(e.target.value)}
          className="w-24 rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none"
        />
        <datalist id="subtask-skills">
          {COMMON_SKILLS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <input
          type="text"
          value={qaInstruction}
          placeholder={t("subtask.instructionPlaceholder")}
          onChange={(e) => setQaInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          className="min-w-[16rem] flex-1 rounded-md border border-white/10 bg-[var(--surface-1)] px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={!qaInstruction.trim()}
          className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-40"
        >
          {t("subtask.addBtn")}
        </button>
        <button
          onClick={handleMarkSuccess}
          disabled={!activeSeg}
          title={
            activeSeg
              ? t("subtask.markSuccessTitle")
              : t("subtask.markSuccessDisabledTitle")
          }
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
        >
          {activeSeg && activeSeg.success_frame_index === currentFrame
            ? t("subtask.clearSuccess")
            : t("subtask.markSuccess")}
        </button>
      </div>
      <input
        type="text"
        value={qaParaphrases}
        placeholder={t("subtask.paraphrasesPlaceholder")}
        onChange={(e) => setQaParaphrases(e.target.value)}
        className="mt-2 w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-slate-300 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none"
      />

      {/* Segment strip */}
      <SegmentStrip
        segments={segments}
        lastFrame={lastFrame}
        currentFrame={currentFrame}
        activeIdx={activeIdx}
        onSeek={jumpToFrame}
        onSelect={setSelectedId}
      />

      {/* List + inspector */}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-md border border-white/5 bg-[var(--surface-0)]/50">
          <div className="border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500">
            {tp("subtask.count", segments.length)}
          </div>
          {segments.length === 0 ? (
            <div className="px-3 py-4 text-xs text-slate-500">
              {t("subtask.empty")}
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {segments.map((s) => {
                const sel = s.segment_id === selectedId;
                const active = s.segment_id === activeSeg?.segment_id;
                return (
                  <li
                    key={s.segment_id}
                    onClick={() => {
                      setSelectedId(s.segment_id);
                      jumpToFrame(s.start_frame_index);
                    }}
                    className={`flex cursor-pointer items-baseline gap-2 border-b border-white/5 px-3 py-1.5 text-sm transition-colors ${
                      sel
                        ? "bg-cyan-500/10"
                        : active
                          ? "bg-white/5"
                          : "hover:bg-white/5"
                    }`}
                  >
                    <span className="tabular text-[11px] text-slate-500">
                      #{s.segment_id}
                    </span>
                    {s.skill && (
                      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">
                        {s.skill}
                      </span>
                    )}
                    <span className="truncate text-slate-200">
                      {s.instruction}
                    </span>
                    <span className="ml-auto shrink-0 tabular text-[10px] text-slate-500">
                      {s.start_frame_index}–{s.end_frame_index}
                      {s.success_frame_index != null && (
                        <span className="ml-1 text-emerald-400">
                          ✓{s.success_frame_index}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <SegmentInspector
          segment={selectedSeg}
          currentFrame={currentFrame}
          onChange={(patch) => {
            if (!selectedSeg) return;
            mutate(
              updateSegment(segments, selectedSeg.segment_id, patch, lastFrame),
            );
          }}
          onSetSuccess={(frame) => {
            if (!selectedSeg) return;
            mutate(
              updateSegment(
                segments,
                selectedSeg.segment_id,
                { success_frame_index: frame },
                lastFrame,
              ),
            );
          }}
          onDelete={() => {
            if (!selectedSeg) return;
            mutate(removeSegment(segments, selectedSeg.segment_id, lastFrame));
            setSelectedId(null);
          }}
          onJump={(f) => jumpToFrame(f)}
        />
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-40"
        >
          {saving ? t("subtask.saving") : t("subtask.save")}
        </button>
        <button
          onClick={handleExport}
          disabled={exporting}
          title={t("subtask.exportTitle")}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-40"
        >
          {exporting ? t("subtask.exporting") : t("subtask.export")}
        </button>
        {status && <span className="text-[11px] text-slate-400">{status}</span>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Segment strip — contiguous bars over the episode timeline.
// ---------------------------------------------------------------------------

const STRIP_COLORS = [
  "#38bdf8",
  "#818cf8",
  "#f472b6",
  "#facc15",
  "#34d399",
  "#fb923c",
  "#a78bfa",
  "#22d3ee",
];

const SegmentStrip: React.FC<{
  segments: SubtaskSegment[];
  lastFrame: number;
  currentFrame: number;
  activeIdx: number;
  onSeek: (frame: number) => void;
  onSelect: (id: number) => void;
}> = ({ segments, lastFrame, currentFrame, activeIdx, onSeek, onSelect }) => {
  const t = useT();
  const span = Math.max(1, lastFrame);
  const playheadLeft = `${Math.min(100, (currentFrame / span) * 100)}%`;
  return (
    <div className="mt-3">
      <div className="relative h-7 w-full overflow-hidden rounded-md border border-white/10 bg-[var(--surface-0)]">
        {segments.map((s, i) => {
          const left = (s.start_frame_index / span) * 100;
          const width = Math.max(
            0.5,
            ((s.end_frame_index - s.start_frame_index) / span) * 100,
          );
          const color = STRIP_COLORS[i % STRIP_COLORS.length];
          return (
            <div
              key={s.segment_id}
              title={`#${s.segment_id} ${s.skill ? `[${s.skill}] ` : ""}${s.instruction}  (${s.start_frame_index}–${s.end_frame_index})`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(s.segment_id);
                onSeek(s.start_frame_index);
              }}
              className={`absolute top-0 h-full cursor-pointer overflow-hidden text-[10px] leading-7 text-slate-900/90 transition-opacity hover:opacity-90 ${
                i === activeIdx ? "opacity-100" : "opacity-70"
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: color,
                borderRight: "1px solid rgba(0,0,0,0.35)",
              }}
            >
              <span className="px-1 font-medium">{s.segment_id}</span>
            </div>
          );
        })}
        {/* success-frame ticks */}
        {segments.map((s) =>
          s.success_frame_index != null ? (
            <div
              key={`ok-${s.segment_id}`}
              className="absolute top-0 h-full w-px bg-emerald-300"
              style={{ left: `${(s.success_frame_index / span) * 100}%` }}
              title={t("subtask.successTick", {
                frame: s.success_frame_index,
              })}
            />
          ) : null,
        )}
        {/* playhead */}
        <div
          className="pointer-events-none absolute top-0 h-full w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
          style={{ left: playheadLeft }}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Segment inspector — edit the selected subtask's text fields.
// ---------------------------------------------------------------------------

const SegmentInspector: React.FC<{
  segment: SubtaskSegment | null;
  currentFrame: number;
  onChange: (
    patch: Partial<
      Pick<SubtaskSegment, "instruction" | "skill" | "paraphrases">
    >,
  ) => void;
  onSetSuccess: (frame: number | null) => void;
  onDelete: () => void;
  onJump: (frame: number) => void;
}> = ({ segment, currentFrame, onChange, onSetSuccess, onDelete, onJump }) => {
  const t = useT();
  const successValue = segment?.success_frame_index ?? null;
  const segId = segment?.segment_id;
  const [successDraft, setSuccessDraft] = useState("");
  useEffect(() => {
    setSuccessDraft(successValue != null ? String(successValue) : "");
  }, [segId, successValue]);

  if (!segment) {
    return (
      <div className="flex items-center justify-center rounded-md border border-white/5 bg-[var(--surface-0)]/50 px-3 py-4 text-xs text-slate-500">
        {t("subtask.selectToEdit")}
      </div>
    );
  }

  const seg = segment;
  const commitSuccess = (raw: string) => {
    const s = raw.trim();
    if (s === "") {
      onSetSuccess(null);
      return;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) {
      setSuccessDraft(
        seg.success_frame_index != null ? String(seg.success_frame_index) : "",
      );
      return;
    }
    const clamped = Math.max(
      seg.start_frame_index,
      Math.min(seg.end_frame_index, Math.round(n)),
    );
    onSetSuccess(clamped);
    setSuccessDraft(String(clamped));
  };

  return (
    <div className="rounded-md border border-white/5 bg-[var(--surface-0)]/50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="tabular text-[11px] text-slate-500">
          #{segment.segment_id} · {segment.start_frame_index}–
          {segment.end_frame_index}
        </span>
        <button
          onClick={() => onJump(segment.start_frame_index)}
          title={t("subtask.jumpStart")}
          className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-300 hover:text-cyan-200"
        >
          ▶
        </button>
        <button
          onClick={onDelete}
          title={t("subtask.delete")}
          className="ml-auto rounded border border-red-500/30 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"
        >
          ×
        </button>
      </div>

      <label className="block text-[10px] uppercase tracking-wide text-slate-500">
        {t("subtask.skill")}
      </label>
      <input
        list="subtask-skills"
        value={segment.skill}
        onChange={(e) => onChange({ skill: e.target.value })}
        className="mb-2 w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-sm text-slate-200 focus:border-cyan-400/50 focus:outline-none"
      />

      <label className="block text-[10px] uppercase tracking-wide text-slate-500">
        {t("subtask.instruction")}
      </label>
      <textarea
        rows={2}
        value={segment.instruction}
        onChange={(e) => onChange({ instruction: e.target.value })}
        className="mb-2 w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-sm text-slate-200 focus:border-cyan-400/50 focus:outline-none"
      />

      <label className="block text-[10px] uppercase tracking-wide text-slate-500">
        {t("subtask.paraphrases")}
      </label>
      <textarea
        rows={2}
        value={segment.paraphrases.join("\n")}
        onChange={(e) =>
          onChange({ paraphrases: parseParaphrases(e.target.value) })
        }
        className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-xs text-slate-300 focus:border-cyan-400/50 focus:outline-none"
      />

      <label className="mt-2 block text-[10px] uppercase tracking-wide text-slate-500">
        {t("subtask.successFrameLabel")}
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          value={successDraft}
          placeholder="—"
          onChange={(e) => setSuccessDraft(e.target.value)}
          onBlur={() => commitSuccess(successDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitSuccess(successDraft);
            if (e.key === "Escape") {
              setSuccessDraft(
                segment.success_frame_index != null
                  ? String(segment.success_frame_index)
                  : "",
              );
            }
          }}
          className="w-24 rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-sm tabular text-slate-200 focus:border-cyan-400/50 focus:outline-none"
        />
        <button
          onClick={() => onSetSuccess(currentFrame)}
          title={t("subtask.setCurrentTitle")}
          className="rounded border border-emerald-500/30 px-1.5 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/10"
        >
          {t("subtask.setCurrent", { frame: currentFrame })}
        </button>
        <button
          onClick={() => onSetSuccess(segment.end_frame_index)}
          title={t("subtask.setEndTitle")}
          className="rounded border border-white/10 px-1.5 py-1 text-[11px] text-slate-300 hover:text-cyan-200"
        >
          {t("subtask.setEnd", { frame: segment.end_frame_index })}
        </button>
        {segment.success_frame_index != null && (
          <button
            onClick={() => onSetSuccess(null)}
            className="rounded border border-white/10 px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-200"
          >
            {t("subtask.clearBtn")}
          </button>
        )}
      </div>
      <p className="mt-1 text-[10px] text-slate-600">
        {t("subtask.successRange", {
          start: segment.start_frame_index,
          end: segment.end_frame_index,
        })}
      </p>
    </div>
  );
};

export default SubtaskPanel;

"use client";

import "./annotations-skin.css";

/**
 * Editor UI for v3.1 language atoms.
 *
 * Three vertical sections:
 *   1. Inline quick-add bar above the timeline (style picker + label + Add).
 *   2. Annotations timeline (in `annotations-timeline.tsx`).
 *   3. Workspace below the timeline:
 *        - Left rail: full atom list grouped by style; click to select.
 *        - Right pane: editor for the selected atom (or empty state).
 *
 * Bbox / keypoint VQA atoms are still added through the canvas overlay's
 * quick-label popup; the inline quick-add covers subtask / plan / memory /
 * interjection / speech / count / attribute / spatial.
 */

import React, { useMemo, useState } from "react";
import { useTimeControls, useTimeState } from "../context/time-context";
import { useAnnotations } from "../context/annotations-context";
import { useT } from "../context/locale-context";
import type { MessageKey } from "@/i18n/messages";
import {
  buildSpeechAtom,
  classifyVqa,
  isSpeechAtom,
  parseVqaAnswer,
  speechText,
  type LanguageAtom,
} from "../types/language.types";

interface Props {
  cameraKeys: string[];
}

function fmtTime(s: number): string {
  return s.toFixed(3) + "s";
}

function StylePill({ style }: { style: string | null }) {
  const cls = style ?? "speech";
  return <span className={`style-pill ${cls}`}>{style ?? "speech"}</span>;
}

/**
 * Highlight a row when its timestamp is within ~half a frame of currentTime.
 */
function isActiveAt(ts: number, currentTime: number, fps = 30): boolean {
  return Math.abs(ts - currentTime) < 0.5 / fps;
}

type QuickAddKind =
  | "task_aug"
  | "subtask"
  | "plan"
  | "memory"
  | "interjection"
  | "speech"
  | "count"
  | "attribute"
  | "spatial";

interface QuickAddField {
  name: string;
  placeholderKey: MessageKey;
  type?: "text" | "number";
  width?: string;
  grow?: boolean;
}

interface QuickAddBuildCtx {
  ts: number;
  vqaCamera: string | null;
}

interface QuickAddDef {
  kind: QuickAddKind;
  labelKey: MessageKey;
  /** When true, the displayed timestamp is 0 (atom is pinned to episode start). */
  atEpisodeStart?: boolean;
  fields: QuickAddField[];
  build: (
    values: Record<string, string>,
    ctx: QuickAddBuildCtx,
  ) => LanguageAtom[] | null;
}

// Each text-style atom kind (and the simpler VQA shapes) is one entry: how
// it appears in the dropdown, what fields the user fills, and how those
// values map to one or two language atoms.
const QUICK_ADD_DEFS: QuickAddDef[] = [
  {
    kind: "task_aug",
    labelKey: "ann.qa.task_aug",
    atEpisodeStart: true,
    fields: [
      {
        name: "label",
        placeholderKey: "ann.ph.taskAug",
        grow: true,
      },
    ],
    build: ({ label }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "user",
          content: text,
          style: "task_aug",
          timestamp: 0,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "subtask",
    labelKey: "ann.qa.subtask",
    fields: [
      {
        name: "label",
        placeholderKey: "ann.ph.subtask",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "assistant",
          content: text,
          style: "subtask",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "plan",
    labelKey: "ann.qa.plan",
    fields: [
      {
        name: "label",
        placeholderKey: "ann.ph.plan",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "assistant",
          content: text,
          style: "plan",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "memory",
    labelKey: "ann.qa.memory",
    fields: [
      {
        name: "label",
        placeholderKey: "ann.ph.memory",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "assistant",
          content: text,
          style: "memory",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "interjection",
    labelKey: "ann.qa.interjection",
    fields: [
      {
        name: "label",
        placeholderKey: "ann.ph.interjection",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [
        {
          role: "user",
          content: text,
          style: "interjection",
          timestamp: ts,
          camera: null,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "speech",
    labelKey: "ann.qa.speech",
    fields: [
      {
        name: "label",
        placeholderKey: "ann.ph.speech",
        grow: true,
      },
    ],
    build: ({ label }, { ts }) => {
      const text = label.trim();
      if (!text) return null;
      return [buildSpeechAtom(ts, text)];
    },
  },
  {
    kind: "count",
    labelKey: "ann.qa.count",
    fields: [
      { name: "label", placeholderKey: "ann.ph.countLabel", grow: true },
      {
        name: "count",
        placeholderKey: "ann.ph.count",
        type: "number",
        width: "80px",
      },
    ],
    build: ({ label, count }, { ts, vqaCamera }) => {
      const text = label.trim();
      if (!text || !count) return null;
      return [
        {
          role: "user",
          content: `How many ${text}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({ label: text, count: Number(count) }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "attribute",
    labelKey: "ann.qa.attribute",
    fields: [
      { name: "label", placeholderKey: "ann.ph.label", width: "120px" },
      {
        name: "attribute",
        placeholderKey: "ann.ph.attribute",
        width: "120px",
      },
      { name: "value", placeholderKey: "ann.ph.value", grow: true },
    ],
    build: ({ label, attribute, value }, { ts, vqaCamera }) => {
      const text = label.trim();
      if (!text || !attribute || !value) return null;
      return [
        {
          role: "user",
          content: `What ${attribute} is the ${text}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({ label: text, attribute, value }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      ];
    },
  },
  {
    kind: "spatial",
    labelKey: "ann.qa.spatial",
    fields: [
      { name: "subject", placeholderKey: "ann.ph.subject", width: "100px" },
      {
        name: "relation",
        placeholderKey: "ann.ph.relation",
        width: "130px",
      },
      { name: "object", placeholderKey: "ann.ph.object", grow: true },
    ],
    build: ({ subject, relation, object }, { ts, vqaCamera }) => {
      if (!subject || !relation || !object) return null;
      return [
        {
          role: "user",
          content: `Where is the ${subject} relative to the ${object}?`,
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
        {
          role: "assistant",
          content: JSON.stringify({ subject, relation, object }),
          style: "vqa",
          timestamp: ts,
          camera: vqaCamera,
          tool_calls: null,
        },
      ];
    },
  },
];

const QUICK_ADD_DEFS_BY_KIND: Record<QuickAddKind, QuickAddDef> =
  QUICK_ADD_DEFS.reduce(
    (acc, def) => {
      acc[def.kind] = def;
      return acc;
    },
    {} as Record<QuickAddKind, QuickAddDef>,
  );

interface RailGroupDef {
  key: string;
  title: string;
  dotClass: string;
  // Which v3.1 language column this style is written to. Used to group the
  // rail under "Persistent" vs "Events" headers so it's clear at a glance
  // that task_aug / subtask / plan / memory broadcast across the whole
  // episode (language_persistent) while interjection / speech / vqa fire on
  // a single frame (language_events). Mirrors columnForStyle() exactly.
  column: "persistent" | "events";
  match: (
    atom: LanguageAtom,
    otherCamera: (a: LanguageAtom) => boolean,
  ) => boolean;
  label: (
    atom: LanguageAtom,
    helpers: {
      activeCamera: string | null;
      firstLine: (s: string | null) => string;
      empty: string;
    },
  ) => string;
}

const RAIL_GROUPS: RailGroupDef[] = [
  {
    key: "task_aug",
    title: "task aug",
    dotClass: "dot-task-aug",
    column: "persistent",
    match: (a) => a.style === "task_aug",
    label: (a, { empty }) => a.content || empty,
  },
  {
    key: "subtask",
    title: "subtask",
    dotClass: "dot-subtask",
    column: "persistent",
    match: (a) => a.style === "subtask",
    label: (a, { empty }) => a.content || empty,
  },
  {
    key: "plan",
    title: "plan",
    dotClass: "dot-plan",
    column: "persistent",
    match: (a) => a.style === "plan",
    label: (a, { firstLine }) => firstLine(a.content),
  },
  {
    key: "memory",
    title: "memory",
    dotClass: "dot-memory",
    column: "persistent",
    match: (a) => a.style === "memory",
    label: (a, { firstLine }) => firstLine(a.content),
  },
  {
    key: "interjection",
    title: "interjection",
    dotClass: "dot-interjection",
    column: "events",
    match: (a) => a.style === "interjection",
    label: (a, { empty }) => a.content || empty,
  },
  {
    key: "speech",
    title: "speech",
    dotClass: "dot-speech",
    column: "events",
    match: (a) => isSpeechAtom(a),
    label: (a, { empty }) => speechText(a) || empty,
  },
  {
    key: "vqa",
    title: "vqa",
    dotClass: "dot-vqa",
    column: "events",
    match: (a, otherCamera) => a.style === "vqa" && !otherCamera(a),
    label: (a, { activeCamera }) => {
      const role = a.role === "user" ? "Q" : "A";
      const t = a.content || "";
      const cameraSuffix =
        a.camera && a.camera !== activeCamera ? `  [${a.camera}]` : "";
      return `${role}: ${t.slice(0, 60)}${t.length > 60 ? "…" : ""}${cameraSuffix}`;
    },
  },
];

function useJump(): (ts: number) => void {
  // Controls only — subscribing to the state context here would re-render
  // every jump-capable panel on each throttled playback tick.
  const { seek, setIsPlaying } = useTimeControls();
  return React.useCallback(
    (ts: number) => {
      seek(ts, "external");
      setIsPlaying(false);
    },
    [seek, setIsPlaying],
  );
}

export const AnnotationsPanel: React.FC<Props> = ({ cameraKeys }) => {
  const t = useT();
  const {
    atoms,
    addAtoms,
    updateAtom,
    deleteAtom,
    snap,
    save,
    saving,
    dirty,
    activeCamera,
    setActiveCamera,
    setDrawMode,
    selectedIdx,
    selectAtom,
  } = useAnnotations();
  const { currentTime } = useTimeState();

  // ============ Inline quick-add state ============
  const [qaKind, setQaKind] = useState<QuickAddKind>("subtask");
  const [qaValues, setQaValues] = useState<Record<string, string>>({});
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const qaDef = QUICK_ADD_DEFS_BY_KIND[qaKind];

  // Initialize active camera once cameras arrive.
  React.useEffect(() => {
    if (!activeCamera && cameraKeys.length > 0) setActiveCamera(cameraKeys[0]);
  }, [activeCamera, cameraKeys, setActiveCamera]);

  // The Annotations tab keeps the canvas overlay in "auto" mode the whole
  // time — drag = bbox, click = keypoint.
  React.useEffect(() => {
    setDrawMode("auto");
    return () => setDrawMode("off");
  }, [setDrawMode]);

  // ============ Atom grouping for the rail ============
  // The rail shows one section per atom-kind. Each kind is a single config
  // entry: how to detect atoms in this kind, and how to label them in the row.
  // VQA filters out other-camera answers when the dataset has multiple
  // cameras so the rail mirrors the active video.
  const groups = useMemo(() => {
    const empty = t("ann.emptyContent");
    const firstLine = (s: string | null) => (s || "").split("\n")[0] || empty;
    const otherCamera = (a: LanguageAtom): boolean =>
      !!activeCamera &&
      cameraKeys.length > 1 &&
      a.camera != null &&
      a.camera !== activeCamera;
    return RAIL_GROUPS.map((def) => {
      const entries = atoms
        .map((atom, idx) => ({ atom, idx }))
        .filter(({ atom }) => def.match(atom, otherCamera))
        .map(({ atom, idx }) => ({
          atom,
          idx,
          label: def.label(atom, { activeCamera, firstLine, empty }),
        }))
        .sort((a, b) => a.atom.timestamp - b.atom.timestamp);
      return { def, entries };
    });
  }, [atoms, activeCamera, cameraKeys.length, t]);

  // ============ Quick-add handler ============
  // VQA quick-adds inherit the active camera so per-camera filtering shows
  // them in the right rail / overlay. Non-VQA atoms stay camera-agnostic
  // (the def's `build` ignores `vqaCamera` for those).
  const handleQuickAdd = () => {
    const ts = snap(currentTime);
    const vqaCamera = activeCamera ?? cameraKeys[0] ?? null;
    const newAtoms = qaDef.build(qaValues, { ts, vqaCamera });
    if (!newAtoms || !newAtoms.length) return;
    addAtoms(newAtoms);
    // Select the freshly added atom (last one added) so the editor opens for it.
    selectAtom(atoms.length + newAtoms.length - 1);
    setQaValues({});
  };

  // ============ Save ============
  // Local-only: persists the episode's atoms to meta/lerobot_annotations.json
  // via the Next.js annotations route. Writing the atoms back into the parquet
  // (dataset export) is a separate, not-yet-implemented milestone.
  const handleSave = async () => {
    const r = await save();
    if (!r.ok) {
      setExportStatus(
        t("ann.saveFailed", { error: r.error || t("ann.saveUnknown") }),
      );
    } else {
      setExportStatus(
        r.path ? t("ann.savedTo", { path: r.path }) : t("ann.saved"),
      );
    }
  };

  const selectedAtom =
    selectedIdx != null && selectedIdx >= 0 && selectedIdx < atoms.length
      ? atoms[selectedIdx]
      : null;

  // ============ Render ============
  return (
    <div className="annotation-workbench">
      <div className="annotation-actionbar">
        {/* No heading: the editor sub-tab above this pane already carries
            `ann.title`, so repeating it here only reads as a stutter. What is
            left is status — the unsaved pill — beside the instruction. */}
        <div className="actionbar-copy">
          <p>{t("ann.subtitle")}</p>
          {dirty && <span className="dirty-pill">{t("ann.unsaved")}</span>}
        </div>
        <div className="actionbar-actions">
          <button
            disabled={saving || !dirty}
            onClick={handleSave}
            className="text-xs h-7 px-3 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
          >
            {saving ? t("ann.saving") : t("ann.save")}
          </button>
        </div>
      </div>

      {exportStatus && <div className="save-status">{exportStatus}</div>}

      <section className="annotation-composer">
        <div className="composer-copy">
          <span className="section-kicker">{t("ann.composerKicker")}</span>
          <p>{t("ann.composerDesc")}</p>
        </div>
        <div className="quick-add">
          <span className="ts-pill">
            t = {qaDef.atEpisodeStart ? fmtTime(0) : fmtTime(currentTime)}
          </span>
          <select
            value={qaKind}
            onChange={(e) => {
              setQaKind(e.target.value as QuickAddKind);
              setQaValues({});
            }}
          >
            {QUICK_ADD_DEFS.map((d) => (
              <option key={d.kind} value={d.kind}>
                {t(d.labelKey)}
              </option>
            ))}
          </select>
          {qaDef.fields.map((f, i) => (
            <input
              key={f.name}
              type={f.type === "number" ? "number" : "text"}
              placeholder={t(f.placeholderKey)}
              className={f.grow ? "grow" : undefined}
              style={f.width ? { width: f.width } : undefined}
              value={qaValues[f.name] ?? ""}
              onChange={(e) =>
                setQaValues((v) => ({ ...v, [f.name]: e.target.value }))
              }
              onKeyDown={
                i === qaDef.fields.length - 1
                  ? (e) => e.key === "Enter" && handleQuickAdd()
                  : undefined
              }
            />
          ))}
          <button className="add-btn" onClick={handleQuickAdd}>
            {t("ann.addAtFrame")}
          </button>
        </div>
      </section>

      <div className="workspace inspector-workspace">
        <div className="rail annotation-list">
          <div className="list-head">
            <div>
              <span className="section-kicker">{t("ann.listKicker")}</span>
              <p>{t("ann.atomCount", { count: atoms.length })}</p>
            </div>
            <span className="ts-pill">{fmtTime(currentTime)}</span>
          </div>
          {atoms.length === 0 && (
            <div className="rail-empty">
              {t("ann.empty1")}
              <br />
              {t("ann.empty2")}
            </div>
          )}
          {(["persistent", "events"] as const).map((column) => {
            const colGroups = groups.filter(({ def }) => def.column === column);
            const total = colGroups.reduce(
              (n, { entries }) => n + entries.length,
              0,
            );
            if (total === 0) return null;
            return (
              <div className="rail-column" key={column}>
                <div className={`rail-column-head ${column}`}>
                  <span className="rail-column-title">
                    {column === "persistent"
                      ? t("ann.colPersistent")
                      : t("ann.colEvents")}
                  </span>
                  <span className="rail-column-sub">
                    {column === "persistent"
                      ? t("ann.colPersistentSub")
                      : t("ann.colEventsSub")}
                  </span>
                </div>
                {colGroups.map(({ def, entries }) => (
                  <RailGroup
                    key={def.key}
                    title={def.title}
                    dotClass={def.dotClass}
                    entries={entries}
                    currentTime={currentTime}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <div className="editor inspector">
          {selectedAtom == null ? (
            <div className="editor-empty">
              <span className="section-kicker">{t("ann.inspectorKicker")}</span>
              <p>{t("ann.inspectorEmpty")}</p>
            </div>
          ) : (
            <AtomEditor
              atom={selectedAtom}
              cameraKeys={cameraKeys}
              onChange={(updates) => updateAtom(selectedIdx as number, updates)}
              onDelete={() => deleteAtom(selectedAtom)}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Rail group — one row per atom, click selects.
// ---------------------------------------------------------------------------

const RailGroup: React.FC<{
  title: string;
  dotClass: string;
  entries: { atom: LanguageAtom; idx: number; label: string }[];
  currentTime: number;
}> = ({ title, dotClass, entries, currentTime }) => {
  const { selectedIdx, selectAtom } = useAnnotations();
  const jump = useJump();
  if (entries.length === 0) return null;
  return (
    <div className="rail-group">
      <div className="rail-group-head">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className={`style-dot ${dotClass}`} />
          {title}
        </span>
        <span className="count">{entries.length}</span>
      </div>
      {entries.map(({ atom, idx, label }) => {
        const sel = idx === selectedIdx;
        const active = isActiveAt(atom.timestamp, currentTime);
        return (
          <div
            key={idx}
            className={`rail-row ${sel ? "selected" : ""} ${active ? "active-now" : ""}`}
            onClick={() => {
              selectAtom(idx);
              jump(atom.timestamp);
            }}
          >
            <span className="ts">{fmtTime(atom.timestamp)}</span>
            <span className="body">{label}</span>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// AtomEditor — form for the currently selected atom.
// ---------------------------------------------------------------------------

const AtomEditor: React.FC<{
  atom: LanguageAtom;
  cameraKeys: string[];
  onChange: (updates: Partial<LanguageAtom>) => void;
  onDelete: () => void;
}> = ({ atom, cameraKeys, onChange, onDelete }) => {
  const t = useT();
  const jump = useJump();
  const { snap } = useAnnotations();
  const isSpeech = isSpeechAtom(atom);
  const cameraLabel = atom.camera ?? t("ann.allCameras");
  const roleLabel = isSpeech ? "speech" : atom.role;
  const [timestampDraft, setTimestampDraft] = useState(() =>
    String(atom.timestamp),
  );

  React.useEffect(() => {
    setTimestampDraft(String(atom.timestamp));
  }, [atom.timestamp]);

  const commitTimestamp = React.useCallback(
    (raw = timestampDraft) => {
      const next = Number(raw);
      if (!Number.isFinite(next) || next < 0) {
        setTimestampDraft(String(atom.timestamp));
        return;
      }
      onChange({ timestamp: next });
      setTimestampDraft(String(next));
    },
    [atom.timestamp, onChange, timestampDraft],
  );

  const commitSnappedTimestamp = () => {
    const parsed = Number(timestampDraft);
    const next = snap(Number.isFinite(parsed) ? parsed : atom.timestamp);
    onChange({ timestamp: next });
    setTimestampDraft(String(next));
  };

  return (
    <div className="inspector-body">
      <div className="editor-head inspector-head">
        <div className="inspector-title">
          <StylePill style={atom.style} />
          <div>
            <strong>{fmtTime(atom.timestamp)}</strong>
            <span>
              {roleLabel} · {cameraLabel}
            </span>
          </div>
        </div>
        <div className="right">
          <button
            className="icon-btn"
            title={t("ann.jumpToFrame")}
            onClick={() => jump(atom.timestamp)}
          >
            ▶
          </button>
          <button
            className="icon-btn danger"
            title={t("ann.deleteAtom")}
            onClick={onDelete}
          >
            ×
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field-label">{t("ann.timestamp")}</label>
        <div className="ts-row">
          <input
            type="text"
            inputMode="decimal"
            value={timestampDraft}
            onChange={(e) => setTimestampDraft(e.target.value)}
            onBlur={() => commitTimestamp()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTimestamp();
              if (e.key === "Escape") setTimestampDraft(String(atom.timestamp));
            }}
          />
          <button
            type="button"
            className="frame-pill"
            onPointerDown={(e) => {
              e.preventDefault();
              commitSnappedTimestamp();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                commitSnappedTimestamp();
              }
            }}
          >
            {t("ann.snapToFrame")}
          </button>
        </div>
      </div>

      {/* Content / role-specific fields */}
      {(atom.style === "task_aug" ||
        atom.style === "subtask" ||
        atom.style === "plan" ||
        atom.style === "memory" ||
        atom.style === "interjection") && (
        <div className="field">
          <label className="field-label">
            {atom.style === "subtask"
              ? t("ann.fieldSubtask")
              : atom.style === "task_aug"
                ? t("ann.fieldTaskAug")
                : atom.style === "plan"
                  ? t("ann.fieldPlan")
                  : atom.style === "memory"
                    ? t("ann.fieldMemory")
                    : t("ann.fieldInterjection")}
          </label>
          {atom.style === "task_aug" ||
          atom.style === "subtask" ||
          atom.style === "interjection" ? (
            <textarea
              rows={3}
              value={atom.content || ""}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          ) : (
            <textarea
              rows={4}
              value={atom.content || ""}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          )}
        </div>
      )}

      {isSpeech && atom.tool_calls && (
        <div className="field">
          <label className="field-label">{t("ann.fieldSpeech")}</label>
          <input
            type="text"
            value={speechText(atom) || ""}
            onChange={(e) => {
              const next = atom.tool_calls
                ? atom.tool_calls.map((tc, i) =>
                    i === 0
                      ? {
                          ...tc,
                          function: {
                            ...tc.function,
                            arguments: { text: e.target.value },
                          },
                        }
                      : tc,
                  )
                : null;
              onChange({ tool_calls: next });
            }}
          />
        </div>
      )}

      {atom.style === "vqa" && (
        <>
          <CameraField
            atom={atom}
            cameraKeys={cameraKeys}
            onChange={onChange}
          />
          <VqaEditorFields atom={atom} onChange={onChange} />
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// CameraField — surface the row-level camera tag for VQA atoms (PR 3467).
// ---------------------------------------------------------------------------

const CameraField: React.FC<{
  atom: LanguageAtom;
  cameraKeys: string[];
  onChange: (updates: Partial<LanguageAtom>) => void;
}> = ({ atom, cameraKeys, onChange }) => {
  const t = useT();
  if (atom.style !== "vqa") return null;
  if (cameraKeys.length === 0) return null;
  const value = atom.camera ?? "";
  return (
    <div className="field">
      <label className="field-label">{t("ann.fieldCamera")}</label>
      <select
        value={value}
        onChange={(e) =>
          onChange({ camera: e.target.value === "" ? null : e.target.value })
        }
      >
        <option value="">{t("ann.cameraAny")}</option>
        {cameraKeys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </div>
  );
};

const VqaEditorFields: React.FC<{
  atom: LanguageAtom;
  onChange: (updates: Partial<LanguageAtom>) => void;
}> = ({ atom, onChange }) => {
  const t = useT();
  const parsed = parseVqaAnswer(atom.content);
  const kind = parsed ? classifyVqa(parsed) : null;

  if (atom.role === "user") {
    return (
      <div className="field">
        <label className="field-label">{t("ann.fieldQuestion")}</label>
        <input
          type="text"
          value={atom.content || ""}
          onChange={(e) => onChange({ content: e.target.value })}
        />
      </div>
    );
  }

  // Assistant atom — answer JSON (raw + structured viewer)
  return (
    <div className="field">
      <label className="field-label">
        {t("ann.fieldAnswer", { kind: kind || t("ann.kindUnknown") })}
      </label>
      <textarea
        rows={5}
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }}
        value={atom.content || ""}
        onChange={(e) => onChange({ content: e.target.value })}
      />
      {parsed && kind === "bbox" && (
        <p className="text-[11px] text-slate-400 mt-1">{t("ann.tipBbox")}</p>
      )}
      {parsed && kind === "keypoint" && (
        <p className="text-[11px] text-slate-400 mt-1">
          {t("ann.tipKeypoint")}
        </p>
      )}
    </div>
  );
};

"use client";

import { useMemo, useState } from "react";
import { useT } from "@/context/locale-context";
import { CHART_CONFIG } from "@/utils/constants";

const DELIM = CHART_CONFIG.SERIES_NAME_DELIMITER;

/**
 * Live numeric readout over the 3D viewport, in the manner of MuJoCo's overlay.
 *
 * The replay already re-renders on every advance of `frame` — it is what moves
 * the model — so this reads the current row directly rather than subscribing to
 * the clock itself. Nothing is shown until a column is ticked: the `action`
 * vector is 20 values wide on the bimanual rigs, and a panel that opened with
 * all of them would cover the scene it is meant to annotate.
 *
 * The values are deliberately a size up from the axis legend beside them. That
 * legend is a caption you read once; these are the numbers the panel exists
 * for, and at the legend's 10px they read as more chrome in the corner rather
 * than as the reading.
 */
export default function UrdfValueReadout({
  columns,
  row,
  groupLabel,
}: {
  /** Selectable column keys, e.g. `action | left_tcp.x`. */
  columns: string[];
  /** The frame currently drawn. */
  row: Record<string, number> | undefined;
  /** Feature group the columns came from, shown as the panel's subtitle. */
  groupLabel: string;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);

  // Keep the reading order the dataset's own, whatever order they were ticked.
  const shown = useMemo(
    () => columns.filter((column) => selected.includes(column)),
    [columns, selected],
  );
  // The longest label decides the column width, so a value does not shift
  // sideways as the numbers change.
  const labelWidth = useMemo(
    () =>
      shown.reduce(
        (width, column) => Math.max(width, shortLabel(column).length),
        0,
      ),
    [shown],
  );

  const toggle = (column: string) =>
    setSelected((current) =>
      current.includes(column)
        ? current.filter((entry) => entry !== column)
        : [...current, column],
    );

  if (columns.length === 0) return null;

  return (
    <div className="absolute bottom-12 left-3 z-10 max-w-[min(28rem,65%)] font-mono">
      {picking && (
        <div className="mb-1 max-h-64 overflow-y-auto rounded border border-white/10 bg-slate-950/90 p-1.5 text-[11px] shadow-xl backdrop-blur-sm">
          <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
            <span className="font-sans text-[11px] text-slate-400">
              {groupLabel}
            </span>
            <button
              type="button"
              onClick={() => setSelected([])}
              disabled={selected.length === 0}
              className="font-sans text-[11px] text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-40"
            >
              {t("urdf.valuesClear")}
            </button>
          </div>
          {columns.map((column) => (
            <label
              key={column}
              className="flex cursor-pointer select-none items-center gap-1.5 rounded px-0.5 py-px hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={selected.includes(column)}
                onChange={() => toggle(column)}
                className="size-3 accent-cyan-400"
              />
              <span className="truncate text-slate-300">
                {shortLabel(column)}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="rounded border border-white/10 bg-slate-950/75 shadow backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setPicking((open) => !open)}
          aria-expanded={picking}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 font-sans text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          <span aria-hidden>{picking ? "▾" : "▸"}</span>
          {t("urdf.valuesTitle")}
          {selected.length > 0 && (
            <span className="text-slate-500">({selected.length})</span>
          )}
        </button>
        {shown.length > 0 && (
          <dl className="border-t border-white/10 px-3 py-2 text-base leading-snug">
            {shown.map((column) => (
              <div key={column} className="flex items-baseline gap-3">
                <dt
                  className="shrink-0 text-slate-400"
                  style={{ width: `${labelWidth}ch` }}
                >
                  {shortLabel(column)}
                </dt>
                <dd className="tabular-nums font-medium text-cyan-200">
                  {formatValue(row?.[column])}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

/** `action | left_tcp.x` reads as `left_tcp.x`; the group is in the subtitle. */
function shortLabel(column: string): string {
  return column.split(DELIM).at(-1)?.trim() || column;
}

/**
 * Millimetre resolution, sign-aligned with a figure space so a value does not
 * jump one character sideways when it crosses zero.
 */
function formatValue(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : " ";
  return `${sign}${Math.abs(value).toFixed(3)}`;
}

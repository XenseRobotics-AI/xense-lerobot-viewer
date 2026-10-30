"use client";

import type { InterruptedConversion } from "@/lib/local-datasets-discovery";
import { formatBytes } from "@/utils/byteSize";
import { getDatasetPrefix, getDatasetTaskName } from "@/utils/datasetGrouping";
import { useLocale } from "@/context/locale-context";

/**
 * Conversions that stopped part-way, shown above the dataset grid.
 *
 * These are not datasets and are deliberately not rendered as ones: discovery
 * keys on `meta/info.json`, so a directory holding only a checkpoint is
 * invisible everywhere else in the app — no card, no health badge, not even a
 * scan error — while still holding every byte it had written. One on this
 * machine sat at 9.2 GB that way until someone went looking with `du`.
 *
 * It is a section of its own rather than an entry in `DatasetCardGrid`, and
 * that is the whole design: a finished dataset's card, the corpus tape, the
 * source panels and the daily snapshot all read from `datasets`, which this
 * never joins. Nothing about a normal card changes because nothing about a
 * normal card can see this.
 *
 * No Delete button, because there is nothing behind one: `local-dataset-trash`
 * requires `meta/info.json` before it will move a directory, precisely so a
 * stray encoded path cannot rename an arbitrary folder. Resuming the conversion
 * or removing the directory by hand are the two ways out, and both live outside
 * the viewer.
 */
export default function InterruptedConversions({
  entries,
}: {
  entries: InterruptedConversion[];
}) {
  const { t, tp, tRich } = useLocale();
  if (entries.length === 0) return null;

  return (
    <section className="mb-6 rounded-md border border-dashed border-amber-500/40 bg-amber-500/[0.06] p-4">
      <h2 className="text-sm font-semibold text-amber-200">
        {tp("interrupted.title", entries.length)}
      </h2>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-amber-100/70">
        {tRich("interrupted.hint", {
          file: <code className="font-mono">meta/info.json</code>,
        })}
      </p>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => {
          // Same two-line treatment as a dataset card: a bare task name is
          // ambiguous once the list spans sources, and a single-segment path
          // has no source to name.
          const taskName = getDatasetTaskName(entry.relativePath);
          const sourceName = entry.relativePath.includes("/")
            ? getDatasetPrefix(entry.relativePath)
            : null;
          return (
            <li
              key={entry.relativePath}
              title={entry.relativePath}
              className="rounded-md border border-amber-500/25 bg-[var(--surface-1)]/50 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {sourceName && (
                    <p className="truncate text-[10px] uppercase tracking-wide text-slate-500">
                      {sourceName}
                    </p>
                  )}
                  <p className="truncate text-sm font-medium text-slate-200">
                    {taskName}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-medium text-slate-900">
                  {t("interrupted.badge")}
                </span>
              </div>

              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span className="tabular text-slate-300">
                  {formatBytes(entry.sizeBytes)}
                </span>
                <span aria-hidden>·</span>
                <span>
                  {entry.episodesConverted === null
                    ? t("interrupted.unknownProgress")
                    : tp("interrupted.episodes", entry.episodesConverted)}
                </span>
                {entry.updatedDay && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular">
                      {t("interrupted.stopped", { day: entry.updatedDay })}
                    </span>
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

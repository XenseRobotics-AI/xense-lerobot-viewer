"use client";

import { useEffect, useMemo, useState } from "react";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import {
  computeWorkbenchRollup,
  type WorkbenchRollupDataset,
  type WorkbenchRollupDimension,
  type WorkbenchRollupRow,
} from "@/utils/workbenchRollup";

const DIMENSIONS: Array<{
  value: WorkbenchRollupDimension;
  label: string;
}> = [
  { value: "uploader", label: "Uploader" },
  { value: "task", label: "Task" },
  { value: "robot_type", label: "robot_type" },
  { value: "source", label: "Source" },
];

type LocalDatasetsPayload = {
  datasets?: LocalDatasetSummary[];
  errors?: Array<{ path: string; message: string }>;
};

type CatalogEntry = {
  repoId?: string;
  uploader?: string | null;
  uploaderDisplayName?: string | null;
};

type CatalogPayload = { datasets?: CatalogEntry[] };

function formatHours(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function formatRows(rows: WorkbenchRollupRow[]): string {
  return rows.length === 1 ? "1 group" : `${rows.length} groups`;
}

export default function WorkbenchGroupingPanel({
  organization,
}: {
  organization: string;
}) {
  const [dimension, setDimension] =
    useState<WorkbenchRollupDimension>("uploader");
  const [datasets, setDatasets] = useState<LocalDatasetSummary[]>([]);
  const [catalog, setCatalog] = useState<Map<string, CatalogEntry>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/local-datasets", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as
          | LocalDatasetsPayload
          | { error?: string };
        if (!response.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : `Dataset listing failed (${response.status})`,
          );
        }
        return payload as LocalDatasetsPayload;
      })
      .then((payload) => {
        setDatasets(
          (payload.datasets ?? []).filter(
            (dataset) => dataset.relativePath.split("/", 1)[0] === organization,
          ),
        );
        if ((payload.errors?.length ?? 0) > 0) {
          setError(
            `${payload.errors?.length} dataset path(s) could not be scanned. The visible rows are still grouped.`,
          );
        }
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [organization, refreshToken]);

  useEffect(() => {
    if (datasets.length === 0) return;
    const orgs = [
      ...new Set(
        datasets
          .map((dataset) => dataset.relativePath.split("/")[0])
          .filter(Boolean),
      ),
    ];
    let cancelled = false;
    Promise.all(
      orgs.map(async (org) => {
        try {
          const response = await fetch(
            `/api/hf/catalog?org=${encodeURIComponent(org)}`,
            {
              cache: "no-store",
            },
          );
          if (!response.ok) return [] as CatalogEntry[];
          const payload = (await response
            .json()
            .catch(() => ({}))) as CatalogPayload;
          return payload.datasets ?? [];
        } catch {
          return [] as CatalogEntry[];
        }
      }),
    ).then((lists) => {
      if (cancelled) return;
      const next = new Map<string, CatalogEntry>();
      for (const list of lists) {
        for (const entry of list) {
          if (entry.repoId) next.set(entry.repoId, entry);
        }
      }
      setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, [datasets]);

  const rollupDatasets = useMemo<WorkbenchRollupDataset[]>(
    () =>
      datasets.map((dataset) => {
        const remote = catalog.get(dataset.relativePath);
        return {
          ...dataset,
          uploader: remote?.uploader,
          uploaderName: remote?.uploaderDisplayName,
        };
      }),
    [catalog, datasets],
  );

  const rows = useMemo(
    () => computeWorkbenchRollup(rollupDatasets, dimension),
    [dimension, rollupDatasets],
  );
  const maxHours = rows[0]?.hours ?? 0;

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">
            Grouped statistics
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Workbench rollup over the locally discovered datasets. This is
            independent of Doctor, Parquet, and episode playback.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <span>Group by</span>
          <select
            value={dimension}
            onChange={(event) =>
              setDimension(event.target.value as WorkbenchRollupDimension)
            }
            className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-slate-200 focus:border-cyan-400 focus:outline-none"
          >
            {DIMENSIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
        >
          Reload local data
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-200">
          {error}
        </div>
      )}

      {dimension === "uploader" && catalog.size === 0 && !loading && (
        <div className="rounded-lg border border-white/10 bg-white/[0.025] p-3 text-xs text-slate-500">
          Uploader metadata uses the last cached HF statistics. If every row is
          “未知”, return to the homepage and click “刷新统计”, then reload local
          data here.
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-5 text-sm text-slate-400">
          Loading local datasets…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-5 text-sm text-slate-400">
          No local datasets are available for grouping.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[640px] border-collapse text-left text-xs">
              <thead className="bg-[var(--surface-2)] text-slate-400">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Group</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Datasets
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Episodes
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">Hours</th>
                  <th className="px-3 py-2.5 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rows.map((row) => (
                  <tr key={row.group} className="text-slate-200">
                    <td className="max-w-[28rem] truncate px-3 py-2.5 font-medium">
                      {row.group}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {row.count.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {row.episodes.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatHours(row.hours)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {row.pctHours.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-white/10 bg-[var(--surface-0)]/40 p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Hours by group
              </h4>
              <span className="text-[10px] text-slate-500">
                {formatRows(rows)}
              </span>
            </div>
            <div className="space-y-2">
              {rows.slice(0, 20).map((row) => (
                <div
                  key={row.group}
                  className="grid grid-cols-[minmax(7rem,16rem)_1fr_auto] items-center gap-3 text-xs"
                >
                  <span className="truncate text-slate-400" title={row.group}>
                    {row.group}
                  </span>
                  <div className="h-5 overflow-hidden rounded bg-white/5">
                    <div
                      className="h-full rounded bg-orange-400/90 transition-[width]"
                      style={{
                        width: `${maxHours > 0 ? (row.hours / maxHours) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="w-20 text-right tabular-nums text-slate-400">
                    {formatHours(row.hours)} h
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

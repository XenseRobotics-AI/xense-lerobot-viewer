"use client";

import { useEffect, useState } from "react";
import HomepageDatasetStatistics from "@/components/homepage-dataset-statistics";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import type { DailyDelta } from "@/utils/corpusHistory";

type WorkbenchStatisticsResponse = {
  datasets?: LocalDatasetSummary[];
  errors?: Array<{ path: string; message: string }>;
  delta?: DailyDelta;
  error?: string;
};

type CatalogEntry = {
  repoId?: string;
  lastModified?: string | null;
};

type CatalogResponse = { datasets?: CatalogEntry[] };

async function readCatalog(
  organization: string,
  signal: AbortSignal,
): Promise<CatalogResponse> {
  const response = await fetch(
    `/api/hf/catalog?org=${encodeURIComponent(organization)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) return {};
  return (await response.json().catch(() => ({}))) as CatalogResponse;
}

async function refreshCatalog(
  organization: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/hf/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org: organization }),
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) return;
  // The endpoint streams progress and writes the cache at the end. Consume the
  // stream before reading it again so Workbench never sorts against a partial
  // catalog.
  const reader = response.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

export default function WorkbenchDatasetStatistics({
  organization,
}: {
  organization: string;
}) {
  const [payload, setPayload] = useState<WorkbenchStatisticsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/workbench/statistics?org=${encodeURIComponent(organization)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response
          .json()
          .catch(() => ({}))) as WorkbenchStatisticsResponse;
        if (!response.ok) {
          throw new Error(
            result.error ||
              `Workbench statistics request failed (${response.status})`,
          );
        }
        if (!result.datasets || !result.delta) {
          throw new Error("Workbench statistics response is incomplete.");
        }
        return result;
      })
      .then(async (result) => {
        // The catalog is produced by the same HF list_datasets(sort=lastModified)
        // path used by the original TacVerse Workbench. Use its order for the
        // table, while keeping local statistics as the source of numeric data.
        try {
          let catalog = await readCatalog(organization, controller.signal);
          if (!catalog.datasets?.length) {
            await refreshCatalog(organization, controller.signal);
            catalog = await readCatalog(organization, controller.signal);
          }
          const rank = new Map(
            (catalog.datasets ?? []).map((entry, index) => [
              entry.repoId,
              { index, lastModified: entry.lastModified },
            ]),
          );
          result.datasets = [...(result.datasets ?? [])].sort((a, b) => {
            const left = rank.get(a.relativePath);
            const right = rank.get(b.relativePath);
            if (left && right) {
              const leftTime = left.lastModified
                ? Date.parse(left.lastModified)
                : Number.NaN;
              const rightTime = right.lastModified
                ? Date.parse(right.lastModified)
                : Number.NaN;
              if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
                return rightTime - leftTime || left.index - right.index;
              }
              return left.index - right.index;
            }
            if (left) return -1;
            if (right) return 1;
            return a.relativePath.localeCompare(b.relativePath);
          });
        } catch {
          // A missing catalog must not hide local statistics; retain the
          // deterministic local discovery order as a fallback.
        }
        return result;
      })
      .then(setPayload)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [organization, refreshToken]);

  if (loading) {
    return (
      <section className="rounded-xl border border-white/10 bg-[var(--surface-0)]/40 p-5 text-sm text-slate-400">
        Loading dataset statistics…
      </section>
    );
  }

  if (error || !payload?.datasets || !payload.delta) {
    return (
      <section className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-5 text-sm text-amber-200">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium">
              Dataset statistics could not be loaded
            </p>
            <p className="mt-1 text-xs text-amber-200/75">
              {error || "The Workbench statistics response was incomplete."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshToken((value) => value + 1)}
            className="rounded-md border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 transition-colors hover:border-amber-200/70 hover:bg-amber-300/10"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      {(payload.errors?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200/80">
          {payload.errors?.length} dataset path
          {payload.errors?.length === 1 ? "" : "s"} could not be scanned. The
          available datasets are still shown below.
        </div>
      )}
      <HomepageDatasetStatistics
        datasets={payload.datasets}
        delta={payload.delta}
        preserveDatasetOrder
      />
    </div>
  );
}

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

export default function WorkbenchDatasetStatistics({
  organization,
  refreshToken = 0,
}: {
  organization: string;
  refreshToken?: number;
}) {
  const [payload, setPayload] = useState<WorkbenchStatisticsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

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
  }, [organization, refreshToken, retryToken]);

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
            onClick={() => setRetryToken((value) => value + 1)}
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
        rowLinkTarget="organization-workbench"
      />
    </div>
  );
}

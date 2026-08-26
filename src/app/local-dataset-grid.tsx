"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import type { DailyDelta } from "@/utils/corpusHistory";
import {
  getDatasetPrefix,
  groupDatasetsByPrefix,
} from "@/utils/datasetGrouping";
import WorkbenchGroupingPanel from "@/components/workbench-grouping-panel";
import CategoryLanding from "./category-landing";
import DatasetCardGrid from "./dataset-card-grid";

type LocalDatasetGridProps = {
  root: string;
  datasets: LocalDatasetSummary[];
  errors: { path: string; message: string }[];
  delta: DailyDelta;
};

type OrganizationView = "datasets" | "workbench";

function organizationViewFromSearch(params: URLSearchParams): OrganizationView {
  return params.get("tab") === "workbench" ? "workbench" : "datasets";
}

function organizationHref(prefix: string, view: OrganizationView): string {
  const org = encodeURIComponent(prefix);
  return view === "workbench"
    ? "/?org=" + org + "&tab=workbench"
    : "/?org=" + org;
}

/**
 * Two-level browsing router. Level 1 groups datasets by their path prefix (the
 * "org", e.g. `Xense`) into category cards; clicking one drills into level 2,
 * the scoped dataset grid. The selected category is mirrored to `?org=` via the
 * History API so the browser back button and deep-links work without forcing a
 * server refetch of the (force-dynamic) discovery.
 */
export default function LocalDatasetGrid({
  root,
  datasets,
  errors,
  delta,
}: LocalDatasetGridProps) {
  const searchParams = useSearchParams();
  const [selectedPrefix, setSelectedPrefix] = useState<string | null>(() =>
    searchParams.get("org"),
  );
  const [organizationView, setOrganizationView] = useState<OrganizationView>(
    () => organizationViewFromSearch(searchParams),
  );

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedPrefix(params.get("org"));
      setOrganizationView(organizationViewFromSearch(params));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectCategory = useCallback((prefix: string) => {
    setSelectedPrefix(prefix);
    setOrganizationView("datasets");
    window.history.pushState(
      { org: prefix, tab: "datasets" },
      "",
      organizationHref(prefix, "datasets"),
    );
    window.scrollTo({ top: 0 });
  }, []);

  const selectOrganizationView = useCallback(
    (view: OrganizationView) => {
      if (!selectedPrefix) return;
      setOrganizationView(view);
      window.history.pushState(
        { org: selectedPrefix, tab: view },
        "",
        organizationHref(selectedPrefix, view),
      );
      window.scrollTo({ top: 0 });
    },
    [selectedPrefix],
  );

  const clearCategory = useCallback(() => {
    setSelectedPrefix(null);
    setOrganizationView("datasets");
    window.history.pushState({}, "", "/");
    window.scrollTo({ top: 0 });
  }, []);

  const groups = useMemo(() => groupDatasetsByPrefix(datasets), [datasets]);

  const overall = useMemo(() => {
    let ok = 0;
    let empty = 0;
    let incomplete = 0;
    for (const ds of datasets) {
      if (ds.integrity.status === "ok") ok += 1;
      else if (ds.integrity.status === "empty") empty += 1;
      else incomplete += 1;
    }
    return { ok, empty, incomplete };
  }, [datasets]);

  const categoryDatasets = useMemo(
    () =>
      selectedPrefix
        ? datasets.filter(
            (ds) => getDatasetPrefix(ds.relativePath) === selectedPrefix,
          )
        : [],
    [datasets, selectedPrefix],
  );

  // A selected prefix with no matching datasets (e.g. a stale deep-link) falls
  // back to the category landing.
  if (selectedPrefix && categoryDatasets.length > 0) {
    if (organizationView === "workbench") {
      return (
        <main className="px-8 py-10 max-w-7xl mx-auto">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={clearCategory}
                className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => selectOrganizationView("datasets")}
                className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
              >
                Datasets
              </button>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">
                Workbench
              </p>
              <h1 className="mt-1 text-xl font-semibold text-slate-100">
                {selectedPrefix}
              </h1>
            </div>
          </div>
          <WorkbenchGroupingPanel organization={selectedPrefix} />
        </main>
      );
    }

    return (
      <DatasetCardGrid
        root={root}
        prefix={selectedPrefix}
        datasets={categoryDatasets}
        onBack={clearCategory}
      />
    );
  }

  return (
    <CategoryLanding
      root={root}
      groups={groups}
      overall={overall}
      delta={delta}
      errors={errors}
      onSelect={selectCategory}
    />
  );
}

"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import type { DailyDelta } from "@/utils/corpusHistory";
import {
  getDatasetPrefix,
  groupDatasetsByPrefix,
} from "@/utils/datasetGrouping";
import CategoryLanding from "./category-landing";
import DatasetCardGrid from "./dataset-card-grid";

type LocalDatasetGridProps = {
  root: string;
  browsePath: string;
  locations: string[];
  datasets: LocalDatasetSummary[];
  errors: { path: string; message: string }[];
  delta: DailyDelta;
};

/**
 * Two-level browsing router. Level 1 groups datasets by their path prefix (the
 * "org", e.g. `Xense`) into category cards; clicking one drills into level 2,
 * the scoped dataset grid. The selected category is mirrored to `?org=` via the
 * History API so the browser back button and deep-links work without forcing a
 * server refetch of the (force-dynamic) discovery.
 */
export default function LocalDatasetGrid({
  root,
  browsePath,
  locations,
  datasets,
  errors,
  delta,
}: LocalDatasetGridProps) {
  const searchParams = useSearchParams();
  const [selectedPrefix, setSelectedPrefix] = useState<string | null>(() =>
    searchParams.get("org"),
  );

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedPrefix(params.get("org"));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectCategory = useCallback((prefix: string) => {
    setSelectedPrefix(prefix);
    window.history.pushState(
      { org: prefix },
      "",
      `/?org=${encodeURIComponent(prefix)}`,
    );
    window.scrollTo({ top: 0 });
  }, []);

  const clearCategory = useCallback(() => {
    setSelectedPrefix(null);
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
    return (
      <DatasetCardGrid
        root={browsePath}
        prefix={selectedPrefix}
        datasets={categoryDatasets}
        canDelete={browsePath === root}
        onBack={clearCategory}
      />
    );
  }

  return (
    <CategoryLanding
      root={root}
      browsePath={browsePath}
      locations={locations}
      groups={groups}
      overall={overall}
      delta={delta}
      errors={errors}
      onSelect={selectCategory}
    />
  );
}

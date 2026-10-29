"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/context/locale-context";
import type { reviewCollectionSummary } from "@/types/episode-review.types";

type Overview = {
  summary: ReturnType<typeof reviewCollectionSummary>;
  storage_path: string;
};

export default function ReviewCollectionPanel({
  browsePath,
}: {
  browsePath: string;
}) {
  const { t } = useLocale();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const endpoint =
    "/api/local-datasets/reviews?browsePath=" + encodeURIComponent(browsePath);
  const refresh = useCallback(async () => {
    if (document.hidden || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? String(response.status));
      if (!controller.signal.aborted) {
        setOverview(result);
        setError("");
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [endpoint]);
  useEffect(() => {
    void refresh();
    const visible = () => {
      void refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const interval = window.setInterval(visible, 60000);
    return () => {
      request.current?.abort();
      request.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const summary = overview?.summary;
  return (
    <section
      aria-label={t("review.collectionTitle")}
      className="panel mb-6 p-4 text-xs text-slate-400"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-200">
          {t("review.collectionTitle")}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="text-slate-300 hover:text-white disabled:opacity-40"
          >
            {t(loading ? "review.loading" : "review.refresh")}
          </button>
          <a
            href={endpoint + "&format=csv"}
            className="text-cyan-300 hover:underline"
          >
            {t("review.exportCsv")}
          </a>
          <a
            href={endpoint + "&format=json"}
            className="text-cyan-300 hover:underline"
          >
            {t("review.exportJson")}
          </a>
        </div>
      </div>
      {summary && (
        <>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 tabular-nums">
            <span>
              {t("review.collectionDatasets", { count: summary.datasets })}
            </span>
            <span className="text-emerald-300">
              {t("review.collectionInspected", { count: summary.inspected })}
            </span>
            <span className="text-amber-300">
              {t("review.collectionPending", { count: summary.pending })}
            </span>
            <span className="text-cyan-300">
              {t("review.crossProgress", { count: summary.crossReviewed })}
            </span>
            <span>
              {t("review.collectionRecords", { count: summary.records })}
            </span>
          </div>
          {!!summary.people.length && (
            <details className="mt-3">
              <summary className="cursor-pointer">
                {t("review.collectionPeople")}
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="py-1">{t("review.reviewer")}</th>
                      <th>{t("review.checked")}</th>
                      <th>{t("review.crossReviewed")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.people.map((person) => (
                      <tr
                        key={person.reviewer}
                        className="border-t border-white/5"
                      >
                        <td className="py-1">{person.reviewer}</td>
                        <td>{person.inspected}</td>
                        <td>{person.crossReviewed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
      <p className="mt-3 text-[10px] text-slate-500">
        {t("review.collectionHint")}
      </p>
      <p className="mt-1 break-all text-[10px] text-slate-500">
        {t("review.storage", {
          path:
            overview?.storage_path ??
            browsePath + "/.xense-viewer/episode-reviews.json",
        })}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-red-300">
          {t("review.error")} {error}
        </p>
      )}
    </section>
  );
}

"use client";

import Link from "next/link";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import { useEpisodeReviewData } from "@/context/episode-reviews-context";
import {
  reviewerCounts,
  reviewStatus,
  type ReviewFilter,
} from "@/types/episode-review.types";
import { useT } from "@/context/locale-context";
import { routePathFromRepoId } from "@/utils/datasetRoute";

import type { DatasetDisplayInfo } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import VisibleEpisodePreloader, {
  type EpisodePreloadOptions,
} from "./visible-episode-preloader";

interface SidebarProps {
  preload?: EpisodePreloadOptions;
  reviewPanel?: React.ReactNode;
  reviewFilter: ReviewFilter;
  onReviewFilterChange: (value: ReviewFilter) => void;
  reviewFilteredEpisodes: number[];
  datasetInfo: DatasetDisplayInfo;
  paginatedEpisodes: number[];
  episodeId: number;
  totalPages: number;
  currentPage: number;
  prevPage: () => void;
  nextPage: () => void;
  showFlaggedOnly: boolean;
  onShowFlaggedOnlyChange: (v: boolean) => void;
  onEpisodeSelect?: (ep: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  preload,
  datasetInfo,
  reviewPanel,
  reviewFilter,
  onReviewFilterChange,
  reviewFilteredEpisodes,
  paginatedEpisodes,
  episodeId,
  totalPages,
  currentPage,
  prevPage,
  nextPage,
  showFlaggedOnly,
  onShowFlaggedOnlyChange,
  onEpisodeSelect,
}) => {
  const t = useT();
  const [mobileVisible, setMobileVisible] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { file: reviewFile, loaded: reviewsLoaded } = useEpisodeReviewData();
  const reviewedCount = Object.values(reviewFile.episodes).filter(
    (records) => records.length > 0,
  ).length;
  const countsByReviewer = useMemo(
    () => reviewerCounts(reviewFile),
    [reviewFile],
  );
  const { flagged, count, toggle } = useFlaggedEpisodes();

  const displayEpisodes = useMemo(() => {
    if (!showFlaggedOnly || count === 0) return paginatedEpisodes;
    const allowed = new Set(reviewFilteredEpisodes);
    return [...flagged].filter((id) => allowed.has(id)).sort((a, b) => a - b);
  }, [
    paginatedEpisodes,
    showFlaggedOnly,
    flagged,
    count,
    reviewFilteredEpisodes,
  ]);

  const displayEpisodeKey = displayEpisodes.join(",");
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !active) return;
    const viewport = list.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom)
      list.scrollTop += item.bottom - viewport.bottom;
  }, [episodeId, displayEpisodeKey, mobileVisible, reviewsLoaded]);

  return (
    <div className="flex z-10 min-h-0 shrink-0">
      {preload && (
        <VisibleEpisodePreloader
          {...preload}
          listRef={listRef}
          listKey={displayEpisodeKey + ":" + mobileVisible}
          episodeId={episodeId}
        />
      )}
      <nav
        className={`shrink-0 min-h-0 flex-col overflow-hidden bg-[var(--surface-0)] border-r border-white/5 p-4 break-words w-60 ${
          mobileVisible ? "flex" : "hidden"
        } md:flex`}
        aria-label={t("nav.aria")}
      >
        <div className="shrink-0" data-review-sidebar-header="true">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-400 tabular">
            <dt className="uppercase tracking-wide text-[10px] text-slate-500">
              {t("common.frames")}
            </dt>
            <dd className="text-slate-200">
              {datasetInfo.total_frames.toLocaleString()}
            </dd>
            <dt className="uppercase tracking-wide text-[10px] text-slate-500">
              {t("common.episodes")}
            </dt>
            <dd className="text-slate-200">
              {datasetInfo.total_episodes.toLocaleString()}
            </dd>
            <dt className="uppercase tracking-wide text-[10px] text-slate-500">
              FPS
            </dt>
            <dd className="text-slate-200">{datasetInfo.fps}</dd>
          </dl>

          {reviewPanel && <div className="mt-3">{reviewPanel}</div>}

          <div className="mt-4 space-y-2 text-[11px] text-slate-400">
            <p className="text-emerald-300">
              {reviewsLoaded
                ? t("review.progress", {
                    reviewed: reviewedCount,
                    total: datasetInfo.total_episodes,
                  }) +
                  " · " +
                  (datasetInfo.total_episodes > 0
                    ? (
                        (reviewedCount / datasetInfo.total_episodes) *
                        100
                      ).toFixed(1)
                    : "0.0") +
                  "%"
                : t("review.loading")}
            </p>
            <p>
              {t("review.crossProgress", {
                count: Object.values(reviewFile.episodes).filter(
                  (records) => reviewStatus(records) === "crossReviewed",
                ).length,
              })}
            </p>
            <label className="block">
              <span className="sr-only">{t("review.filter")}</span>
              <select
                value={reviewFilter}
                disabled={!reviewsLoaded}
                onChange={(event) =>
                  onReviewFilterChange(event.target.value as ReviewFilter)
                }
                className="w-full rounded border border-white/10 bg-[var(--surface-0)] px-2 py-1"
              >
                <option value="all">{t("review.filterAll")}</option>
                <option value="reviewed">{t("review.filterReviewed")}</option>
                <option value="unreviewed">
                  {t("review.filterUnreviewed")}
                </option>
                <option value="pending">{t("review.filterPending")}</option>
                <option value="crossReviewed">
                  {t("review.filterCrossReviewed")}
                </option>
                <option value="pendingMine">
                  {t("review.filterPendingMine")}
                </option>
                <option value="mine">{t("review.filterMine")}</option>
              </select>
            </label>
            <details>
              <summary className="cursor-pointer">
                {t("review.byReviewer")}
              </summary>
              <ul className="mt-1 space-y-1">
                {countsByReviewer.map(([name, count]) => (
                  <li key={name} className="flex justify-between gap-2">
                    <span className="truncate">{name}</span>
                    <span>{count}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {t("nav.episodeList")}
            </p>
            {count > 0 && (
              <button
                onClick={() => onShowFlaggedOnlyChange(!showFlaggedOnly)}
                className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md transition-colors ${
                  showFlaggedOnly
                    ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
                    : "text-slate-500 hover:text-slate-300 border border-white/10"
                }`}
              >
                {t("nav.flagged", { count })}
              </button>
            )}
          </div>
        </div>
        <div
          ref={listRef}
          data-episode-scroll="true"
          className="min-h-0 flex-1 overflow-y-auto pt-2"
        >
          <ul className="space-y-px">
            {displayEpisodes.map((episode) => {
              const active = episode === episodeId;
              const itemClass = `group flex items-center justify-between gap-2 px-2 py-1 rounded-md text-xs tabular transition-colors ${
                active
                  ? "bg-cyan-400/10 text-cyan-300"
                  : "text-slate-300 hover:bg-white/5"
              }`;
              return (
                <li key={episode}>
                  <div className={itemClass}>
                    {/*
                    Always a real link. Tabs that select in-page pass
                    `onEpisodeSelect` and intercept the plain left-click, but
                    the href has to stay so Cmd/middle-click still opens a new
                    tab and "copy link address" still works.
                  */}
                    <Link
                      href={routePathFromRepoId(datasetInfo.repoId, episode)}
                      prefetch={false}
                      data-episode-link="true"
                      data-episode-id={episode}
                      aria-current={active ? "page" : undefined}
                      onClick={
                        onEpisodeSelect
                          ? (event) => {
                              if (
                                event.defaultPrevented ||
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              ) {
                                return;
                              }
                              event.preventDefault();
                              onEpisodeSelect(episode);
                            }
                          : undefined
                      }
                      className="flex-1 text-left"
                    >
                      {t("nav.episodeItem", { index: episode })}
                    </Link>
                    {(reviewFile.episodes[String(episode)]?.length ?? 0) >
                      0 && (
                      <span
                        className="text-emerald-300"
                        role="img"
                        aria-label={t("review.checkedBy", {
                          names: reviewFile.episodes[String(episode)]
                            .map((review) => review.reviewer)
                            .join(", "),
                        })}
                        title={t("review.checkedBy", {
                          names: reviewFile.episodes[String(episode)]
                            .map((review) => review.reviewer)
                            .join(", "),
                        })}
                      >
                        {reviewStatus(
                          reviewFile.episodes[String(episode)] ?? [],
                        ) === "crossReviewed"
                          ? "✓✓"
                          : "✓"}
                      </span>
                    )}
                    <button
                      onClick={() => toggle(episode)}
                      className={`text-xs leading-none transition-colors ${
                        flagged.has(episode)
                          ? "text-orange-400 hover:text-orange-300"
                          : "text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100"
                      }`}
                      title={
                        flagged.has(episode) ? t("nav.unflag") : t("nav.flag")
                      }
                    >
                      ⚑
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {displayEpisodes.length === 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {t("review.noMatches")}
            </p>
          )}
        </div>

        {!showFlaggedOnly && totalPages > 1 && (
          <div className="mt-3 flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wide text-slate-400">
            <button
              onClick={prevPage}
              className={`px-2 py-1 rounded-md border border-white/10 transition-colors hover:bg-white/5 hover:text-slate-200 ${
                currentPage === 1 ? "cursor-not-allowed opacity-40" : ""
              }`}
              disabled={currentPage === 1}
            >
              ‹ {t("common.prev")}
            </button>
            <span className="tabular text-slate-500">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={nextPage}
              className={`ml-auto px-2 py-1 rounded-md border border-white/10 transition-colors hover:bg-white/5 hover:text-slate-200 ${
                currentPage === totalPages
                  ? "cursor-not-allowed opacity-40"
                  : ""
              }`}
              disabled={currentPage === totalPages}
            >
              {t("common.next")} ›
            </button>
          </div>
        )}
      </nav>

      <button
        className="mx-1 flex items-center opacity-50 hover:opacity-100 focus:outline-none focus:ring-0 md:hidden"
        onClick={() => setMobileVisible((prev) => !prev)}
        title={t("nav.toggle")}
      >
        <div className="h-10 w-1 rounded-full bg-white/20" />
      </button>
    </div>
  );
};

export default Sidebar;

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/context/locale-context";
import {
  getDisplayNameForRepoId,
  routePathFromRepoId,
} from "@/utils/datasetRoute";
import Loading from "@/components/loading-component";

/** Keep the lightweight list usable while the selected episode is decoding. */
export default function EpisodeListLoading({
  repoId,
  episodes,
  episodeId,
  onEpisodeSelect,
}: {
  repoId: string;
  episodes: number[];
  episodeId: number;
  onEpisodeSelect: (episode: number) => void;
}) {
  const t = useT();
  const size = 100;
  const selectedPage = Math.floor(
    Math.max(0, episodes.indexOf(episodeId)) / size,
  );
  const [page, setPage] = useState(selectedPage);
  useEffect(() => setPage(selectedPage), [selectedPage]);
  const pages = Math.max(1, Math.ceil(episodes.length / size));
  return (
    <div className="flex h-screen bg-[var(--bg)] text-slate-200">
      <nav
        data-episode-preloaded="true"
        aria-label={t("nav.aria")}
        className="w-60 shrink-0 overflow-y-auto border-r border-white/5 bg-[var(--surface-0)] p-4"
      >
        <Link href="/" className="text-xs text-cyan-300">
          {t("viewer.home")}
        </Link>
        <p className="mt-4 break-words text-xs">
          {getDisplayNameForRepoId(repoId)}
        </p>
        <p className="mt-2 text-xs text-slate-400">
          {t("nav.episodeList")} · {episodes.length.toLocaleString()}
        </p>
        <ul className="mt-3 space-y-1">
          {episodes.slice(page * size, (page + 1) * size).map((episode) => (
            <li key={episode}>
              <Link
                href={routePathFromRepoId(repoId, episode)}
                prefetch={false}
                aria-current={episode === episodeId ? "page" : undefined}
                onClick={(event) => {
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onEpisodeSelect(episode);
                }}
                className={
                  "block rounded-md px-2 py-1 text-xs " +
                  (episode === episodeId
                    ? "bg-cyan-400/10 text-cyan-300"
                    : "hover:bg-white/5")
                }
              >
                {t("nav.episodeItem", { index: episode })}
              </Link>
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
              className="disabled:opacity-40"
            >
              {t("common.prev")}
            </button>
            <span>
              {page + 1} / {pages}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pages}
              onClick={() => setPage((value) => value + 1)}
              className="disabled:opacity-40"
            >
              {t("common.next")}
            </button>
          </div>
        )}
      </nav>
      <div className="relative min-w-0 flex-1" aria-busy="true">
        <Loading />
      </div>
    </div>
  );
}

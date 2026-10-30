"use client";

import { useEffect, useState, type RefObject } from "react";
import { useTimeState } from "@/context/time-context";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { EPISODE_CACHE_POLICY } from "@/utils/episodeCachePolicy";
import {
  canPrefetchEpisode,
  episodePrefetchBusy,
  prefetchEpisodeDataSafe,
  pruneEpisodeDataCache,
  setEpisodePrefetchTargets,
} from "@/app/[org]/[dataset]/[episode]/fetch-data";

export interface EpisodePreloadOptions {
  org: string;
  dataset: string;
  enabled: boolean;
}

/** A leaf subscriber: scrolling and playback ticks never redraw the viewer. */
export default function VisibleEpisodePreloader({
  listRef,
  listKey,
  episodeId,
  org,
  dataset,
  enabled,
}: EpisodePreloadOptions & {
  listRef: RefObject<HTMLDivElement | null>;
  listKey: string;
  episodeId: number;
}) {
  const [visibleKey, setVisibleKey] = useState("");
  const { isPlaying } = useTimeState();
  const documentVisible = useDocumentVisible();

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setVisibleKey("");
    const rows = [...list.querySelectorAll<HTMLElement>("[data-episode-id]")];
    const visible = new Set<number>();
    const publish = () =>
      setVisibleKey([...visible].sort((a, b) => a - b).join(","));
    if (typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = Number((entry.target as HTMLElement).dataset.episodeId);
            if (
              entry.isIntersecting &&
              entry.intersectionRect.height > 0 &&
              entry.intersectionRect.width > 0
            )
              visible.add(id);
            else visible.delete(id);
          }
          publish();
        },
        { root: list, rootMargin: "0px", threshold: [0, 0.01] },
      );
      rows.forEach((row) => observer.observe(row));
      return () => observer.disconnect();
    }
    // Older browsers: coalesce scrolling/resizing into one geometry read.
    let frame = 0;
    const measure = () => {
      frame = 0;
      visible.clear();
      const root = list.getBoundingClientRect();
      if (root.width && root.height)
        for (const row of rows) {
          const bounds = row.getBoundingClientRect();
          if (
            bounds.bottom > root.top &&
            bounds.top < root.bottom &&
            bounds.width
          )
            visible.add(Number(row.dataset.episodeId));
        }
      publish();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    list.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      list.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [listRef, listKey]);

  useEffect(
    () =>
      setEpisodePrefetchTargets(
        org,
        dataset,
        visibleKey.split(",").filter(Boolean).map(Number),
        episodeId,
      ),
    [org, dataset, visibleKey, episodeId],
  );

  useEffect(() => {
    const timer = setInterval(
      pruneEpisodeDataCache,
      EPISODE_CACHE_POLICY.pruneIntervalMs,
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!enabled || isPlaying || !documentVisible || !visibleKey) return;
    const candidates = visibleKey
      .split(",")
      .map(Number)
      .filter((id) => id !== episodeId)
      .sort((a, b) => Math.abs(a - episodeId) - Math.abs(b - episodeId));
    const connection = (
      navigator as Navigator & {
        connection?: EventTarget & {
          saveData?: boolean;
          effectiveType?: string;
        };
      }
    ).connection;
    const allowed = () =>
      !document.hidden &&
      navigator.onLine !== false &&
      !connection?.saveData &&
      !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    let running = false;
    const cancelQueued = () => {
      clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      idle = undefined;
    };
    const schedule = () => {
      cancelQueued();
      if (!disposed && !running && allowed())
        timer = setTimeout(() => {
          if (typeof window.requestIdleCallback === "function")
            idle = window.requestIdleCallback((deadline) => {
              idle = undefined;
              if (deadline.timeRemaining() >= 8) void run();
              else schedule();
            });
          else void run();
        }, 800);
    };
    const run = async () => {
      if (disposed || !allowed()) return;
      const id = candidates.find((candidate) =>
        canPrefetchEpisode(org, dataset, candidate),
      );
      if (id === undefined) {
        if (episodePrefetchBusy()) schedule();
        return;
      }
      running = true;
      try {
        await prefetchEpisodeDataSafe(org, dataset, id);
      } finally {
        running = false;
        schedule();
      }
    };
    // Activity postpones queued work only. It never aborts shared reads or writes.
    const activity = () => {
      schedule();
    };
    const list = listRef.current;
    list?.addEventListener("scroll", activity, { passive: true });
    for (const event of ["pointerdown", "keydown", "wheel"] as const)
      window.addEventListener(event, activity, { passive: true });
    window.addEventListener("online", activity);
    window.addEventListener("offline", activity);
    connection?.addEventListener("change", activity);
    schedule();
    return () => {
      disposed = true;
      cancelQueued();
      list?.removeEventListener("scroll", activity);
      for (const event of ["pointerdown", "keydown", "wheel"] as const)
        window.removeEventListener(event, activity);
      window.removeEventListener("online", activity);
      window.removeEventListener("offline", activity);
      connection?.removeEventListener("change", activity);
    };
  }, [
    org,
    dataset,
    episodeId,
    enabled,
    isPlaying,
    documentVisible,
    visibleKey,
    listRef,
  ]);
  return null;
}

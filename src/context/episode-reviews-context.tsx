"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getLocalDatasetFileBase } from "@/utils/datasetRoute";
import {
  MAX_REVIEWER_LENGTH,
  parseReviewsFile,
  type EpisodeReviewsFile,
  type EpisodeReviewsResponse,
  type ReviewSource,
  type ReviewerProfile,
} from "@/types/episode-review.types";

const REVIEWER_KEY = "xense-reviewer-name";

function useReviewState(repoId: string, browsePath: string) {
  const [file, setFile] = useState<EpisodeReviewsFile>({
    version: 1,
    episodes: {},
  });
  const [reviewer, setReviewerState] = useState("");
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ReviewerProfile[]>([]);
  const requestRef = useRef<AbortController | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const savingRef = useRef(false);
  const endpointBase = `${getLocalDatasetFileBase(repoId)}/reviews`;

  const endpoint =
    endpointBase + "?browsePath=" + encodeURIComponent(browsePath);

  const refresh = useCallback(async () => {
    if (savingRef.current || requestRef.current || document.hidden) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const id = ++sequence.current;
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error ?? String(response.status),
        );
      const result = (await response.json()) as EpisodeReviewsResponse;
      const next = parseReviewsFile(result.file);
      if (id !== sequence.current) return;
      setReviewers((previous) =>
        JSON.stringify(previous) === JSON.stringify(result.reviewers)
          ? previous
          : result.reviewers,
      );
      setProfiles((previous) =>
        JSON.stringify(previous) === JSON.stringify(result.profiles)
          ? previous
          : result.profiles,
      );
      setStoragePath(result.storage_path);
      setReviewerState((previous) =>
        result.reviewers.includes(previous)
          ? previous
          : (result.reviewers[0] ?? ""),
      );
      setFile((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
      setLoaded(true);
      setError(null);
    } catch (error) {
      if (!controller.signal.aborted && id === sequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [endpoint]);

  const invalidateRequests = useCallback(() => {
    sequence.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => {
    const readName = () => {
      try {
        setReviewerState(
          (localStorage.getItem(REVIEWER_KEY) ?? "").slice(
            0,
            MAX_REVIEWER_LENGTH,
          ),
        );
      } catch {
        /* Storage may be disabled. */
      }
    };
    readName();
    void refresh();
    const focus = () => {
      void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === REVIEWER_KEY) readName();
    };
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    window.addEventListener("storage", storage);
    return () => {
      invalidateRequests();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("focus", focus);
      window.removeEventListener("storage", storage);
    };
  }, [refresh, invalidateRequests]);

  useEffect(() => {
    if (!reviewer || !reviewers.includes(reviewer)) return;
    try {
      localStorage.setItem(REVIEWER_KEY, reviewer);
    } catch {
      /* Selection still works this session. */
    }
  }, [reviewer, reviewers]);

  const setReviewer = (name: string) => {
    if (reviewers.includes(name)) setReviewerState(name);
  };

  const mark = async (
    episodeIndex: number,
    source: ReviewSource,
    reviewed: boolean,
  ) => {
    if (savingRef.current || !loaded || !reviewers.includes(reviewer) || error)
      return;
    invalidateRequests();
    savingRef.current = true;
    setSaving(true);
    const id = ++sequence.current;
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode_index: episodeIndex,
          reviewer: reviewer.trim(),
          source,
          reviewed,
        }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error ?? String(response.status),
        );
      const next = parseReviewsFile(await response.json());
      if (id === sequence.current) {
        setFile(next);
        setError(null);
      }
    } catch (error) {
      if (id === sequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return {
    file,
    reviewers,
    profiles,
    storagePath,
    reviewer,
    setReviewer,
    loaded,
    saving,
    error,
    refresh,
    mark,
    endpoint,
  };
}

const ReviewsContext = createContext<ReturnType<typeof useReviewState> | null>(
  null,
);

export function EpisodeReviewsProvider({
  repoId,
  browsePath,
  children,
}: {
  repoId: string;
  browsePath: string;
  children: ReactNode;
}) {
  const value = useReviewState(repoId, browsePath);
  return (
    <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>
  );
}

export function useEpisodeReviews() {
  const value = useContext(ReviewsContext);
  if (!value)
    throw new Error("useEpisodeReviews requires EpisodeReviewsProvider");
  return value;
}

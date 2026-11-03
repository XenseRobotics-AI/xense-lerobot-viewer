"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type ReactNode,
} from "react";
import { getLocalDatasetFileBase } from "@/utils/datasetRoute";
import { ReviewSaveQueue, reviewSaveKey } from "@/utils/reviewSaveQueue";
import {
  clientReviewDiagnostics,
  createReviewId,
  reportReviewSaveResult,
  saveReviewWithDeadline,
  ReviewSaveUnknownError,
} from "@/utils/reviewDiagnosticsClient";
import type { ReviewTimerDiagnostics } from "@/types/review-diagnostics.types";
import {
  MAX_REVIEWER_LENGTH,
  parseReviewsFile,
  type EpisodeReviewsFile,
  type EpisodeReviewsResponse,
  type ReviewSource,
  type EpisodeStaySnapshot,
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
  const [pendingSaves, setPendingSaves] = useState<Record<string, boolean>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const uncertain = useRef(new Set<string>());
  const [uncertainSaves, setUncertainSaves] = useState<Record<string, boolean>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const queue = useRef(new ReviewSaveQueue()).current;
  const mounted = useRef(false);
  const endpointBase = `${getLocalDatasetFileBase(repoId)}/reviews`;

  const endpoint =
    endpointBase + "?browsePath=" + encodeURIComponent(browsePath);

  const refresh = useCallback(
    async (confirmUncertain = false) => {
      if (queue.size || requestRef.current || document.hidden) return;
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
        if (confirmUncertain && uncertain.current.size) {
          const keys = new Set(uncertain.current);
          uncertain.current.clear();
          setUncertainSaves({});
          setSaveErrors((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(([key]) => !keys.has(key)),
            ),
          );
        }
      } catch (error) {
        if (!controller.signal.aborted && id === sequence.current)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    },
    [endpoint, queue],
  );

  const invalidateRequests = useCallback(() => {
    sequence.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
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
      mounted.current = false;
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
    stay?: EpisodeStaySnapshot,
    timerDiagnostics?: ReviewTimerDiagnostics,
  ) => {
    if (!loaded || !reviewers.includes(reviewer) || error) return;
    const key = reviewSaveKey(episodeIndex, reviewer);
    if (queue.has(key) || uncertain.current.has(key)) return;
    const enqueuedAt = performance.now();
    // Capture the target before queueing; switching episodes/persons/entry
    // points must never retarget a pending write to the currently visible one.
    const payload = {
      operation_id: createReviewId(),
      diagnostics: clientReviewDiagnostics(
        !reviewed
          ? "unmark"
          : stay
            ? "present"
            : timerDiagnostics
              ? "not_ready"
              : "unknown",
        timerDiagnostics,
      ),
      episode_index: episodeIndex,
      reviewer: reviewer.trim(),
      source,
      reviewed,
      ...(reviewed && stay
        ? {
            stay_ms: Math.floor(stay.stay_ms),
            episode_duration_ms: Math.floor(stay.episode_duration_ms),
          }
        : {}),
    };
    invalidateRequests();
    setPendingSaves((previous) => ({ ...previous, [key]: true }));
    setSaveErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    try {
      await queue.enqueue(key, async () => {
        payload.diagnostics.queue_ms = Math.min(
          86400000,
          Math.max(0, Math.round(performance.now() - enqueuedAt)),
        );
        const next = await saveReviewWithDeadline(endpoint, payload, {
          report: reportReviewSaveResult,
        });
        if (mounted.current) {
          // Updating sidebar badges/filtering is lower priority than a click
          // that selects another episode or seeks the currently playing video.
          startTransition(() => setFile(next));
        }
      });
    } catch (error) {
      if (error instanceof ReviewSaveUnknownError) {
        uncertain.current.add(key);
        if (mounted.current)
          setUncertainSaves((previous) => ({ ...previous, [key]: true }));
      }
      if (mounted.current)
        setSaveErrors((previous) => ({
          ...previous,
          [key]: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (mounted.current)
        setPendingSaves((previous) => {
          const next = { ...previous };
          delete next[key];
          return next;
        });
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
    pendingSaves,
    uncertainSaves,
    saveErrors,
    error,
    refresh,
    mark,
    endpoint,
  };
}

type ReviewState = ReturnType<typeof useReviewState>;
type ReviewData = Pick<
  ReviewState,
  | "file"
  | "reviewers"
  | "profiles"
  | "storagePath"
  | "reviewer"
  | "loaded"
  | "error"
>;
const ReviewDataContext = createContext<ReviewData | null>(null);
const ReviewActionsContext = createContext<Omit<
  ReviewState,
  keyof ReviewData
> | null>(null);

type ProviderProps = {
  repoId: string;
  browsePath: string;
  children: ReactNode;
};

export function EpisodeReviewsProvider(props: ProviderProps) {
  return (
    <EpisodeReviewScope
      key={JSON.stringify([props.repoId, props.browsePath])}
      {...props}
    />
  );
}

function EpisodeReviewScope({ repoId, browsePath, children }: ProviderProps) {
  const value = useReviewState(repoId, browsePath);
  const {
    file,
    reviewers,
    profiles,
    storagePath,
    reviewer,
    loaded,
    error,
    ...actions
  } = value;
  const data = useMemo(
    () => ({ file, reviewers, profiles, storagePath, reviewer, loaded, error }),
    [file, reviewers, profiles, storagePath, reviewer, loaded, error],
  );
  return (
    <ReviewDataContext.Provider value={data}>
      <ReviewActionsContext.Provider value={actions}>
        {children}
      </ReviewActionsContext.Provider>
    </ReviewDataContext.Provider>
  );
}

export function useEpisodeReviewData() {
  const value = useContext(ReviewDataContext);
  if (!value)
    throw new Error("useEpisodeReviews requires EpisodeReviewsProvider");
  return value;
}

export function useEpisodeReviews() {
  const data = useEpisodeReviewData();
  const actions = useContext(ReviewActionsContext);
  if (!actions)
    throw new Error("useEpisodeReviews requires EpisodeReviewsProvider");
  return { ...data, ...actions };
}

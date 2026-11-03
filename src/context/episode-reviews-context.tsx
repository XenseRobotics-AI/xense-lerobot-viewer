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
import { reviewPendingOperations } from "@/utils/reviewPendingOperations";
import {
  clientReviewDiagnostics,
  createReviewId,
  reportReviewSaveResult,
  saveReviewWithDeadline,
  readEpisodeReviewState,
  readReviewOperationState,
  ReviewSaveUnknownError,
  ReviewRejectedError,
} from "@/utils/reviewDiagnosticsClient";
import type { ReviewTimerDiagnostics } from "@/types/review-diagnostics.types";
import {
  reviewOperationResolution,
  type PendingReviewOperation,
} from "@/types/review-operation.types";
import { tStandalone } from "@/i18n/standalone";
import {
  MAX_REVIEWER_LENGTH,
  type EpisodeReviewsFile,
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
  const uncertain = useRef(new Map<string, PendingReviewOperation>());
  const [uncertainSaves, setUncertainSaves] = useState<Record<string, boolean>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const recoveryScope = JSON.stringify([repoId, browsePath]);
  const sequence = useRef(0);
  const queue = useRef(new ReviewSaveQueue()).current;
  const mounted = useRef(false);
  const endpointBase = `${getLocalDatasetFileBase(repoId)}/reviews`;

  const endpoint =
    endpointBase + "?browsePath=" + encodeURIComponent(browsePath);

  const refresh = useCallback(
    async (verifyKey?: string) => {
      if (reviewPendingOperations().damaged) {
        setError(tStandalone("review.recoveryDamaged"));
        return;
      }
      if (queue.size || document.hidden) return;
      if (requestRef.current) {
        if (!verifyKey) return;
        requestRef.current.abort();
      }
      const controller = new AbortController();
      requestRef.current = controller;
      const id = ++sequence.current;
      try {
        const target = verifyKey ? uncertain.current.get(verifyKey) : undefined;
        const metadata = target
          ? undefined
          : await readEpisodeReviewState(endpoint, {
              signal: controller.signal,
            });
        const result = target
          ? await readReviewOperationState(endpoint, {
              signal: controller.signal,
              operationId: target.operation_id,
            })
          : metadata!;
        const next = result.file;
        if (id !== sequence.current) return;
        if (metadata) {
          setReviewers((previous) =>
            JSON.stringify(previous) === JSON.stringify(metadata.reviewers)
              ? previous
              : metadata.reviewers,
          );
          setProfiles((previous) =>
            JSON.stringify(previous) === JSON.stringify(metadata.profiles)
              ? previous
              : metadata.profiles,
          );
          setStoragePath(metadata.storage_path);
          setReviewerState((previous) =>
            metadata.reviewers.includes(previous)
              ? previous
              : (metadata.reviewers[0] ?? ""),
          );
          setLoaded(true);
          setError(null);
        }
        setFile((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        if (verifyKey && target) {
          const resolution = reviewOperationResolution(
            next,
            target,
            result.operation,
          );
          if (resolution === "succeeded" || resolution === "failed") {
            const recovery = reviewPendingOperations();
            recovery.resolve(recoveryScope, target);
            setRecoveryWarning(
              recovery.persistent
                ? null
                : tStandalone("review.recoveryUnavailable"),
            );
            uncertain.current.delete(verifyKey);
            setUncertainSaves((previous) => {
              const value = { ...previous };
              delete value[verifyKey];
              return value;
            });
            setSaveErrors((previous) => {
              const value = { ...previous };
              if (resolution === "failed")
                value[verifyKey] = tStandalone("review.saveEndedWithError");
              else delete value[verifyKey];
              return value;
            });
          } else if (resolution === "pending") {
            setSaveErrors((previous) => ({
              ...previous,
              [verifyKey]:
                tStandalone("review.saveStillPending") +
                " (" +
                target.operation_id +
                ")",
            }));
          } else {
            setSaveErrors((previous) => ({
              ...previous,
              [verifyKey]: new ReviewSaveUnknownError(target.operation_id)
                .message,
            }));
          }
          return {
            episode: target.episode_index,
            reviewer: target.reviewer,
            resolution,
          };
        }
      } catch (error) {
        if (!controller.signal.aborted && id === sequence.current)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    },
    [endpoint, queue, recoveryScope],
  );

  const invalidateRequests = useCallback(() => {
    sequence.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const recovery = reviewPendingOperations();
    if (recovery.damaged) {
      setError(tStandalone("review.recoveryDamaged"));
      return () => {
        mounted.current = false;
      };
    }
    const restored = recovery.list(recoveryScope);
    for (const target of restored)
      uncertain.current.set(
        reviewSaveKey(target.episode_index, target.reviewer),
        target,
      );
    setUncertainSaves(
      Object.fromEntries(
        [...uncertain.current.keys()].map((key) => [key, true]),
      ),
    );
    setSaveErrors(
      Object.fromEntries(
        [...uncertain.current].map(([key, target]) => [
          key,
          new ReviewSaveUnknownError(target.operation_id).message,
        ]),
      ),
    );
    setRecoveryWarning(
      recovery.persistent ? null : tStandalone("review.recoveryUnavailable"),
    );
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
  }, [refresh, invalidateRequests, recoveryScope]);

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
    const recovery = reviewPendingOperations();
    if (
      queue.has(key) ||
      uncertain.current.has(key) ||
      recovery.has(recoveryScope, episodeIndex, reviewer)
    )
      return;
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
    let reservation;
    try {
      reservation = recovery.begin(recoveryScope, payload);
    } catch (error) {
      setSaveErrors((previous) => ({
        ...previous,
        [key]: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    if (reservation !== "started") {
      setSaveErrors((previous) => ({
        ...previous,
        [key]: tStandalone("review.recoveryFull"),
      }));
      return;
    }
    setRecoveryWarning(
      recovery.persistent ? null : tStandalone("review.recoveryUnavailable"),
    );
    invalidateRequests();
    setPendingSaves((previous) => ({ ...previous, [key]: true }));
    setSaveErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    try {
      await queue.enqueue(key, async () => {
        if (!recovery.dispatch(recoveryScope, payload))
          throw new ReviewRejectedError(tStandalone("review.saveNotSent"));
        if (mounted.current)
          setRecoveryWarning(
            recovery.persistent
              ? null
              : tStandalone("review.recoveryUnavailable"),
          );
        payload.diagnostics.queue_ms = Math.min(
          86400000,
          Math.max(0, Math.round(performance.now() - enqueuedAt)),
        );
        const next = await saveReviewWithDeadline(endpoint, payload, {
          report: reportReviewSaveResult,
        });
        recovery.resolve(recoveryScope, payload);
        if (mounted.current) {
          setRecoveryWarning(
            recovery.persistent
              ? null
              : tStandalone("review.recoveryUnavailable"),
          );
          // Updating sidebar badges/filtering is lower priority than a click
          // that selects another episode or seeks the currently playing video.
          startTransition(() => setFile(next));
        }
      });
    } catch (error) {
      if (!(error instanceof ReviewSaveUnknownError))
        recovery.resolve(recoveryScope, payload);
      if (error instanceof ReviewRejectedError && error.file && mounted.current)
        setFile(error.file);
      if (error instanceof ReviewSaveUnknownError) {
        uncertain.current.set(key, payload);
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
    pendingVerifications: [...uncertain.current].map(([key, target]) => ({
      key,
      episode: target.episode_index,
      reviewer: target.reviewer,
      operationId: target.operation_id,
    })),
    saveErrors,
    error,
    recoveryWarning,
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

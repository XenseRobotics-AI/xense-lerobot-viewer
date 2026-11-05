"use client";

import { REVIEW_TIME_ZONE } from "@/utils/reviewTime";
import { useEffect, useId, useState } from "react";
import { useEpisodeReviews } from "@/context/episode-reviews-context";
import { reviewSaveKey } from "@/utils/reviewSaveQueue";
import { useLocale } from "@/context/locale-context";
import type { ReviewTimerDiagnostics } from "@/types/review-diagnostics.types";
import {
  REVIEWER_ROLES,
  reviewStatus,
  type EpisodeStaySnapshot,
  type ReviewSource,
} from "@/types/episode-review.types";

export default function EpisodeReviewPanel({
  episodeId,
  source,
  disabled,
  episodeDurationMs,
  readStayMs,
  readStaySnapshot,
  readDiagnostics,
}: {
  episodeId: number;
  source: ReviewSource;
  disabled: boolean;
  episodeDurationMs: number;
  readStayMs: () => number;
  readStaySnapshot: () => EpisodeStaySnapshot | undefined;
  readDiagnostics: () => ReviewTimerDiagnostics;
}) {
  const { t, locale } = useLocale();
  const {
    file,
    reviewers,
    profiles,
    storagePath,
    reviewer,
    setReviewer,
    loaded,
    pendingSaves,
    uncertainSaves,
    pendingVerifications,
    saveErrors,
    error: loadError,
    recoveryWarning,
    refresh,
    mark,
    endpoint,
  } = useEpisodeReviews();
  const key = reviewSaveKey(episodeId, reviewer);
  const saving = !!pendingSaves[key];
  const error = loadError ?? saveErrors[key];
  const pendingCount = Object.keys(pendingSaves).length;
  const otherVerifications = pendingVerifications.filter(
    (target) => target.key !== key,
  );
  const [verifying, setVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    episode: number;
    reviewer: string;
    failed: boolean;
  } | null>(null);
  const verifyPending = async (targetKey: string) => {
    setVerificationResult(null);
    setVerifying(true);
    try {
      const result = await refresh(targetKey);
      if (
        result &&
        (result.resolution === "succeeded" || result.resolution === "failed")
      )
        setVerificationResult({
          episode: result.episode,
          reviewer: result.reviewer,
          failed: result.resolution === "failed",
        });
    } finally {
      setVerifying(false);
    }
  };
  useEffect(() => {
    setVerificationResult(null);
  }, [endpoint, key]);
  const inputId = useId();
  const [, setStayTick] = useState(0);
  const reviews = file.episodes[String(episodeId)] ?? [];
  const mine = reviews.some((review) => review.reviewer === reviewer.trim());
  useEffect(() => {
    let interval: number | null = null;
    const stop = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const start = () => {
      if (document.hidden || interval !== null) return;
      interval = window.setInterval(
        () => setStayTick((value) => value + 1),
        1000,
      );
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  const saveMark = (reviewed: boolean) => {
    setVerificationResult(null);
    const stay = reviewed ? readStaySnapshot() : undefined;
    void mark(episodeId, source, reviewed, stay, readDiagnostics());
  };
  return (
    <section
      className="rounded-md border border-white/10 bg-white/[0.02] p-2 text-xs"
      aria-label={t("review.title")}
      aria-busy={saving}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            reviews.length
              ? "w-full font-medium text-emerald-300"
              : "w-full text-slate-400"
          }
        >
          {t("review.title")} ·{" "}
          {!loaded
            ? t("review.loading")
            : t(
                reviewStatus(reviews) === "unchecked"
                  ? "review.unchecked"
                  : reviewStatus(reviews) === "pending"
                    ? "review.pending"
                    : "review.crossReviewed",
              )}
        </span>
        <label htmlFor={inputId} className="sr-only">
          {t("review.reviewer")}
        </label>
        <select
          id={inputId}
          value={reviewer}
          onChange={(event) => setReviewer(event.target.value)}
          disabled={!loaded || !reviewers.length}
          className="min-w-0 flex-1 rounded border border-white/15 bg-[var(--surface-0)] px-2 py-1 text-slate-200 focus:border-cyan-400 focus:outline-none"
        >
          {!reviewers.length && (
            <option value="">{t("review.selectReviewer")}</option>
          )}
          {REVIEWER_ROLES.map((role) => {
            const group = profiles.filter((profile) => profile.role === role);
            return group.length ? (
              <optgroup
                key={role}
                label={t(
                  role === "inspector"
                    ? "review.roleInspector"
                    : role === "admin"
                      ? "review.roleAdmin"
                      : "review.roleDeveloper",
                )}
              >
                {group.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <button
          type="button"
          data-review-save
          onClick={() => saveMark(!mine)}
          disabled={
            disabled ||
            saving ||
            !!uncertainSaves[key] ||
            !loaded ||
            !reviewers.includes(reviewer) ||
            !!loadError
          }
          title={t(
            mine
              ? "review.undo"
              : reviews.length
                ? "review.crossMark"
                : "review.mark",
          )}
          className="shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-emerald-200 hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t(
            saving
              ? "review.saving"
              : mine
                ? "review.undoShort"
                : reviews.length
                  ? "review.crossMarkShort"
                  : "review.markShort",
          )}
        </button>
        <span className="tabular-nums text-[10px] text-slate-400">
          {t("review.stayCurrent", {
            stay: formatReviewDuration(readStayMs()),
            duration: formatReviewDuration(episodeDurationMs),
          })}
        </span>
        {pendingCount > 0 && (
          <span role="status" className="text-[10px] text-cyan-300">
            {t("review.backgroundSaves", { count: pendingCount })}
          </span>
        )}
      </div>
      {recoveryWarning && (
        <p role="status" className="mt-2 text-amber-300">
          {recoveryWarning}
        </p>
      )}
      {otherVerifications.length > 0 && (
        <details
          open
          className="mt-2 rounded border border-amber-400/25 p-2 text-amber-200"
        >
          <summary className="cursor-pointer">
            {t("review.otherVerifications", {
              count: otherVerifications.length,
            })}
          </summary>
          <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
            {otherVerifications.map((target) => (
              <li
                key={target.operationId}
                data-review-operation-id={target.operationId}
                className="min-w-0 rounded border border-white/10 p-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words">
                    {t("review.verificationTarget", {
                      episode: target.episode,
                      reviewer: target.reviewer,
                    })}
                  </span>
                  <button
                    type="button"
                    disabled={pendingCount > 0 || verifying}
                    onClick={() => void verifyPending(target.key)}
                    className="shrink-0 underline disabled:opacity-40"
                  >
                    {t("review.verifySave")}
                  </button>
                </div>
                <p className="mt-1 break-all text-[10px] text-slate-400">
                  {saveErrors[target.key] ?? target.operationId}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {verificationResult && (
        <p
          role="status"
          data-review-verification-result={
            verificationResult.failed ? "failed" : "succeeded"
          }
          className={
            verificationResult.failed
              ? "mt-2 break-words text-red-300"
              : "mt-2 break-words text-emerald-300"
          }
        >
          {t(
            verificationResult.failed
              ? "review.verificationFailed"
              : "review.verificationSucceeded",
            {
              episode: verificationResult.episode,
              reviewer: verificationResult.reviewer,
            },
          )}
        </p>
      )}
      <details className="mt-2 text-[10px] text-slate-400">
        <summary className="cursor-pointer hover:text-slate-200">
          {t("review.details", { count: reviews.length })}
        </summary>
        <p className="mt-2 text-slate-500">{t("review.manualHint")}</p>
        <p className="mt-1 text-slate-500">{t("review.stayHint")}</p>
        <p className="mt-2 text-[10px] text-slate-500">
          {t("review.crossHint")}
        </p>
        {loaded && reviews.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            {reviews.map((review) => (
              <li key={review.reviewer}>
                <span className="text-emerald-300">✓ {review.reviewer}</span>
                {review.role && (
                  <>
                    {" "}
                    ·{" "}
                    {t(
                      review.role === "inspector"
                        ? "review.roleInspector"
                        : review.role === "admin"
                          ? "review.roleAdmin"
                          : "review.roleDeveloper",
                    )}
                  </>
                )}{" "}
                ·{" "}
                <time dateTime={review.reviewed_at}>
                  {new Date(review.reviewed_at).toLocaleString(
                    locale === "zh" ? "zh-CN" : "en-US",
                    { timeZone: REVIEW_TIME_ZONE, hour12: false },
                  )}
                </time>{" "}
                UTC+8 ·{" "}
                {t(
                  review.source === "urdf"
                    ? "viewer.tab.urdf"
                    : "viewer.tab.episodes",
                )}
                {review.stay_ms !== undefined &&
                  review.episode_duration_ms !== undefined && (
                    <span className="block text-slate-500">
                      {t("review.stayRecorded", {
                        stay: formatReviewDuration(review.stay_ms),
                        duration: formatReviewDuration(
                          review.episode_duration_ms,
                        ),
                      })}
                    </span>
                  )}
              </li>
            ))}
          </ul>
        )}
        {loaded && !reviewers.length && (
          <p className="mt-2 text-amber-200">{t("review.noReviewers")}</p>
        )}
        {storagePath && (
          <p className="mt-2 break-all text-[10px] text-slate-500">
            {t("review.storage", { path: storagePath })}
          </p>
        )}
      </details>
      {error && (
        <div
          role="alert"
          className="mt-2 min-w-0 rounded border border-red-400/20 bg-red-400/5 p-2 text-[11px] leading-relaxed text-red-300"
        >
          <p className="font-medium">{t("review.error")}</p>
          <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {error}
          </p>
          <button
            type="button"
            disabled={saving || pendingCount > 0 || verifying}
            onClick={() => {
              if (uncertainSaves[key]) void verifyPending(key);
              else if (loadError) void refresh();
              else saveMark(!mine);
            }}
            className="mt-2 underline"
          >
            {t(
              uncertainSaves[key]
                ? "review.verifySave"
                : loadError
                  ? "review.retry"
                  : "review.retrySave",
            )}
          </button>
        </div>
      )}
    </section>
  );
}

function formatReviewDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, "0")}`
    : `${seconds}s`;
}

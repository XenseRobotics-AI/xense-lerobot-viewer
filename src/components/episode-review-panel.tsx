"use client";

import { REVIEW_TIME_ZONE } from "@/utils/reviewTime";
import { useId } from "react";
import { useEpisodeReviews } from "@/context/episode-reviews-context";
import { reviewSaveKey } from "@/utils/reviewSaveQueue";
import { useLocale } from "@/context/locale-context";
import {
  REVIEWER_ROLES,
  reviewStatus,
  type ReviewSource,
} from "@/types/episode-review.types";

export default function EpisodeReviewPanel({
  episodeId,
  source,
  disabled,
}: {
  episodeId: number;
  source: ReviewSource;
  disabled: boolean;
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
    saveErrors,
    error: loadError,
    refresh,
    mark,
  } = useEpisodeReviews();
  const key = reviewSaveKey(episodeId, reviewer);
  const saving = !!pendingSaves[key];
  const error = loadError ?? saveErrors[key];
  const pendingCount = Object.keys(pendingSaves).length;
  const inputId = useId();
  const reviews = file.episodes[String(episodeId)] ?? [];
  const mine = reviews.some((review) => review.reviewer === reviewer.trim());
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
          onClick={() => void mark(episodeId, source, !mine)}
          disabled={
            disabled ||
            saving ||
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
        {pendingCount > 0 && (
          <span role="status" className="text-[10px] text-cyan-300">
            {t("review.backgroundSaves", { count: pendingCount })}
          </span>
        )}
      </div>
      <details className="mt-2 text-[10px] text-slate-400">
        <summary className="cursor-pointer hover:text-slate-200">
          {t("review.details", { count: reviews.length })}
        </summary>
        <p className="mt-2 text-slate-500">{t("review.manualHint")}</p>
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
        <div role="alert" className="mt-2 text-red-300">
          {t("review.error")} <span className="break-all">{error}</span>{" "}
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (loadError) void refresh();
              else void mark(episodeId, source, !mine);
            }}
            className="underline"
          >
            {t(loadError ? "review.retry" : "review.retrySave")}
          </button>
        </div>
      )}
    </section>
  );
}

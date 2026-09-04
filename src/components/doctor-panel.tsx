"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EpisodeLengthStats } from "@/app/[org]/[dataset]/[episode]/fetch-data";
import { EpisodeLengthHistogram } from "@/components/stats-panel";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import {
  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS,
  DEFAULT_DOCTOR_SPEED_THRESHOLDS,
  DOCTOR_CHECK_IDS,
  MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND,
  MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD,
  MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND,
  extractAffectedDoctorEpisodeIds,
  extractDoctorEpisodeIdsFromMessage,
  type DoctorCheckResult,
  type DoctorDimensionJumpThresholds,
  type DoctorEpisodeRange,
  type DoctorProgress,
  type DoctorReport,
  type DoctorRunResponse,
  type DoctorSeverity,
  type DoctorSpeedThresholds,
} from "@/types/doctor.types";
import { copyTextToClipboard } from "@/utils/clipboard";
import { decodeLocalDatasetPath } from "@/utils/datasetRoute";
import { runDatasetDoctor } from "@/utils/doctorClient";
import { createWorkbenchReviewTask } from "@/utils/workbenchActions";
import { assignEpisodesToBins } from "@/utils/episodeLengthHistogram";
import { useLocale, useT } from "@/context/locale-context";
import type { MessageKey } from "@/i18n/messages";

const DEFAULT_MAX_EPISODES: number | null = null;
const DEFAULT_CUSTOM_RANGE: DoctorEpisodeRange = { start: 10, end: 100 };
const SAMPLE_OPTIONS = [
  { value: "10", labelKey: "doctor.scope10" },
  { value: "25", labelKey: "doctor.scope25" },
  { value: "50", labelKey: "doctor.scope50" },
  { value: "100", labelKey: "doctor.scope100" },
  { value: "all", labelKey: "doctor.scopeAll" },
  { value: "custom", labelKey: "doctor.scopeCustom" },
] as const satisfies readonly { value: string; labelKey: MessageKey }[];

type DoctorScopeOption = (typeof SAMPLE_OPTIONS)[number]["value"];

interface DoctorScope {
  maxEpisodes: number | null;
  episodeRange: DoctorEpisodeRange | null;
}

interface CachedDoctorRun {
  maxEpisodes: number | null;
  episodeRange: DoctorEpisodeRange | null;
  dimensionJumpThresholds?: DoctorDimensionJumpThresholds;
  speedThresholds?: DoctorSpeedThresholds;
  speedCheckEnabled?: boolean;
  result: DoctorRunResponse;
}

function scopeOptionFor(
  maxEpisodes: number | null,
  episodeRange: DoctorEpisodeRange | null,
): DoctorScopeOption {
  if (episodeRange) return "custom";
  if (maxEpisodes === null) return "all";
  return String(maxEpisodes) as DoctorScopeOption;
}

function extractDoctorFrame(message: string): number | null {
  const match = message.match(/\bframe(?:\s+|=)(\d+)\b/iu);
  return match ? Number(match[1]) : null;
}

// Conditional tab content unmounts when the user switches tabs. Keep the last
// report in module memory so returning to Doctor (or changing episodes in the
// same dataset) does not launch another expensive scan without being asked.
const doctorRunCache = new Map<string, CachedDoctorRun>();

const SEVERITY_TONE: Record<
  DoctorSeverity,
  { badge: string; border: string; dot: string; text: string }
> = {
  PASS: {
    badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    border: "border-emerald-400/20",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
  },
  WARN: {
    badge: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    border: "border-amber-400/20",
    dot: "bg-amber-400",
    text: "text-amber-300",
  },
  FAIL: {
    badge: "border-red-400/30 bg-red-400/10 text-red-300",
    border: "border-red-400/25",
    dot: "bg-red-400",
    text: "text-red-300",
  },
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function formatInteger(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function downloadReport(report: DoctorReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lerobot-doctor-${report.dataset_name ?? "report"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-80"
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

const INITIAL_PROGRESS: DoctorProgress = {
  phase: "loading",
  completed: 0,
  total: 1,
  percent: 0,
  overall_percent: 0,
  message: "",
};

function ProgressBar({ progress }: { progress: DoctorProgress }) {
  const t = useT();
  const displayedPercent =
    progress.phase === "loading"
      ? Math.max(4, progress.overall_percent)
      : progress.overall_percent;
  return (
    <div className="w-full max-w-xl" role="status" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-4 text-xs">
        <span className="truncate text-slate-400">
          {progress.message || t("doctor.loadingProgress")}
        </span>
        <span className="shrink-0 tabular text-cyan-300">
          {progress.overall_percent}%
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-white/10"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.overall_percent}
        role="progressbar"
      >
        <div
          className={`h-full rounded-full bg-cyan-400 transition-[width] duration-300 ${
            progress.phase === "loading" ? "animate-pulse" : ""
          }`}
          style={{ width: `${displayedPercent}%` }}
        />
      </div>
      {progress.phase === "checks" && (
        <p className="mt-2 text-[11px] tabular text-slate-500">
          {t("doctor.checksCompleted", {
            done: progress.completed,
            total: progress.total,
          })}
        </p>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: DoctorSeverity }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${SEVERITY_TONE[severity].badge}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${SEVERITY_TONE[severity].dot}`}
      />
      {severity}
    </span>
  );
}

function SummaryCard({
  severity,
  count,
  active,
  onClick,
}: {
  severity: DoctorSeverity;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border p-4 text-left transition-colors ${
        active
          ? `${SEVERITY_TONE[severity].border} bg-white/[0.055]`
          : "border-white/10 bg-[var(--surface-1)]/55 hover:border-white/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${SEVERITY_TONE[severity].dot}`}
        />
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
          {severity}
        </span>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tabular ${SEVERITY_TONE[severity].text}`}
      >
        {count}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        {t("doctor.checksWord")}
      </p>
    </button>
  );
}

function CheckCard({
  check,
  encodedPath,
  dimensionJumpThresholds,
  speedThresholds,
  expanded,
  onToggle,
}: {
  check: DoctorCheckResult;
  encodedPath: string | null;
  dimensionJumpThresholds: DoctorDimensionJumpThresholds;
  speedThresholds: DoctorSpeedThresholds;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, tp } = useLocale();
  const { addMany } = useFlaggedEpisodes();
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const episodeIds = useMemo(() => {
    const ids = new Set<number>();
    for (const item of check.messages) {
      if (item.severity === "PASS") continue;
      for (const id of extractDoctorEpisodeIdsFromMessage(item.message)) {
        ids.add(id);
      }
    }
    return [...ids].sort((a, b) => a - b);
  }, [check.messages]);
  const issueCount = check.messages.filter(
    (message) => message.severity !== "PASS",
  ).length;
  const createReviewTask = useCallback(
    (message: string, episodeId: number) => {
      const task = createWorkbenchReviewTask({
        organization: "local",
        source: "doctor",
        title: `${check.name} · episode ${episodeId}`,
        detail: message,
        datasetPath: encodedPath ? decodeLocalDatasetPath(encodedPath) : null,
        episodeId,
        frame: extractDoctorFrame(message),
      });
      setReviewMessage(
        task
          ? "Review task created in this browser."
          : "Unable to create review task.",
      );
    },
    [check.name, encodedPath],
  );

  return (
    <section
      className={`overflow-hidden rounded-lg border bg-[var(--surface-1)]/50 ${SEVERITY_TONE[check.severity].border}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          >
            <path d="m7 5 5 5-5 5V5z" />
          </svg>
          <SeverityBadge severity={check.severity} />
          <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
            <h3 className="truncate text-sm font-medium text-slate-200">
              {check.name}
            </h3>
            {check.name === "Dimension-Level Jump Detection" && (
              <p className="mt-0.5 text-[10px] leading-4 text-slate-500 sm:mt-0">
                {t("doctor.jumpCondition", {
                  z1: dimensionJumpThresholds.dimensionZThreshold,
                  z2: dimensionJumpThresholds.extremeSingleDimensionZ,
                })}
              </p>
            )}
            {check.name === "TCP Speed Limit Detection" && (
              <p className="mt-0.5 text-[10px] leading-4 text-slate-500 sm:mt-0">
                {t("doctor.speedCondition", {
                  lin: speedThresholds.linearMetersPerSecond,
                  ang: speedThresholds.angularDegreesPerSecond,
                })}
              </p>
            )}
          </div>
          <span className="ml-auto shrink-0 text-[11px] tabular text-slate-500">
            {issueCount > 0
              ? tp("home.groupIssues", issueCount)
              : t("doctor.clean")}
          </span>
        </button>
        {episodeIds.length > 0 && (
          <button
            type="button"
            onClick={() => addMany(episodeIds)}
            title={t("doctor.flagEpisodes", { ids: episodeIds.join(", ") })}
            className="shrink-0 rounded-md border border-orange-400/25 bg-orange-400/10 px-2 py-1 text-[10px] font-medium text-orange-300 transition-colors hover:border-orange-400/50 hover:bg-orange-400/15"
          >
            {t("doctor.flagN", { count: episodeIds.length })}
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-white/5 px-4 py-3">
          {reviewMessage && (
            <p className="text-[11px] text-emerald-300" role="status">
              {reviewMessage}
            </p>
          )}
          {check.messages.length === 0 ? (
            <p className="text-xs text-slate-500">{t("doctor.noDetail")}</p>
          ) : (
            check.messages.map((message, index) => {
              const messageEpisodeIds =
                message.severity === "PASS"
                  ? []
                  : extractDoctorEpisodeIdsFromMessage(message.message);
              const frame = extractDoctorFrame(message.message);
              return (
                <div
                  key={`${message.severity}-${index}-${message.message}`}
                  className="flex items-start gap-2.5 text-xs leading-5"
                >
                  <span
                    className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_TONE[message.severity].dot}`}
                  />
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words text-slate-300">
                      {message.message}
                    </p>
                    {encodedPath && messageEpisodeIds.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {messageEpisodeIds.map((episodeId) => {
                          const params = new URLSearchParams({ tab: "doctor" });
                          if (frame !== null)
                            params.set("frame", String(frame));
                          return (
                            <span
                              key={`${index}-${episodeId}`}
                              className="inline-flex items-center gap-2"
                            >
                              <a
                                href={`/_local/${encodedPath}/episode_${episodeId}?${params.toString()}`}
                                className="text-[10px] font-medium text-cyan-300 hover:text-cyan-100 hover:underline"
                              >
                                Open episode {episodeId}
                                {frame === null ? "" : ` · frame ${frame}`}
                              </a>
                              <button
                                type="button"
                                onClick={() =>
                                  createReviewTask(message.message, episodeId)
                                }
                                className="text-[10px] font-medium text-amber-300 hover:text-amber-100 hover:underline"
                              >
                                Review task
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

interface DoctorPanelProps {
  encodedPath: string | null;
  datasetName: string;
  episodeLengthStats: EpisodeLengthStats | null;
  episodeLengthStatsLoading: boolean;
}

export default function DoctorPanel({
  encodedPath,
  datasetName,
  episodeLengthStats,
  episodeLengthStatsLoading,
}: DoctorPanelProps) {
  const { t, tp } = useLocale();
  const { addMany } = useFlaggedEpisodes();
  const cached = encodedPath ? doctorRunCache.get(encodedPath) : undefined;
  const [scopeOption, setScopeOption] = useState<DoctorScopeOption>(
    scopeOptionFor(
      cached ? cached.maxEpisodes : DEFAULT_MAX_EPISODES,
      cached?.episodeRange ?? null,
    ),
  );
  const [customStart, setCustomStart] = useState(
    String(cached?.episodeRange?.start ?? DEFAULT_CUSTOM_RANGE.start),
  );
  const [customEnd, setCustomEnd] = useState(
    String(cached?.episodeRange?.end ?? DEFAULT_CUSTOM_RANGE.end),
  );
  const [dimensionZThreshold, setDimensionZThreshold] = useState(
    String(
      cached?.dimensionJumpThresholds?.dimensionZThreshold ??
        DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.dimensionZThreshold,
    ),
  );
  const [extremeSingleDimensionZ, setExtremeSingleDimensionZ] = useState(
    String(
      cached?.dimensionJumpThresholds?.extremeSingleDimensionZ ??
        DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.extremeSingleDimensionZ,
    ),
  );
  const [linearSpeedMetersPerSecond, setLinearSpeedMetersPerSecond] = useState(
    String(
      cached?.speedThresholds?.linearMetersPerSecond ??
        DEFAULT_DOCTOR_SPEED_THRESHOLDS.linearMetersPerSecond,
    ),
  );
  const [angularSpeedDegreesPerSecond, setAngularSpeedDegreesPerSecond] =
    useState(
      String(
        cached?.speedThresholds?.angularDegreesPerSecond ??
          DEFAULT_DOCTOR_SPEED_THRESHOLDS.angularDegreesPerSecond,
      ),
    );
  const [speedCheckEnabled, setSpeedCheckEnabled] = useState(
    cached?.speedCheckEnabled ??
      cached?.result.report.checks.some(
        (check) => check.name === "TCP Speed Limit Detection",
      ) ??
      false,
  );
  const [result, setResult] = useState<DoctorRunResponse | null>(
    cached?.result ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DoctorProgress>(INITIAL_PROGRESS);
  const [severityFilter, setSeverityFilter] = useState<"ALL" | DoctorSeverity>(
    "ALL",
  );
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedAffectedIds, setCopiedAffectedIds] = useState(false);
  const [copiedDoctorDetails, setCopiedDoctorDetails] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
      scope: DoctorScope,
      dimensionJumpThresholds: DoctorDimensionJumpThresholds,
      speedThresholds: DoctorSpeedThresholds,
      speedCheckEnabled: boolean,
      refresh = false,
    ) => {
      if (!encodedPath) {
        setError(t("doctor.localOnly"));
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setRunning(true);
      setProgress(INITIAL_PROGRESS);
      setError(null);
      try {
        const next = await runDatasetDoctor(encodedPath, {
          maxEpisodes: scope.maxEpisodes,
          episodeRange: scope.episodeRange,
          dimensionJumpThresholds,
          speedThresholds,
          checks: DOCTOR_CHECK_IDS.filter(
            (checkId) => speedCheckEnabled || checkId !== "speed_limits",
          ),
          signal: controller.signal,
          refresh,
          onProgress: (nextProgress) => {
            if (!controller.signal.aborted) setProgress(nextProgress);
          },
        });
        if (controller.signal.aborted) return;
        setResult(next);
        doctorRunCache.set(encodedPath, {
          ...scope,
          dimensionJumpThresholds,
          speedThresholds,
          speedCheckEnabled,
          result: next,
        });
        setExpanded(
          new Set(
            next.report.checks
              .filter((check) => check.severity !== "PASS")
              .map((check) => check.name),
          ),
        );
      } catch (runError) {
        if (isAbortError(runError)) return;
        setError(
          runError instanceof Error ? runError.message : String(runError),
        );
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setRunning(false);
        }
      }
    },
    [encodedPath, t],
  );

  useEffect(() => {
    const previous = encodedPath ? doctorRunCache.get(encodedPath) : undefined;
    if (previous) {
      setScopeOption(
        scopeOptionFor(previous.maxEpisodes, previous.episodeRange),
      );
      if (previous.episodeRange) {
        setCustomStart(String(previous.episodeRange.start));
        setCustomEnd(String(previous.episodeRange.end));
      }
      setDimensionZThreshold(
        String(
          previous.dimensionJumpThresholds?.dimensionZThreshold ??
            DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.dimensionZThreshold,
        ),
      );
      setExtremeSingleDimensionZ(
        String(
          previous.dimensionJumpThresholds?.extremeSingleDimensionZ ??
            DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.extremeSingleDimensionZ,
        ),
      );
      setLinearSpeedMetersPerSecond(
        String(
          previous.speedThresholds?.linearMetersPerSecond ??
            DEFAULT_DOCTOR_SPEED_THRESHOLDS.linearMetersPerSecond,
        ),
      );
      setAngularSpeedDegreesPerSecond(
        String(
          previous.speedThresholds?.angularDegreesPerSecond ??
            DEFAULT_DOCTOR_SPEED_THRESHOLDS.angularDegreesPerSecond,
        ),
      );
      setSpeedCheckEnabled(
        previous.speedCheckEnabled ??
          previous.result.report.checks.some(
            (check) => check.name === "TCP Speed Limit Detection",
          ),
      );
      setResult(previous.result);
      setError(null);
      setExpanded(
        new Set(
          previous.result.report.checks
            .filter((check) => check.severity !== "PASS")
            .map((check) => check.name),
        ),
      );
    } else {
      setScopeOption(scopeOptionFor(DEFAULT_MAX_EPISODES, null));
      setCustomStart(String(DEFAULT_CUSTOM_RANGE.start));
      setCustomEnd(String(DEFAULT_CUSTOM_RANGE.end));
      setDimensionZThreshold(
        String(DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.dimensionZThreshold),
      );
      setExtremeSingleDimensionZ(
        String(
          DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.extremeSingleDimensionZ,
        ),
      );
      setLinearSpeedMetersPerSecond(
        String(DEFAULT_DOCTOR_SPEED_THRESHOLDS.linearMetersPerSecond),
      );
      setAngularSpeedDegreesPerSecond(
        String(DEFAULT_DOCTOR_SPEED_THRESHOLDS.angularDegreesPerSecond),
      );
      setSpeedCheckEnabled(false);
      setResult(null);
      setError(null);
      setProgress(INITIAL_PROGRESS);
      setExpanded(new Set());
    }
    return () => controllerRef.current?.abort();
  }, [encodedPath]);

  const report = result?.report ?? null;
  const parsedCustomStart = Number(customStart);
  const parsedCustomEnd = Number(customEnd);
  const customRangeValid =
    /^\d+$/.test(customStart) &&
    /^\d+$/.test(customEnd) &&
    Number.isSafeInteger(parsedCustomStart) &&
    Number.isSafeInteger(parsedCustomEnd) &&
    parsedCustomEnd >= parsedCustomStart;
  const parsedDimensionZThreshold = Number(dimensionZThreshold);
  const parsedExtremeSingleDimensionZ = Number(extremeSingleDimensionZ);
  const dimensionJumpThresholdsValid =
    dimensionZThreshold.trim() !== "" &&
    extremeSingleDimensionZ.trim() !== "" &&
    Number.isFinite(parsedDimensionZThreshold) &&
    Number.isFinite(parsedExtremeSingleDimensionZ) &&
    parsedDimensionZThreshold > 0 &&
    parsedExtremeSingleDimensionZ > 0 &&
    parsedDimensionZThreshold <= MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD &&
    parsedExtremeSingleDimensionZ <= MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD;
  const selectedDimensionJumpThresholds: DoctorDimensionJumpThresholds = {
    dimensionZThreshold: parsedDimensionZThreshold,
    extremeSingleDimensionZ: parsedExtremeSingleDimensionZ,
  };
  const parsedLinearSpeedMetersPerSecond = Number(linearSpeedMetersPerSecond);
  const parsedAngularSpeedDegreesPerSecond = Number(
    angularSpeedDegreesPerSecond,
  );
  const speedThresholdsValid =
    linearSpeedMetersPerSecond.trim() !== "" &&
    angularSpeedDegreesPerSecond.trim() !== "" &&
    Number.isFinite(parsedLinearSpeedMetersPerSecond) &&
    Number.isFinite(parsedAngularSpeedDegreesPerSecond) &&
    parsedLinearSpeedMetersPerSecond > 0 &&
    parsedAngularSpeedDegreesPerSecond > 0 &&
    parsedLinearSpeedMetersPerSecond <=
      MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND &&
    parsedAngularSpeedDegreesPerSecond <=
      MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND;
  const selectedSpeedThresholds: DoctorSpeedThresholds = {
    linearMetersPerSecond: parsedLinearSpeedMetersPerSecond,
    angularDegreesPerSecond: parsedAngularSpeedDegreesPerSecond,
  };
  const selectedScope: DoctorScope = {
    maxEpisodes:
      scopeOption === "all" || scopeOption === "custom"
        ? null
        : Number(scopeOption),
    episodeRange:
      scopeOption === "custom" && customRangeValid
        ? { start: parsedCustomStart, end: parsedCustomEnd }
        : null,
  };
  const affectedEpisodeIds = useMemo(
    () => (report ? extractAffectedDoctorEpisodeIds(report) : []),
    [report],
  );
  const activeDimensionJumpThresholds =
    result?.execution.dimension_jump_thresholds ??
    DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS;
  const activeSpeedThresholds =
    result?.execution.speed_thresholds ?? DEFAULT_DOCTOR_SPEED_THRESHOLDS;
  const doctorScopeLabel = useMemo(() => {
    const execution = result?.execution;
    if (!execution) return "—";
    if (execution.requested_episode_range) {
      return `episodes ${execution.requested_episode_range.start}-${execution.requested_episode_range.end}`;
    }
    if (execution.requested_max_episodes === null) return "full dataset";
    return `first ${execution.requested_max_episodes} episodes`;
  }, [result?.execution]);
  const episodeLengthDistributionCopyText = useMemo(() => {
    if (episodeLengthStatsLoading) {
      return "Episode Length Distribution (Statistics, full dataset): loading";
    }
    if (
      !episodeLengthStats ||
      episodeLengthStats.episodeLengthHistogram.length === 0
    ) {
      return "Episode Length Distribution (Statistics, full dataset): unavailable";
    }

    const episodeIndicesByBin = assignEpisodesToBins(
      episodeLengthStats.allEpisodeLengths,
      episodeLengthStats.episodeLengthHistogramBinning,
    );
    const bins = episodeLengthStats.episodeLengthHistogram.map((bin, index) => {
      const episodeIndices = episodeIndicesByBin[index] ?? [];
      return `  Bin ${index + 1} — ${bin.binLabel}: ${bin.count} episode${bin.count === 1 ? "" : "s"} — ${episodeIndices.length > 0 ? episodeIndices.join(", ") : "None"}`;
    });
    return [
      `Episode Length Distribution (Statistics, full dataset; ${bins.length} bin${bins.length === 1 ? "" : "s"}):`,
      ...bins,
    ].join("\n");
  }, [episodeLengthStats, episodeLengthStatsLoading]);
  const doctorDetailsCopyText = useMemo(() => {
    if (!report) return "";
    const name = datasetName.trim() || report.dataset_name || "Unknown dataset";
    const { dimensionZThreshold, extremeSingleDimensionZ } =
      activeDimensionJumpThresholds;
    const { linearMetersPerSecond, angularDegreesPerSecond } =
      activeSpeedThresholds;
    const summary = (["PASS", "WARN", "FAIL"] as const)
      .map((severity) => `${severity} ${report.summary[severity] ?? 0}`)
      .join(" · ");
    const checks = report.checks
      .map((check) => {
        const messages =
          check.messages.length > 0
            ? check.messages
                .map((message) => `  [${message.severity}] ${message.message}`)
                .join("\n")
            : "  (no messages)";
        return `[${check.severity}] ${check.name}\n${messages}`;
      })
      .join("\n\n");
    return [
      `Dataset: ${name}`,
      `Dataset path: ${report.dataset_path}`,
      `Doctor scope: ${doctorScopeLabel}`,
      `Overall severity: ${report.overall_severity}`,
      `Summary: ${summary}`,
      `Flagged episodes (${affectedEpisodeIds.length}): ${affectedEpisodeIds.join(", ")}`,
      `Loaded episodes: ${result?.execution.loaded_episode_count ?? "—"}`,
      `Duration: ${result ? formatDuration(result.execution.duration_ms) : "—"}`,
      "Doctor parameters:",
      `  Coordinated z: ${dimensionZThreshold}σ`,
      `  Single-dimension z: ${extremeSingleDimensionZ}σ`,
      `  Trigger: ≥2 dimensions >${dimensionZThreshold}σ or 1 dimension >${extremeSingleDimensionZ}σ`,
      "  Report related dimensions: >8σ",
      "  Display limit: 5 events per episode and signal",
      `  Linear xyz speed limit: ${linearMetersPerSecond} m/s`,
      `  Angular xyz speed limit: ${angularDegreesPerSecond} deg/s`,
      `  TCP speed check: ${speedCheckEnabled ? "enabled" : "disabled"}`,
      `  Speed trigger: any |vx|/|vy|/|vz| >${linearMetersPerSecond} m/s or |ωx|/|ωy|/|ωz| >${angularDegreesPerSecond} deg/s`,
      "",
      episodeLengthDistributionCopyText,
      "",
      "Checks:",
      checks,
    ].join("\n");
  }, [
    activeDimensionJumpThresholds,
    activeSpeedThresholds,
    affectedEpisodeIds,
    datasetName,
    doctorScopeLabel,
    episodeLengthDistributionCopyText,
    report,
    result,
    speedCheckEnabled,
  ]);
  const copyAffectedEpisodeIds = useCallback(async () => {
    if (affectedEpisodeIds.length === 0) return;
    const copied = await copyTextToClipboard(affectedEpisodeIds.join(", "));
    if (copied) {
      setCopiedAffectedIds(true);
      window.setTimeout(() => setCopiedAffectedIds(false), 1500);
    } else {
      setCopiedAffectedIds(false);
    }
  }, [affectedEpisodeIds]);
  const copyDoctorDetails = useCallback(async () => {
    if (!doctorDetailsCopyText) return;
    const copied = await copyTextToClipboard(doctorDetailsCopyText);
    if (copied) {
      setCopiedDoctorDetails(true);
      window.setTimeout(() => setCopiedDoctorDetails(false), 1500);
    } else {
      setCopiedDoctorDetails(false);
    }
  }, [doctorDetailsCopyText]);
  const visibleChecks = useMemo(() => {
    if (!report) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return report.checks.filter((check) => {
      if (severityFilter !== "ALL" && check.severity !== severityFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      return (
        check.name.toLowerCase().includes(normalizedQuery) ||
        check.messages.some((message) =>
          message.message.toLowerCase().includes(normalizedQuery),
        )
      );
    });
  }, [query, report, severityFilter]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold text-slate-100">
              {t("viewer.tab.doctor")}
            </h2>
            <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">
              {t("doctor.readOnly")}
            </span>
            {report && <SeverityBadge severity={report.overall_severity} />}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            {t("doctor.desc")}
          </p>
          <p
            className="mt-1 truncate text-xs text-slate-500"
            title={datasetName}
          >
            {datasetName}
          </p>
        </div>

        <div className="flex basis-full flex-wrap items-center justify-end gap-2">
          {scopeOption === "custom" && (
            <div className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor="doctor-range-start">
                {t("doctor.startEpisode")}
              </label>
              <input
                id="doctor-range-start"
                type="number"
                min={0}
                step={1}
                value={customStart}
                disabled={running}
                onChange={(event) => setCustomStart(event.target.value)}
                aria-invalid={!customRangeValid}
                className="w-20 rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-2 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
                placeholder={t("doctor.phStart")}
              />
              <span className="text-xs text-slate-500">{t("doctor.to")}</span>
              <label className="sr-only" htmlFor="doctor-range-end">
                {t("doctor.endEpisode")}
              </label>
              <input
                id="doctor-range-end"
                type="number"
                min={0}
                step={1}
                value={customEnd}
                disabled={running}
                onChange={(event) => setCustomEnd(event.target.value)}
                aria-invalid={!customRangeValid}
                className="w-20 rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-2 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
                placeholder={t("doctor.phEnd")}
              />
            </div>
          )}
          <label className="sr-only" htmlFor="doctor-scope">
            {t("doctor.scopeLabel")}
          </label>
          <select
            id="doctor-scope"
            value={scopeOption}
            disabled={running}
            onChange={(event) =>
              setScopeOption(event.target.value as DoctorScopeOption)
            }
            className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-xs text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
          >
            {SAMPLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          {report && (
            <button
              type="button"
              onClick={() => downloadReport(report)}
              className="rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-white/20 hover:text-slate-200"
            >
              {t("doctor.downloadJson")}
            </button>
          )}
          <button
            type="button"
            disabled={
              running ||
              !encodedPath ||
              !dimensionJumpThresholdsValid ||
              (speedCheckEnabled && !speedThresholdsValid) ||
              (scopeOption === "custom" && !customRangeValid)
            }
            onClick={() =>
              void run(
                selectedScope,
                selectedDimensionJumpThresholds,
                speedCheckEnabled
                  ? selectedSpeedThresholds
                  : DEFAULT_DOCTOR_SPEED_THRESHOLDS,
                speedCheckEnabled,
                true,
              )
            }
            className="inline-flex min-w-28 items-center justify-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running && <Spinner />}
            {running
              ? t("doctor.diagnosing")
              : result
                ? t("doctor.runAgain")
                : t("doctor.run")}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/45 px-4 py-3">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(22rem,auto)] md:items-center">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-300">
              {t("doctor.jumpTitle")}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              {t("doctor.jumpDesc")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-400">
              <span>{t("doctor.coordZ")}</span>
              <input
                type="number"
                min="0.1"
                max={MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD}
                step="0.1"
                value={dimensionZThreshold}
                disabled={running}
                onChange={(event) => setDimensionZThreshold(event.target.value)}
                aria-invalid={!dimensionJumpThresholdsValid}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50 sm:w-24"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-400">
              <span>{t("doctor.singleZ")}</span>
              <input
                type="number"
                min="0.1"
                max={MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD}
                step="0.1"
                value={extremeSingleDimensionZ}
                disabled={running}
                onChange={(event) =>
                  setExtremeSingleDimensionZ(event.target.value)
                }
                aria-invalid={!dimensionJumpThresholdsValid}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50 sm:w-24"
              />
            </label>
            <p className="text-[11px] tabular text-cyan-300/80 sm:col-span-2">
              {t("doctor.jumpFormula", {
                z1: dimensionZThreshold || "?",
                z2: extremeSingleDimensionZ || "?",
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/45 px-4 py-3">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(22rem,auto)] md:items-center">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-slate-300">
                {t("doctor.speedTitle")}
              </p>
              <button
                type="button"
                role="switch"
                aria-checked={speedCheckEnabled}
                aria-label={t("doctor.speedAria")}
                disabled={running}
                onClick={() => setSpeedCheckEnabled((enabled) => !enabled)}
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${speedCheckEnabled ? "border-cyan-300/60 bg-cyan-400/70" : "border-white/15 bg-white/10"}`}
              >
                <span
                  className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${speedCheckEnabled ? "translate-x-3.5" : "translate-x-0.5"}`}
                />
              </button>
              <span className="text-[10px] text-slate-500">
                {speedCheckEnabled ? t("doctor.on") : t("doctor.off")}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {t("doctor.speedDesc")}
            </p>
            <p className="mt-1 text-[10px] text-slate-600">
              {speedCheckEnabled
                ? t("doctor.speedEnabled")
                : t("doctor.speedDisabled")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-400">
              <span>{t("doctor.linear")}</span>
              <input
                type="number"
                min="0.1"
                max={MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND}
                step="0.1"
                value={linearSpeedMetersPerSecond}
                disabled={running}
                onChange={(event) =>
                  setLinearSpeedMetersPerSecond(event.target.value)
                }
                aria-invalid={speedCheckEnabled && !speedThresholdsValid}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50 sm:w-24"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-400">
              <span>{t("doctor.angular")}</span>
              <input
                type="number"
                min="1"
                max={MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND}
                step="1"
                value={angularSpeedDegreesPerSecond}
                disabled={running}
                onChange={(event) =>
                  setAngularSpeedDegreesPerSecond(event.target.value)
                }
                aria-invalid={speedCheckEnabled && !speedThresholdsValid}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50 sm:w-24"
              />
            </label>
            <p className="text-[11px] tabular text-cyan-300/80 sm:col-span-2">
              {t("doctor.speedFormula", {
                lin: linearSpeedMetersPerSecond || "?",
                ang: angularSpeedDegreesPerSecond || "?",
              })}
            </p>
          </div>
        </div>
      </div>

      {scopeOption === "custom" && !customRangeValid && !running && (
        <div
          className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-200/80"
          role="alert"
        >
          {t("doctor.errRange")}
        </div>
      )}

      {!dimensionJumpThresholdsValid && !running && (
        <div
          className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-200/80"
          role="alert"
        >
          {t("doctor.errZ", { max: MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD })}
        </div>
      )}

      {speedCheckEnabled && !speedThresholdsValid && !running && (
        <div
          className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-200/80"
          role="alert"
        >
          {t("doctor.errSpeed", {
            maxLinear: MAX_DOCTOR_LINEAR_SPEED_METERS_PER_SECOND,
            maxAngular: MAX_DOCTOR_ANGULAR_SPEED_DEGREES_PER_SECOND,
          })}
        </div>
      )}

      {scopeOption === "all" && !running && (
        <div className="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
          {t("doctor.fullWarning")}
        </div>
      )}

      <section className="panel space-y-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-slate-200">
            {t("doctor.distTitle")}
          </h3>
          <p className="text-[11px] text-slate-500">
            {t("doctor.distSub")}
            {episodeLengthStats
              ? t("doctor.distBins", {
                  count: episodeLengthStats.episodeLengthHistogram.length,
                })
              : ""}
          </p>
        </div>

        {episodeLengthStatsLoading ? (
          <div
            className="flex min-h-40 items-center justify-center gap-3 text-xs text-slate-500"
            role="status"
          >
            <Spinner />
            {t("doctor.distLoading")}
          </div>
        ) : episodeLengthStats &&
          episodeLengthStats.episodeLengthHistogram.length > 0 ? (
          <EpisodeLengthHistogram
            data={episodeLengthStats.episodeLengthHistogram}
            episodes={episodeLengthStats.allEpisodeLengths}
            binning={episodeLengthStats.episodeLengthHistogramBinning}
          />
        ) : (
          <p className="py-8 text-center text-xs text-slate-500">
            {t("doctor.distUnavailable")}
          </p>
        )}
      </section>

      {running && (
        <div
          className={`panel flex items-center justify-center gap-4 px-6 ${
            report ? "min-h-28" : "min-h-52"
          }`}
        >
          <Spinner />
          <ProgressBar progress={progress} />
        </div>
      )}

      {!running && !report && !error && (
        <div className="panel flex min-h-52 items-center justify-center px-6 text-center">
          <div>
            <p className="text-sm font-medium text-slate-300">
              {t("doctor.ready")}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {t("doctor.readyHint")}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div
          className="rounded-lg border border-red-400/30 bg-red-400/5 p-4"
          role="alert"
        >
          <p className="text-sm font-medium text-red-300">
            {t("doctor.failed")}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-red-200/75">
            {error}
          </p>
        </div>
      )}

      {report && result && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="col-span-2 rounded-lg border border-white/10 bg-[var(--surface-1)]/55 p-4 sm:col-span-3 lg:col-span-3">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {t("common.episodes")}
                  </p>
                  <p className="mt-1 text-sm font-medium tabular text-slate-200">
                    {formatInteger(report.total_episodes)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {t("common.frames")}
                  </p>
                  <p className="mt-1 text-sm font-medium tabular text-slate-200">
                    {formatInteger(report.total_frames)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    FPS
                  </p>
                  <p className="mt-1 text-sm font-medium tabular text-slate-200">
                    {formatInteger(report.fps)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {t("doctor.version")}
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-200">
                    {report.codebase_version ?? report.format_version ?? "—"}
                  </p>
                </div>
              </div>
              <p className="mt-3 border-t border-white/5 pt-3 text-[11px] text-slate-500">
                {tp(
                  "doctor.loadedLine",
                  result.execution.loaded_episode_count,
                  {
                    count:
                      result.execution.loaded_episode_count.toLocaleString(),
                    duration: formatDuration(result.execution.duration_ms),
                    version: report.version,
                  },
                )}
                {result.execution.cache_hit ? t("doctor.cached") : ""}
              </p>
            </div>
            {(["PASS", "WARN", "FAIL"] as const).map((severity) => (
              <SummaryCard
                key={severity}
                severity={severity}
                count={report.summary[severity] ?? 0}
                active={severityFilter === severity}
                onClick={() =>
                  setSeverityFilter((current) =>
                    current === severity ? "ALL" : severity,
                  )
                }
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M9 3a6 6 0 1 0 3.8 10.64l3.78 3.78 1.42-1.42-3.78-3.78A6 6 0 0 0 9 3Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                  clipRule="evenodd"
                />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("doctor.searchPh")}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)]/60 py-2 pl-9 pr-3 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
              />
            </div>
            {severityFilter !== "ALL" && (
              <button
                type="button"
                onClick={() => setSeverityFilter("ALL")}
                className="text-xs text-slate-500 transition-colors hover:text-slate-300"
              >
                {t("doctor.clearFilter", { severity: severityFilter })}
              </button>
            )}
            {report && (
              <>
                {affectedEpisodeIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => addMany(affectedEpisodeIds)}
                    title={t("doctor.flagEpisodes", {
                      ids: affectedEpisodeIds.join(", "),
                    })}
                    className="rounded-md border border-orange-400/25 bg-orange-400/10 px-3 py-2 text-xs font-medium text-orange-300 transition-colors hover:border-orange-400/50 hover:bg-orange-400/15"
                  >
                    {t("doctor.flagAllAffected", {
                      count: affectedEpisodeIds.length,
                    })}
                  </button>
                )}
                {affectedEpisodeIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void copyAffectedEpisodeIds()}
                    title={t("doctor.copyAffected")}
                    aria-label={t("doctor.copyAffected")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-300 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/15"
                  >
                    {copiedAffectedIds ? (
                      <>
                        <svg
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-3.5 w-3.5"
                          aria-hidden
                        >
                          <path d="m7.5 13.5-3-3L3 12l4.5 4.5L17 7l-1.5-1.5z" />
                        </svg>
                        {t("stats.copiedIds")}
                      </>
                    ) : (
                      <>
                        <svg
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="h-3.5 w-3.5"
                          aria-hidden
                        >
                          <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
                          <path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
                        </svg>
                        {t("stats.copyIds")}
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!doctorDetailsCopyText || episodeLengthStatsLoading}
                  onClick={() => void copyDoctorDetails()}
                  title={
                    episodeLengthStatsLoading
                      ? t("doctor.copyDetailsWait")
                      : t("doctor.copyDetailsTitle")
                  }
                  aria-label={t("doctor.copyDetailsTitle")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-xs font-medium text-violet-300 transition-colors hover:border-violet-400/50 hover:bg-violet-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {copiedDoctorDetails ? (
                    <>
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-3.5 w-3.5"
                        aria-hidden
                      >
                        <path d="m7.5 13.5-3-3L3 12l4.5 4.5L17 7l-1.5-1.5z" />
                      </svg>
                      {t("doctor.copiedDetails")}
                    </>
                  ) : (
                    <>
                      <svg
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="h-3.5 w-3.5"
                        aria-hidden
                      >
                        <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
                        <path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
                      </svg>
                      {episodeLengthStatsLoading
                        ? t("doctor.preparingDetails")
                        : t("doctor.copyDetails")}
                    </>
                  )}
                </button>
              </>
            )}
          </div>

          <div className="space-y-2">
            {visibleChecks.map((check) => (
              <CheckCard
                key={check.name}
                check={check}
                encodedPath={encodedPath}
                dimensionJumpThresholds={
                  result.execution.dimension_jump_thresholds ??
                  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS
                }
                speedThresholds={
                  result.execution.speed_thresholds ??
                  DEFAULT_DOCTOR_SPEED_THRESHOLDS
                }
                expanded={expanded.has(check.name)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(check.name)) next.delete(check.name);
                    else next.add(check.name);
                    return next;
                  })
                }
              />
            ))}
            {visibleChecks.length === 0 && (
              <div className="rounded-lg border border-white/10 p-8 text-center text-sm text-slate-500">
                {t("doctor.noChecksMatch")}
              </div>
            )}
          </div>

          <p className="text-[11px] leading-5 text-slate-600">
            {t("doctor.footnote")}
          </p>
        </>
      )}
    </div>
  );
}

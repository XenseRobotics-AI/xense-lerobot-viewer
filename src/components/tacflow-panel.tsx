"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import { FaPlay } from "react-icons/fa";
import {
  MAX_TACFLOW_SCORE_WEIGHT,
  MIN_TACFLOW_SCORE_WEIGHT,
  TACFLOW_SCORE_WEIGHT_STORAGE_KEY,
  calculateTacFlowScore,
  normalizeTacFlowScoreWeight,
  type TacFlowDoctorFinding,
  type TacFlowDoctorReport,
  type TacFlowDoctorSeverity,
  type TacFlowScoreCalculation,
  type TacFlowScoreGrade,
  type TacFlowScoreStreamEvent,
} from "@/lib/tacflow/scoring";
import {
  DEFAULT_TACFLOW_DATASET_NAME,
  DEFAULT_TACFLOW_DATASET_RELATIVE_PATH,
} from "@/lib/tacflow/constants";
import {
  type TacFlowArtifacts,
  type TacFlowRunStatus,
  type TacFlowStepId,
  type TacFlowStreamEvent,
  type TacFlowSummary,
} from "@/types/tacflow.types";
import { routePathFromRepoId, makeLocalRepoId } from "@/utils/datasetRoute";
import { createWorkbenchReviewTask } from "@/utils/workbenchActions";
import WorkbenchSharedSync from "@/components/workbench-shared-sync";

type StepUiDefinition = {
  id: TacFlowStepId;
  label: string;
  name: string;
  dependsOn: TacFlowStepId | null;
};

type StreamLog = {
  stream: "stdout" | "stderr";
  line: string;
};

type StepState = {
  status: TacFlowRunStatus;
  percent: number;
  message: string;
  logs: StreamLog[];
  exitCode: number | null;
  durationMs: number | null;
  artifacts: TacFlowArtifacts;
  summary: TacFlowSummary | null;
  error: string | null;
};

type ScoreState = {
  status: TacFlowRunStatus;
  percent: number;
  message: string;
  logs: StreamLog[];
  exitCode: number | null;
  durationMs: number | null;
  artifacts: TacFlowArtifacts;
  report: TacFlowDoctorReport | null;
  error: string | null;
};

type DatasetLoadState = "loading" | "ready" | "failed";

type TacFlowDatasetOption = {
  relativePath: string;
  totalEpisodes: number | null;
  totalFrames: number | null;
  integrityStatus: string | null;
};

const STEP_DEFINITIONS: StepUiDefinition[] = [
  {
    id: "step_1",
    label: "Step 1 Detect",
    name: "Detect",
    dependsOn: null,
  },
  {
    id: "step_2",
    label: "Step 2 Repair",
    name: "Repair",
    dependsOn: "step_1",
  },
  {
    id: "step_3",
    label: "Step 3 Re-check",
    name: "Re-check",
    dependsOn: "step_2",
  },
];

const INITIAL_STEP: StepState = {
  status: "idle",
  percent: 0,
  message: "0%",
  logs: [],
  exitCode: null,
  durationMs: null,
  artifacts: {},
  summary: null,
  error: null,
};

const INITIAL_SCORE: ScoreState = {
  status: "idle",
  percent: 0,
  message: "Not run",
  logs: [],
  exitCode: null,
  durationMs: null,
  artifacts: {},
  report: null,
  error: null,
};

const SEVERITY_TONE: Record<
  TacFlowDoctorSeverity,
  { badge: string; dot: string; text: string }
> = {
  PASS: {
    badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
  },
  WARN: {
    badge: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    dot: "bg-amber-400",
    text: "text-amber-300",
  },
  FAIL: {
    badge: "border-red-400/30 bg-red-400/10 text-red-300",
    dot: "bg-red-400",
    text: "text-red-300",
  },
};

const GRADE_TONE: Record<
  TacFlowScoreGrade,
  { ring: string; fill: string; text: string; accent: string }
> = {
  A: {
    ring: "border-emerald-300/70 shadow-[0_0_46px_rgba(52,211,153,0.18)]",
    fill: "bg-emerald-400/10",
    text: "text-emerald-200",
    accent: "text-emerald-300",
  },
  B: {
    ring: "border-cyan-300/70 shadow-[0_0_46px_rgba(34,211,238,0.16)]",
    fill: "bg-cyan-400/10",
    text: "text-cyan-200",
    accent: "text-cyan-300",
  },
  C: {
    ring: "border-amber-300/70 shadow-[0_0_46px_rgba(251,191,36,0.16)]",
    fill: "bg-amber-400/10",
    text: "text-amber-200",
    accent: "text-amber-300",
  },
  D: {
    ring: "border-red-300/70 shadow-[0_0_46px_rgba(248,113,113,0.16)]",
    fill: "bg-red-400/10",
    text: "text-red-200",
    accent: "text-red-300",
  },
};

function initialState(): Record<TacFlowStepId, StepState> {
  return {
    step_1: { ...INITIAL_STEP },
    step_2: { ...INITIAL_STEP },
    step_3: { ...INITIAL_STEP },
  };
}

function resetScore(): ScoreState {
  return { ...INITIAL_SCORE, artifacts: {}, logs: [], report: null };
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function formatScore(value: number): string {
  return value.toFixed(1);
}

function statusTone(status: TacFlowRunStatus): string {
  if (status === "done") return "text-emerald-300";
  if (status === "failed") return "text-red-300";
  if (status === "running" || status === "command finished") {
    return "text-cyan-300";
  }
  return "text-slate-400";
}

function progressWidth(status: TacFlowRunStatus, percent: number): number {
  if (status === "running") return Math.max(10, percent);
  return percent;
}

function isStreamEvent(value: unknown): value is { type: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isTacFlowEvent(value: unknown): value is TacFlowStreamEvent {
  return isStreamEvent(value);
}

function isTacFlowScoreEvent(value: unknown): value is TacFlowScoreStreamEvent {
  return isStreamEvent(value);
}

function parseErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return "TacFlow request failed.";
}

function datasetNameFromPath(value: string): string {
  const segments = value.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? DEFAULT_TACFLOW_DATASET_NAME;
}

function formatDatasetOption(option: TacFlowDatasetOption): string {
  const name = datasetNameFromPath(option.relativePath);
  const defaultSuffix =
    option.relativePath === DEFAULT_TACFLOW_DATASET_RELATIVE_PATH
      ? " (default)"
      : "";
  const details = [
    option.totalEpisodes == null ? null : `${option.totalEpisodes} ep`,
    option.totalFrames == null ? null : `${option.totalFrames} frames`,
    option.integrityStatus,
  ].filter(Boolean);
  const detailsText = details.length ? ` (${details.join(", ")})` : "";
  return `${name}${defaultSuffix} - ${option.relativePath}${detailsText}`;
}

function readLocalDatasetOptions(value: unknown): TacFlowDatasetOption[] {
  if (!isRecord(value) || !Array.isArray(value.datasets)) return [];

  return value.datasets
    .flatMap((dataset): TacFlowDatasetOption[] => {
      if (!isRecord(dataset) || typeof dataset.relativePath !== "string") {
        return [];
      }
      const integrity = isRecord(dataset.integrity)
        ? dataset.integrity.status
        : null;
      return [
        {
          relativePath: dataset.relativePath,
          totalEpisodes:
            typeof dataset.total_episodes === "number"
              ? dataset.total_episodes
              : null,
          totalFrames:
            typeof dataset.total_frames === "number"
              ? dataset.total_frames
              : null,
          integrityStatus: typeof integrity === "string" ? integrity : null,
        },
      ];
    })
    .sort((left, right) => {
      if (left.relativePath === DEFAULT_TACFLOW_DATASET_RELATIVE_PATH)
        return -1;
      if (right.relativePath === DEFAULT_TACFLOW_DATASET_RELATIVE_PATH)
        return 1;
      return left.relativePath.localeCompare(right.relativePath);
    });
}

function findPreferredDatasetPath(
  options: TacFlowDatasetOption[],
): string | null {
  const exact = options.find(
    (option) => option.relativePath === DEFAULT_TACFLOW_DATASET_RELATIVE_PATH,
  );
  if (exact) return exact.relativePath;

  const byName = options.find(
    (option) =>
      datasetNameFromPath(option.relativePath) === DEFAULT_TACFLOW_DATASET_NAME,
  );
  return byName?.relativePath ?? null;
}

function resetStep(): StepState {
  return { ...INITIAL_STEP, artifacts: {}, logs: [], summary: null };
}

function updateForEvent(
  current: Record<TacFlowStepId, StepState>,
  event: TacFlowStreamEvent,
): Record<TacFlowStepId, StepState> {
  const state = current[event.step];
  if (!state) return current;

  if (event.type === "status") {
    return {
      ...current,
      [event.step]: {
        ...state,
        status: event.status,
        percent: event.percent,
        message: event.message,
        error: event.status === "failed" ? state.error : null,
      },
    };
  }

  if (event.type === "log") {
    return {
      ...current,
      [event.step]: {
        ...state,
        logs: [...state.logs, { stream: event.stream, line: event.line }].slice(
          -500,
        ),
      },
    };
  }

  if (event.type === "result") {
    return {
      ...current,
      [event.step]: {
        ...state,
        status: event.ok ? state.status : "failed",
        percent: event.ok ? state.percent : 100,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        artifacts: event.artifacts,
        summary: event.summary,
        error: event.error ?? null,
      },
    };
  }

  return {
    ...current,
    [event.step]: {
      ...state,
      status: "failed",
      percent: 100,
      message: event.error,
      error: event.error,
    },
  };
}

function updateScoreForEvent(
  current: ScoreState,
  event: TacFlowScoreStreamEvent,
): ScoreState {
  if (event.type === "status") {
    return {
      ...current,
      status: event.status,
      percent: event.percent,
      message: event.message,
      error: event.status === "failed" ? current.error : null,
    };
  }

  if (event.type === "log") {
    return {
      ...current,
      logs: [...current.logs, { stream: event.stream, line: event.line }].slice(
        -500,
      ),
    };
  }

  if (event.type === "result") {
    return {
      ...current,
      status: event.ok ? current.status : "failed",
      percent: event.ok ? current.percent : 100,
      exitCode: event.exitCode,
      durationMs: event.durationMs,
      artifacts: event.artifacts,
      report: event.report ?? current.report,
      error: event.error ?? null,
    };
  }

  return {
    ...current,
    status: "failed",
    percent: 100,
    message: event.error,
    error: event.error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStoredScoreWeights(): Record<string, number> {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(TACFLOW_SCORE_WEIGHT_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) => {
        const numeric = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numeric)) return [];
        return [[key, normalizeTacFlowScoreWeight(numeric)]];
      }),
    );
  } catch {
    return {};
  }
}

function ArtifactList({ artifacts }: { artifacts: TacFlowArtifacts }) {
  const entries = Object.entries(artifacts);
  if (!entries.length) return null;
  return (
    <dl className="grid gap-1.5 text-[11px]">
      {entries.map(([key, value]) => (
        <div key={key} className="grid gap-1 md:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="font-medium uppercase tracking-wide text-slate-500">
            {key}
          </dt>
          <dd className="min-w-0 break-all font-mono text-slate-300">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SummaryBlock({ summary }: { summary: TacFlowSummary | null }) {
  if (!summary) return null;
  const hasSummaryLines = Boolean(summary.summaryLines?.length);
  const hasHighlights = Boolean(summary.highlights?.length);
  const hasStderrTail = Boolean(summary.stderrTail?.length);
  if (
    summary.eventCount == null &&
    !hasSummaryLines &&
    !hasHighlights &&
    !hasStderrTail
  ) {
    return null;
  }

  return (
    <div className="space-y-3 text-xs">
      {summary.eventCount != null && (
        <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">
          <span className="text-slate-500">events</span>
          <span className="font-mono text-cyan-200">{summary.eventCount}</span>
        </div>
      )}
      {hasHighlights && (
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-white/5 bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          {summary.highlights!.join("\n")}
        </pre>
      )}
      {hasSummaryLines && (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-md border border-white/5 bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          {summary.summaryLines!.join("\n")}
        </pre>
      )}
      {hasStderrTail && (
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-red-400/15 bg-red-950/20 p-3 font-mono text-[11px] leading-relaxed text-red-200">
          {summary.stderrTail!.join("\n")}
        </pre>
      )}
    </div>
  );
}

function LogPanel({ logs }: { logs: StreamLog[] }) {
  if (!logs.length) {
    return (
      <div className="flex min-h-32 items-center rounded-md border border-dashed border-white/10 px-3 text-xs text-slate-500">
        Waiting for output.
      </div>
    );
  }

  return (
    <pre className="max-h-72 min-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-white/5 bg-black/25 p-3 font-mono text-[11px] leading-relaxed">
      {logs.map((entry, index) => (
        <span
          key={`${index}-${entry.stream}`}
          className={
            entry.stream === "stderr" ? "text-red-200" : "text-slate-300"
          }
        >
          {entry.stream === "stderr" ? "stderr " : "stdout "}
          {entry.line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
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

function SeverityBadge({ severity }: { severity: TacFlowDoctorSeverity }) {
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

function findingSummary(finding: TacFlowDoctorFinding): string {
  const parts: string[] = [];
  const kind = finding.kind;
  const episode = finding.episode;
  const column = finding.column;
  const feature = finding.feature;
  const frame = finding.frame;

  if (typeof kind === "string" && kind.trim()) parts.push(kind);
  if (typeof episode === "number" && Number.isFinite(episode)) {
    parts.push(`ep ${episode}`);
  }
  if (typeof column === "string" && column.trim()) parts.push(column);
  if (typeof feature === "string" && feature.trim()) parts.push(feature);
  if (typeof frame === "number" && Number.isFinite(frame)) {
    parts.push(`frame ${frame}`);
  }

  if (parts.length) return parts.join(" / ");
  return JSON.stringify(finding).slice(0, 120);
}

function findingNumber(
  finding: TacFlowDoctorFinding,
  key: "episode" | "frame",
): number | null {
  const value = finding[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return null;
}

function tacFlowFindingHref(
  datasetPath: string,
  finding: TacFlowDoctorFinding,
): string {
  const episode = findingNumber(finding, "episode") ?? 0;
  const frame = findingNumber(finding, "frame");
  const base = routePathFromRepoId(makeLocalRepoId(datasetPath), episode);
  const params = new URLSearchParams({ tab: "tacflow" });
  if (frame !== null) params.set("frame", String(frame));
  return `${base}?${params.toString()}`;
}

function GradeBadge({
  calculation,
  status,
}: {
  calculation: TacFlowScoreCalculation | null;
  status: TacFlowRunStatus;
}) {
  const isRunning = status === "running" || status === "command finished";
  const tone = calculation?.ok
    ? GRADE_TONE[calculation.grade]
    : {
        ring: "border-slate-500/40",
        fill: "bg-white/[0.03]",
        text: "text-slate-300",
        accent: "text-slate-400",
      };

  return (
    <div className="flex min-w-0 items-center gap-4">
      <div
        className={`flex h-28 w-28 shrink-0 items-center justify-center rounded-full border-2 ${tone.ring} ${tone.fill}`}
        aria-label={
          calculation?.ok
            ? `Score grade ${calculation.grade}`
            : "No score grade"
        }
      >
        <span className={`text-6xl font-semibold leading-none ${tone.text}`}>
          {calculation?.ok ? calculation.grade : "—"}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          TacFlow Score
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`text-4xl font-semibold tabular ${tone.accent}`}>
            {calculation?.ok ? formatScore(calculation.score) : "—"}
          </span>
          <span className="text-sm text-slate-500">/ 100</span>
        </div>
        <p className={`mt-2 text-xs ${statusTone(status)}`}>
          {isRunning ? "Scoring" : status}
        </p>
      </div>
    </div>
  );
}

function ScoreTable({
  calculation,
  datasetPath,
  onWeightChange,
  onCreateReviewTask,
}: {
  calculation: TacFlowScoreCalculation;
  datasetPath: string;
  onWeightChange: (id: string, weight: number) => void;
  onCreateReviewTask: (
    finding: TacFlowDoctorFinding,
    checkName: string,
  ) => void;
}) {
  if (!calculation.rows.length) {
    return (
      <div className="rounded-md border border-dashed border-white/10 px-3 py-8 text-xs text-slate-500">
        No Doctor checks found.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-white/5">
      <table className="min-w-[920px] table-fixed text-left text-[11px]">
        <thead className="bg-white/[0.035] text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-[15rem] px-3 py-2 font-medium">Check</th>
            <th className="w-[6rem] px-3 py-2 font-medium">Severity</th>
            <th className="w-[18rem] px-3 py-2 font-medium">Messages</th>
            <th className="w-[13rem] px-3 py-2 font-medium">Findings</th>
            <th className="w-[6rem] px-3 py-2 font-medium">Base Score</th>
            <th className="w-[7rem] px-3 py-2 font-medium">Weight</th>
            <th className="w-[8rem] px-3 py-2 font-medium">Weighted Score</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {calculation.rows.map((row) => (
            <tr key={row.id} className="align-top text-slate-300">
              <td className="px-3 py-2">
                <p
                  className="truncate font-medium text-slate-200"
                  title={row.name}
                >
                  {row.name}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                  {row.id}
                </p>
              </td>
              <td className="px-3 py-2">
                <SeverityBadge severity={row.severity} />
              </td>
              <td className="px-3 py-2">
                {row.messages.length ? (
                  <div className="space-y-1">
                    {row.messages.slice(0, 2).map((message, index) => (
                      <p
                        key={`${row.id}-${index}-${message.message}`}
                        className="line-clamp-2 leading-4 text-slate-300"
                        title={message.message}
                      >
                        <span className={SEVERITY_TONE[message.severity].text}>
                          {message.severity}
                        </span>{" "}
                        {message.message}
                      </p>
                    ))}
                    {row.messages.length > 2 && (
                      <p className="text-[10px] text-slate-500">
                        +{row.messages.length - 2} more
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </td>
              <td className="px-3 py-2">
                {row.findings.length ? (
                  <div className="space-y-1">
                    <p className="font-mono text-slate-300">
                      {row.findings.length}
                    </p>
                    <div className="max-h-36 space-y-1 overflow-y-auto">
                      {row.findings.map((finding, index) => {
                        const episode = findingNumber(finding, "episode");
                        const frame = findingNumber(finding, "frame");
                        return (
                          <div
                            key={`${row.id}-finding-${index}`}
                            className="rounded border border-white/5 bg-black/10 px-2 py-1"
                          >
                            <p
                              className="line-clamp-2 leading-4 text-slate-400"
                              title={findingSummary(finding)}
                            >
                              {findingSummary(finding)}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <a
                                href={tacFlowFindingHref(datasetPath, finding)}
                                className="text-[10px] font-medium text-cyan-300 hover:text-cyan-100 hover:underline"
                              >
                                Open TACFLOW finding
                                {episode === null ? "" : ` · ep ${episode}`}
                                {frame === null ? "" : ` · frame ${frame}`}
                              </a>
                              <button
                                type="button"
                                onClick={() =>
                                  onCreateReviewTask(finding, row.name)
                                }
                                className="text-[10px] font-medium text-amber-300 hover:text-amber-100 hover:underline"
                              >
                                Create review task
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <span className="text-slate-500">0</span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-slate-300">
                {row.baseScore}
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={MIN_TACFLOW_SCORE_WEIGHT}
                  max={MAX_TACFLOW_SCORE_WEIGHT}
                  step={0.5}
                  value={row.weight}
                  aria-label={`Weight for ${row.name}`}
                  onChange={(event) =>
                    onWeightChange(
                      row.id,
                      normalizeTacFlowScoreWeight(Number(event.target.value)),
                    )
                  }
                  className="h-8 w-20 rounded-md border border-white/10 bg-black/20 px-2 font-mono text-slate-200 outline-none transition-colors focus:border-cyan-300/70"
                />
              </td>
              <td className="px-3 py-2 font-mono text-cyan-200">
                {calculation.ok ? formatScore(row.weightedScore) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScoreSection({
  state,
  calculation,
  running,
  reportLabel,
  onRun,
  onWeightChange,
  selectedDatasetPath,
  onCreateReviewTask,
}: {
  state: ScoreState;
  calculation: TacFlowScoreCalculation | null;
  running: boolean;
  reportLabel: string;
  onRun: () => void;
  onWeightChange: (id: string, weight: number) => void;
  selectedDatasetPath: string;
  onCreateReviewTask: (
    finding: TacFlowDoctorFinding,
    checkName: string,
  ) => void;
}) {
  const width = progressWidth(state.status, state.percent);

  return (
    <section className="space-y-4 border-b border-white/10 pb-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-4 md:flex-row md:items-center">
          <GradeBadge calculation={calculation} status={state.status} />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Doctor Score
              </h3>
              <p
                className="mt-1 break-all text-xs text-slate-500"
                title={reportLabel}
              >
                {reportLabel}
              </p>
              <a
                href={`${routePathFromRepoId(makeLocalRepoId(selectedDatasetPath), 0)}?tab=tacflow`}
                className="mt-2 inline-flex text-[10px] font-medium text-cyan-300 hover:text-cyan-100 hover:underline"
              >
                Open TACFLOW run in viewer
              </a>
            </div>
            <div className="max-w-xl space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className={`font-medium ${statusTone(state.status)}`}>
                  {state.message || state.status}
                </span>
                <span className="font-mono text-slate-400">
                  {state.percent}%
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-white/10"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={state.percent}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${
                    state.status === "failed" ? "bg-red-400" : "bg-cyan-400"
                  } ${state.status === "running" ? "animate-pulse" : ""}`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
                <span>
                  exit{" "}
                  <span className="font-mono text-slate-300">
                    {state.exitCode ?? "—"}
                  </span>
                </span>
                <span>
                  time{" "}
                  <span className="font-mono text-slate-300">
                    {formatDuration(state.durationMs)}
                  </span>
                </span>
              </div>
              {calculation && !calculation.ok && (
                <p className="rounded-md border border-amber-400/20 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                  {calculation.error}
                </p>
              )}
              {state.error && (
                <p className="rounded-md border border-red-400/20 bg-red-950/20 px-3 py-2 text-xs text-red-200">
                  {state.error}
                </p>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-4 text-xs font-semibold uppercase tracking-wide text-emerald-100 transition-colors hover:border-emerald-300/70 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-slate-500"
        >
          {running ? <Spinner /> : <FaPlay className="h-3 w-3" aria-hidden />}
          {running ? "Scoring" : "Run Score"}
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <div className="min-w-0">
          {calculation ? (
            <ScoreTable
              calculation={calculation}
              datasetPath={selectedDatasetPath}
              onWeightChange={onWeightChange}
              onCreateReviewTask={onCreateReviewTask}
            />
          ) : (
            <div className="rounded-md border border-dashed border-white/10 px-3 py-8 text-xs text-slate-500">
              Run score to load Doctor checks.
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <LogPanel logs={state.logs} />
          <ArtifactList artifacts={state.artifacts} />
        </div>
      </div>
    </section>
  );
}

function StepRow({
  definition,
  state,
  disabled,
  disabledReason,
  onRun,
}: {
  definition: StepUiDefinition;
  state: StepState;
  disabled: boolean;
  disabledReason: string;
  onRun: (step: TacFlowStepId) => void;
}) {
  const width = progressWidth(state.status, state.percent);
  return (
    <section className="grid gap-4 border-t border-white/5 py-4 first:border-t-0 lg:grid-cols-[11rem_14rem_minmax(0,1fr)]">
      <div className="flex items-start">
        <button
          type="button"
          onClick={() => onRun(definition.id)}
          disabled={disabled}
          title={disabled ? disabledReason : definition.name}
          className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-cyan-100 transition-colors hover:border-cyan-300/70 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-slate-500"
        >
          {definition.label}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className={`font-medium ${statusTone(state.status)}`}>
            {state.status}
          </span>
          <span className="font-mono text-slate-400">{state.percent}%</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.percent}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${
              state.status === "failed" ? "bg-red-400" : "bg-cyan-400"
            } ${state.status === "running" ? "animate-pulse" : ""}`}
            style={{ width: `${width}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
          <span>
            exit{" "}
            <span className="font-mono text-slate-300">
              {state.exitCode ?? "—"}
            </span>
          </span>
          <span>
            time{" "}
            <span className="font-mono text-slate-300">
              {formatDuration(state.durationMs)}
            </span>
          </span>
        </div>
        {state.message && (
          <p className="break-words text-[11px] leading-relaxed text-slate-500">
            {state.message}
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <LogPanel logs={state.logs} />
        {state.error && (
          <p className="rounded-md border border-red-400/20 bg-red-950/20 px-3 py-2 text-xs text-red-200">
            {state.error}
          </p>
        )}
        <ArtifactList artifacts={state.artifacts} />
        <SummaryBlock summary={state.summary} />
      </div>
    </section>
  );
}

export default function TacFlowPanel() {
  const [steps, setSteps] =
    useState<Record<TacFlowStepId, StepState>>(initialState);
  const [score, setScore] = useState<ScoreState>(INITIAL_SCORE);
  const [scoreActionMessage, setScoreActionMessage] = useState<string | null>(
    null,
  );
  const [scoreWeights, setScoreWeights] = useState<Record<string, number>>({});
  const [scoreWeightsLoaded, setScoreWeightsLoaded] = useState(false);
  const [selectedDatasetPath, setSelectedDatasetPath] = useState(
    DEFAULT_TACFLOW_DATASET_RELATIVE_PATH,
  );
  const [datasetOptions, setDatasetOptions] = useState<TacFlowDatasetOption[]>(
    [],
  );
  const [datasetLoadState, setDatasetLoadState] =
    useState<DatasetLoadState>("loading");
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const runningStep = useMemo(
    () =>
      STEP_DEFINITIONS.find(
        (step) =>
          steps[step.id].status === "running" ||
          steps[step.id].status === "command finished",
      )?.id ?? null,
    [steps],
  );
  const scoreRunning =
    score.status === "running" || score.status === "command finished";
  const scoreCalculation = useMemo(
    () =>
      score.report
        ? calculateTacFlowScore(score.report.checks, scoreWeights)
        : null,
    [score.report, scoreWeights],
  );
  const datasetSelectOptions = useMemo(() => {
    if (
      datasetOptions.some(
        (option) => option.relativePath === selectedDatasetPath,
      )
    ) {
      return datasetOptions;
    }

    return [
      {
        relativePath: selectedDatasetPath,
        totalEpisodes: null,
        totalFrames: null,
        integrityStatus: null,
      },
      ...datasetOptions,
    ];
  }, [datasetOptions, selectedDatasetPath]);
  const selectedDatasetName = datasetNameFromPath(selectedDatasetPath);
  const selectedOrganization =
    selectedDatasetPath.split("/")[0]?.trim() || "TacVerse";
  const selectedReportLabel = `${selectedDatasetName}/.tacflow/doctor-before.json`;
  const datasetSelectorDisabled = Boolean(runningStep) || scoreRunning;
  const createReviewTaskFromFinding = useCallback(
    (finding: TacFlowDoctorFinding, checkName: string) => {
      const task = createWorkbenchReviewTask({
        organization: selectedDatasetPath.split("/")[0] ?? "local",
        source: "tacflow",
        title: `${checkName} finding`,
        detail: findingSummary(finding),
        datasetPath: selectedDatasetPath || null,
        episodeId: findingNumber(finding, "episode"),
        frame: findingNumber(finding, "frame"),
      });
      setScoreActionMessage(
        task
          ? "Review task created in this browser."
          : "Unable to create review task.",
      );
    },
    [selectedDatasetPath],
  );

  useEffect(() => {
    setScoreWeights(readStoredScoreWeights());
    setScoreWeightsLoaded(true);
  }, []);

  useEffect(() => {
    if (!scoreWeightsLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(
      TACFLOW_SCORE_WEIGHT_STORAGE_KEY,
      JSON.stringify(scoreWeights),
    );
  }, [scoreWeights, scoreWeightsLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function loadDatasets() {
      setDatasetLoadState("loading");
      setDatasetError(null);

      try {
        const response = await fetch("/api/local-datasets", {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Unable to load local datasets.");
        }
        const options = readLocalDatasetOptions(await response.json());
        if (cancelled) return;

        setDatasetOptions(options);
        setSelectedDatasetPath((current) => {
          if (options.some((option) => option.relativePath === current)) {
            return current;
          }
          return findPreferredDatasetPath(options) ?? current;
        });
        setDatasetLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        setDatasetLoadState("failed");
        setDatasetError(error instanceof Error ? error.message : String(error));
      }
    }

    void loadDatasets();

    return () => {
      cancelled = true;
    };
  }, []);

  const applyEvent = useCallback((event: TacFlowStreamEvent) => {
    setSteps((current) => updateForEvent(current, event));
  }, []);

  const applyScoreEvent = useCallback((event: TacFlowScoreStreamEvent) => {
    setScore((current) => updateScoreForEvent(current, event));
  }, []);

  const markFailed = useCallback((step: TacFlowStepId, error: string) => {
    setSteps((current) => ({
      ...current,
      [step]: {
        ...current[step],
        status: "failed",
        percent: 100,
        message: error,
        error,
      },
    }));
  }, []);

  const markScoreFailed = useCallback((error: string) => {
    setScore((current) => ({
      ...current,
      status: "failed",
      percent: 100,
      message: error,
      error,
    }));
  }, []);

  const resetDependents = useCallback((step: TacFlowStepId) => {
    setSteps((current) => {
      if (step === "step_1") {
        return {
          ...current,
          step_2: resetStep(),
          step_3: resetStep(),
        };
      }
      if (step === "step_2") {
        return {
          ...current,
          step_3: resetStep(),
        };
      }
      return current;
    });
  }, []);

  const updateScoreWeight = useCallback((id: string, weight: number) => {
    setScoreWeights((current) => ({
      ...current,
      [id]: normalizeTacFlowScoreWeight(weight),
    }));
  }, []);

  const handleDatasetChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setSelectedDatasetPath(event.target.value);
      setSteps(initialState());
      setScore(resetScore());
    },
    [],
  );

  const runScore = useCallback(async () => {
    setScore({
      ...resetScore(),
      status: "running",
      percent: 10,
      message: "Starting...",
    });

    let response: Response;
    try {
      response = await fetch("/api/tacflow/score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetPath: selectedDatasetPath }),
      });
    } catch (error) {
      markScoreFailed(error instanceof Error ? error.message : String(error));
      return;
    }

    if (!response.ok || !response.body) {
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      markScoreFailed(parseErrorMessage(payload));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as unknown;
          if (isTacFlowScoreEvent(parsed)) applyScoreEvent(parsed);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = JSON.parse(buffer) as unknown;
        if (isTacFlowScoreEvent(parsed)) applyScoreEvent(parsed);
      }
    } catch (error) {
      markScoreFailed(error instanceof Error ? error.message : String(error));
    }
  }, [applyScoreEvent, markScoreFailed, selectedDatasetPath]);

  const runStep = useCallback(
    async (step: TacFlowStepId) => {
      resetDependents(step);
      setSteps((current) => ({
        ...current,
        [step]: {
          ...resetStep(),
          status: "running",
          percent: 10,
          message: "Starting...",
        },
      }));

      let response: Response;
      try {
        response = await fetch("/api/tacflow/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ step, datasetPath: selectedDatasetPath }),
        });
      } catch (error) {
        markFailed(
          step,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      if (!response.ok || !response.body) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        markFailed(step, parseErrorMessage(payload));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line) as unknown;
            if (isTacFlowEvent(parsed)) applyEvent(parsed);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const parsed = JSON.parse(buffer) as unknown;
          if (isTacFlowEvent(parsed)) applyEvent(parsed);
        }
      } catch (error) {
        markFailed(
          step,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [applyEvent, markFailed, resetDependents, selectedDatasetPath],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">TacFlow</h2>
          <p
            className="mt-1 truncate text-xs text-slate-500"
            title={selectedDatasetPath}
          >
            {selectedDatasetName}
          </p>
        </div>
        <div className="flex w-full flex-col gap-1 lg:w-[28rem]">
          <label
            htmlFor="tacflow-dataset"
            className="text-[10px] font-semibold uppercase tracking-wide text-slate-500"
          >
            Dataset
          </label>
          <select
            id="tacflow-dataset"
            value={selectedDatasetPath}
            onChange={handleDatasetChange}
            disabled={datasetSelectorDisabled}
            className="h-10 w-full rounded-md border border-white/10 bg-slate-950 px-3 text-xs text-slate-200 outline-none transition-colors focus:border-cyan-300/70 disabled:cursor-not-allowed disabled:bg-white/[0.03] disabled:text-slate-500"
          >
            {datasetSelectOptions.map((option) => (
              <option key={option.relativePath} value={option.relativePath}>
                {formatDatasetOption(option)}
              </option>
            ))}
          </select>
          {datasetLoadState === "loading" && (
            <p className="text-[11px] text-slate-500">Loading datasets...</p>
          )}
          {datasetLoadState === "failed" && datasetError && (
            <p className="text-[11px] text-red-300">{datasetError}</p>
          )}
        </div>
      </div>

      <WorkbenchSharedSync organization={selectedOrganization} compact />

      <div className="panel-raised min-h-0 flex-1 overflow-y-auto p-4">
        <ScoreSection
          state={score}
          calculation={scoreCalculation}
          running={scoreRunning}
          reportLabel={selectedReportLabel}
          onRun={runScore}
          onWeightChange={updateScoreWeight}
          selectedDatasetPath={selectedDatasetPath}
          onCreateReviewTask={createReviewTaskFromFinding}
        />
        {scoreActionMessage && (
          <p className="pt-2 text-[11px] text-emerald-300" role="status">
            {scoreActionMessage}
          </p>
        )}
        <div className="pt-1">
          {STEP_DEFINITIONS.map((definition) => {
            const dependencyDone =
              !definition.dependsOn ||
              steps[definition.dependsOn].status === "done";
            const disabled =
              Boolean(runningStep) || !dependencyDone || !selectedDatasetPath;
            const disabledReason = !selectedDatasetPath
              ? "Select a dataset"
              : runningStep
                ? `${runningStep} is running`
                : definition.dependsOn
                  ? `${definition.dependsOn} must finish first`
                  : definition.name;
            return (
              <StepRow
                key={definition.id}
                definition={definition}
                state={steps[definition.id]}
                disabled={disabled}
                disabledReason={disabledReason}
                onRun={runStep}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

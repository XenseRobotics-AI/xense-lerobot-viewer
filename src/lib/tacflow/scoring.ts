import type { TacFlowArtifacts, TacFlowRunStatus } from "@/types/tacflow.types";

export const TACFLOW_SCORE_WEIGHT_STORAGE_KEY = "tacflow-score-weights:v1";
export const DEFAULT_TACFLOW_SCORE_WEIGHT = 1;
export const MIN_TACFLOW_SCORE_WEIGHT = 0;
export const MAX_TACFLOW_SCORE_WEIGHT = 100;

export type TacFlowDoctorSeverity = "PASS" | "WARN" | "FAIL";
export type TacFlowScoreGrade = "A" | "B" | "C" | "D";

export type TacFlowDoctorMessage = {
  severity: TacFlowDoctorSeverity;
  message: string;
};

export type TacFlowDoctorFinding = Record<string, unknown>;

export type TacFlowDoctorCheck = {
  id: string;
  name: string;
  severity: TacFlowDoctorSeverity;
  messages: TacFlowDoctorMessage[];
  findings: TacFlowDoctorFinding[];
};

export type TacFlowDoctorReport = {
  schema?: string;
  version?: string;
  dataset_path?: string;
  dataset_name?: string | null;
  codebase_version?: string | null;
  format_version?: string | null;
  total_episodes?: number | null;
  total_frames?: number | null;
  fps?: number | null;
  overall_severity?: TacFlowDoctorSeverity;
  summary?: Partial<Record<TacFlowDoctorSeverity, number>>;
  checks: TacFlowDoctorCheck[];
};

export type TacFlowScoreStatusEvent = {
  type: "status";
  status: TacFlowRunStatus;
  percent: number;
  message: string;
};

export type TacFlowScoreLogEvent = {
  type: "log";
  stream: "stdout" | "stderr";
  line: string;
};

export type TacFlowScoreResultEvent = {
  type: "result";
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  artifacts: TacFlowArtifacts;
  report?: TacFlowDoctorReport;
  summary?: { stderrTail?: string[] };
  error?: string;
};

export type TacFlowScoreErrorEvent = {
  type: "error";
  error: string;
};

export type TacFlowScoreStreamEvent =
  | TacFlowScoreStatusEvent
  | TacFlowScoreLogEvent
  | TacFlowScoreResultEvent
  | TacFlowScoreErrorEvent;

export type TacFlowScoreRow = TacFlowDoctorCheck & {
  baseScore: number;
  weight: number;
  weightedScore: number;
};

export type TacFlowScoreCalculation =
  | {
      ok: true;
      score: number;
      grade: TacFlowScoreGrade;
      weightSum: number;
      rows: TacFlowScoreRow[];
    }
  | {
      ok: false;
      error: string;
      weightSum: number;
      rows: TacFlowScoreRow[];
    };

const BASE_SCORE_BY_SEVERITY: Record<TacFlowDoctorSeverity, number> = {
  PASS: 100,
  WARN: 70,
  FAIL: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringValue(value) ?? undefined;
}

function nullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseSeverity(value: unknown, context: string): TacFlowDoctorSeverity {
  if (value === "PASS" || value === "WARN" || value === "FAIL") return value;
  throw new Error(`${context} severity must be PASS, WARN, or FAIL.`);
}

function parseOptionalSeverity(
  value: unknown,
): TacFlowDoctorSeverity | undefined {
  return value === "PASS" || value === "WARN" || value === "FAIL"
    ? value
    : undefined;
}

function parseMessages(
  value: unknown,
  fallbackSeverity: TacFlowDoctorSeverity,
): TacFlowDoctorMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): TacFlowDoctorMessage[] => {
    if (typeof item === "string") {
      return [{ severity: fallbackSeverity, message: item }];
    }
    if (!isRecord(item)) return [];

    const message = stringValue(item.message) ?? JSON.stringify(item);
    return [
      {
        severity: parseOptionalSeverity(item.severity) ?? fallbackSeverity,
        message,
      },
    ];
  });
}

function parseFindings(value: unknown): TacFlowDoctorFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TacFlowDoctorFinding[] =>
    isRecord(item) ? [{ ...item }] : [],
  );
}

function parseSummary(
  value: unknown,
): Partial<Record<TacFlowDoctorSeverity, number>> | undefined {
  if (!isRecord(value)) return undefined;

  const summary: Partial<Record<TacFlowDoctorSeverity, number>> = {};
  for (const severity of ["PASS", "WARN", "FAIL"] as const) {
    const count = value[severity];
    if (typeof count === "number" && Number.isFinite(count)) {
      summary[severity] = count;
    }
  }
  return summary;
}

export function parseTacFlowDoctorReport(value: unknown): TacFlowDoctorReport {
  if (!isRecord(value)) {
    throw new Error("doctor-before.json must contain a JSON object.");
  }

  if (!Array.isArray(value.checks)) {
    throw new Error("doctor-before.json must contain checks[].");
  }

  const checks = value.checks.map((rawCheck, index): TacFlowDoctorCheck => {
    if (!isRecord(rawCheck)) {
      throw new Error(`checks[${index}] must be a JSON object.`);
    }

    const id =
      stringValue(rawCheck.id) ??
      stringValue(rawCheck.check_id) ??
      stringValue(rawCheck.name) ??
      `check_${index + 1}`;
    const severity = parseSeverity(rawCheck.severity, `checks[${index}]`);

    return {
      id,
      name: stringValue(rawCheck.name) ?? id,
      severity,
      messages: parseMessages(rawCheck.messages, severity),
      findings: parseFindings(rawCheck.findings),
    };
  });

  return {
    schema: stringValue(value.schema) ?? undefined,
    version: stringValue(value.version) ?? undefined,
    dataset_path: stringValue(value.dataset_path) ?? undefined,
    dataset_name: nullableStringValue(value.dataset_name),
    codebase_version: nullableStringValue(value.codebase_version),
    format_version: nullableStringValue(value.format_version),
    total_episodes: nullableNumberValue(value.total_episodes),
    total_frames: nullableNumberValue(value.total_frames),
    fps: nullableNumberValue(value.fps),
    overall_severity: parseOptionalSeverity(value.overall_severity),
    summary: parseSummary(value.summary),
    checks,
  };
}

export function baseScoreForSeverity(severity: TacFlowDoctorSeverity): number {
  return BASE_SCORE_BY_SEVERITY[severity];
}

export function normalizeTacFlowScoreWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TACFLOW_SCORE_WEIGHT;
  }
  return Math.min(
    MAX_TACFLOW_SCORE_WEIGHT,
    Math.max(MIN_TACFLOW_SCORE_WEIGHT, value),
  );
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

export function gradeTacFlowScore(score: number): TacFlowScoreGrade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  return "D";
}

export function calculateTacFlowScore(
  checks: TacFlowDoctorCheck[],
  weights: Record<string, number>,
): TacFlowScoreCalculation {
  const rowsWithoutWeightedScore = checks.map((check) => ({
    ...check,
    baseScore: baseScoreForSeverity(check.severity),
    weight: normalizeTacFlowScoreWeight(weights[check.id]),
    weightedScore: 0,
  }));
  const weightSum = rowsWithoutWeightedScore.reduce(
    (sum, row) => sum + row.weight,
    0,
  );

  if (weightSum <= 0) {
    return {
      ok: false,
      error: "At least one TacFlow score weight must be greater than 0.",
      weightSum,
      rows: rowsWithoutWeightedScore,
    };
  }

  const rows = rowsWithoutWeightedScore.map((row) => ({
    ...row,
    weightedScore: (row.baseScore * row.weight) / weightSum,
  }));
  const score = Math.min(
    100,
    roundScore(rows.reduce((sum, row) => sum + row.weightedScore, 0)),
  );

  return {
    ok: true,
    score,
    grade: gradeTacFlowScore(score),
    weightSum,
    rows,
  };
}

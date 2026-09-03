export const TACFLOW_STEP_IDS = ["step_1", "step_2", "step_3"] as const;

export type TacFlowStepId = (typeof TACFLOW_STEP_IDS)[number];

export type TacFlowRunStatus =
  | "idle"
  | "running"
  | "command finished"
  | "done"
  | "failed";

export type TacFlowArtifacts = Record<string, string>;

export type TacFlowSummary = {
  eventCount?: number | null;
  summaryLines?: string[];
  highlights?: string[];
  stderrTail?: string[];
};

export type TacFlowStatusEvent = {
  type: "status";
  step: TacFlowStepId;
  status: TacFlowRunStatus;
  percent: number;
  message: string;
};

export type TacFlowLogEvent = {
  type: "log";
  step: TacFlowStepId;
  stream: "stdout" | "stderr";
  line: string;
};

export type TacFlowResultEvent = {
  type: "result";
  step: TacFlowStepId;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  artifacts: TacFlowArtifacts;
  summary: TacFlowSummary;
  error?: string;
};

export type TacFlowErrorEvent = {
  type: "error";
  step: TacFlowStepId;
  error: string;
};

export type TacFlowStreamEvent =
  | TacFlowStatusEvent
  | TacFlowLogEvent
  | TacFlowResultEvent
  | TacFlowErrorEvent;

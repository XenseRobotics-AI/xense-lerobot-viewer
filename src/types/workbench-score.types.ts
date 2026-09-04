import type { DoctorReport } from "@/types/doctor.types";
import type {
  TacFlowDoctorReport,
  TacFlowScoreGrade,
  TacFlowScoreRow,
} from "@/lib/tacflow/scoring";

export type WorkbenchTacFlowScoreStatus = "scored" | "retry";

export type WorkbenchTacFlowScoreLedgerEntry = {
  datasetPath: string;
  doctorReport: DoctorReport | TacFlowDoctorReport | null;
  score: number | null;
  grade: TacFlowScoreGrade | null;
  rows: TacFlowScoreRow[];
  tacflowVersion: string;
  checkWeights: Record<string, number>;
  datasetFingerprint: string;
  scoredAt: string | null;
  status: WorkbenchTacFlowScoreStatus;
  error?: string;
};

export type WorkbenchTacFlowScoreLedger = {
  org: string;
  version: 1;
  updatedAt: string | null;
  entries: WorkbenchTacFlowScoreLedgerEntry[];
};

export type WorkbenchDatasetScore = {
  status: WorkbenchTacFlowScoreStatus;
  score: number | null;
  grade: TacFlowScoreGrade | null;
  doctorReport: DoctorReport | TacFlowDoctorReport | null;
  scoredAt: string | null;
  error?: string;
};

export type WorkbenchQualitySettlement = {
  datasetPath: string;
  grade: TacFlowScoreGrade | null;
  pool: number;
  allocated: boolean;
  status: "allocated" | "unassigned" | "pending";
  allocations: Record<string, number>;
};

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import type {
  WorkbenchTacFlowScoreLedger,
  WorkbenchTacFlowScoreLedgerEntry,
} from "@/types/workbench-score.types";

const STORE_DIR = ".xense-viewer";
const WORKBENCH_DIR = "workbench";
const LEDGER_VERSION = 1 as const;
const MAX_ORG_LENGTH = 128;

function normalizeOrg(value: string): string {
  const org = value.trim();
  if (!org) throw new Error("A non-empty organization is required.");
  if (org.length > MAX_ORG_LENGTH || org.includes("/") || org.includes("\\")) {
    throw new Error("Organization is invalid.");
  }
  return org;
}

export function workbenchTacFlowScoreLedgerPath(
  org: string,
  root = resolveLocalDatasetRoot(),
): string {
  return path.join(
    root,
    STORE_DIR,
    WORKBENCH_DIR,
    encodeURIComponent(normalizeOrg(org)) + ".tacflow-score-ledger.json",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGrade(
  value: unknown,
): value is WorkbenchTacFlowScoreLedgerEntry["grade"] {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function validWeights(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (weight) => typeof weight === "number" && Number.isFinite(weight),
    )
  );
}

function validEntry(value: unknown): value is WorkbenchTacFlowScoreLedgerEntry {
  if (
    !isRecord(value) ||
    typeof value.datasetPath !== "string" ||
    !value.datasetPath.trim()
  )
    return false;
  if (value.status !== "scored" && value.status !== "retry") return false;
  if (typeof value.tacflowVersion !== "string" || !value.tacflowVersion.trim())
    return false;
  if (
    typeof value.datasetFingerprint !== "string" ||
    !value.datasetFingerprint.trim()
  )
    return false;
  if (!validWeights(value.checkWeights) || !Array.isArray(value.rows))
    return false;
  if (typeof value.scoredAt !== "string" || !value.scoredAt.trim())
    return false;
  if (value.status === "scored") {
    return (
      typeof value.score === "number" &&
      Number.isFinite(value.score) &&
      isGrade(value.grade) &&
      isRecord(value.doctorReport)
    );
  }
  return value.score === null && value.grade === null;
}

export async function readWorkbenchTacFlowScoreLedger(
  org: string,
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchTacFlowScoreLedger> {
  const normalizedOrg = normalizeOrg(org);
  try {
    const parsed = JSON.parse(
      await fs.readFile(
        workbenchTacFlowScoreLedgerPath(normalizedOrg, root),
        "utf8",
      ),
    ) as unknown;
    if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION) {
      throw new Error("Unsupported Workbench TACFLOW score ledger version.");
    }
    const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      org: normalizedOrg,
      version: LEDGER_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      entries: rawEntries.filter(validEntry).map((entry) => ({ ...entry })),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        org: normalizedOrg,
        version: LEDGER_VERSION,
        updatedAt: null,
        entries: [],
      };
    }
    throw error;
  }
}

export async function writeWorkbenchTacFlowScoreLedger(
  org: string,
  entries: readonly WorkbenchTacFlowScoreLedgerEntry[],
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchTacFlowScoreLedger> {
  const normalizedOrg = normalizeOrg(org);
  const destination = workbenchTacFlowScoreLedgerPath(normalizedOrg, root);
  const directory = path.dirname(destination);
  const updatedAt = new Date().toISOString();
  const ledger: WorkbenchTacFlowScoreLedger = {
    org: normalizedOrg,
    version: LEDGER_VERSION,
    updatedAt,
    entries: [...entries].sort((left, right) =>
      left.datasetPath.localeCompare(right.datasetPath),
    ),
  };
  await fs.mkdir(directory, { recursive: true });
  const temporary = destination + "." + process.pid + ".tmp";
  try {
    await fs.writeFile(
      temporary,
      JSON.stringify(ledger, null, 2) + "\n",
      "utf8",
    );
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return ledger;
}

/** Stable manifest fingerprint; it never reads or changes dataset payloads. */
export async function fingerprintWorkbenchDataset(
  datasetRoot: string,
): Promise<string> {
  const hash = createHash("sha256");
  async function walk(current: string, relative: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const childRelative = relative
        ? path.join(relative, entry.name)
        : entry.name;
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch {
        continue;
      }
      hash.update(
        childRelative.split(path.sep).join("/") +
          "\0" +
          entry.isDirectory() +
          "\0" +
          stat.size +
          "\0" +
          stat.mtimeMs +
          "\n",
      );
      if (entry.isDirectory()) await walk(full, childRelative);
    }
  }
  await walk(path.resolve(datasetRoot), "");
  return hash.digest("hex");
}

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DoctorReport } from "@/types/doctor.types";
import type { WorkbenchTacFlowScoreLedgerEntry } from "@/types/workbench-score.types";
import {
  fingerprintWorkbenchDataset,
  readWorkbenchTacFlowScoreLedger,
  workbenchTacFlowScoreLedgerPath,
  writeWorkbenchTacFlowScoreLedger,
} from "@/lib/workbench-score-ledger";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function report(): DoctorReport {
  return {
    version: "1.1.0-ts",
    dataset_path: "/tmp/TacVerse/task-0903",
    dataset_name: "task-0903",
    codebase_version: "test",
    format_version: "1",
    total_episodes: 1,
    total_frames: 1,
    fps: 30,
    overall_severity: "PASS",
    checks: [],
    summary: { PASS: 0, WARN: 0, FAIL: 0 },
  };
}

function entry(
  pathName: string,
  fingerprint: string,
): WorkbenchTacFlowScoreLedgerEntry {
  return {
    datasetPath: pathName,
    doctorReport: report(),
    score: 100,
    grade: "A",
    rows: [],
    tacflowVersion: "1.1.0-ts",
    checkWeights: { metadata: 1 },
    datasetFingerprint: fingerprint,
    scoredAt: "2026-09-04T00:00:00.000Z",
    status: "scored",
  };
}

describe("Workbench TACFLOW score ledger", () => {
  test("writes atomically, reads back, and fingerprints dataset changes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workbench-score-ledger-"),
    );
    roots.push(root);
    const datasetRoot = path.join(root, "TacVerse", "task-0903");
    await fs.mkdir(path.join(datasetRoot, "meta"), { recursive: true });
    await fs.writeFile(path.join(datasetRoot, "meta", "info.json"), "first");
    const before = await fingerprintWorkbenchDataset(datasetRoot);
    await fs.writeFile(
      path.join(datasetRoot, "meta", "info.json"),
      "changed-content",
    );
    const after = await fingerprintWorkbenchDataset(datasetRoot);
    expect(after).not.toBe(before);

    const written = await writeWorkbenchTacFlowScoreLedger(
      "TacVerse",
      [entry("TacVerse/task-0903", after)],
      root,
    );
    expect(written.entries).toHaveLength(1);
    await expect(
      readWorkbenchTacFlowScoreLedger("TacVerse", root),
    ).resolves.toMatchObject({
      org: "TacVerse",
      version: 1,
      entries: [{ datasetPath: "TacVerse/task-0903", score: 100, grade: "A" }],
    });
    const names = await fs.readdir(
      path.dirname(workbenchTacFlowScoreLedgerPath("TacVerse", root)),
    );
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("returns an empty ledger when no file exists", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workbench-score-ledger-empty-"),
    );
    roots.push(root);
    await expect(
      readWorkbenchTacFlowScoreLedger("TacVerse", root),
    ).resolves.toEqual({
      org: "TacVerse",
      version: 1,
      updatedAt: null,
      entries: [],
    });
  });
});

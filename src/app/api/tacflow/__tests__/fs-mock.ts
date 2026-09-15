import { mock } from "bun:test";
import { promises as realFs } from "node:fs";

export const TACFLOW_TEST_DATASET_ROOT = `${process.env.HOME?.trim() || "/home/xense"}/.cache/huggingface/lerobot`;

export const TACFLOW_DOCTOR_REPORT = JSON.stringify({
  schema: "tacflow.doctor/1",
  overall_severity: "WARN",
  checks: [
    {
      id: "metadata",
      name: "Metadata",
      severity: "PASS",
      messages: [{ severity: "PASS", message: "metadata ok" }],
      findings: [],
    },
    {
      id: "per_episode",
      name: "Per-Episode Summary",
      severity: "WARN",
      messages: [{ severity: "WARN", message: "Episode 1 action jump" }],
      findings: [{ kind: "action_jump", episode: 1 }],
    },
  ],
});

function enoent(filePath: string): Error {
  const error = new Error(`ENOENT: no such file, open '${filePath}'`);
  (error as Error & { code?: string }).code = "ENOENT";
  return error;
}

function virtualRead(filePath: string): string {
  if (filePath.endsWith("/meta/info.json")) return "{}";
  if (filePath.endsWith("/.tacflow/doctor-before.json")) {
    if (filePath.includes("tacflow-missing-doctor-0903")) {
      throw enoent(filePath);
    }
    if (filePath.includes("tacflow-invalid-doctor-0903")) return "{";
    return TACFLOW_DOCTOR_REPORT;
  }
  throw enoent(filePath);
}

/**
 * Preserve every unrecognised fs/promises operation and file read. TacFlow
 * tests virtualise only their fixed dataset root, so unrelated tests keep the
 * native filesystem and native fs methods such as mkdtemp/rm.
 */
export const readFileMock = mock(
  async (
    filePath: string | URL | Buffer,
    options?: unknown,
  ): Promise<unknown> => {
    const key = String(filePath);
    if (key.startsWith(`${TACFLOW_TEST_DATASET_ROOT}/`)) {
      return virtualRead(key);
    }
    return realFs.readFile(
      filePath as Parameters<typeof realFs.readFile>[0],
      options as Parameters<typeof realFs.readFile>[1],
    );
  },
);

const fsPromisesMock = {
  ...realFs,
  readFile: readFileMock,
};

export const fsMockModule = {
  default: fsPromisesMock,
  ...fsPromisesMock,
};

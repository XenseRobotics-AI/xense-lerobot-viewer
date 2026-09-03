import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { TacFlowScoreStreamEvent } from "@/lib/tacflow/scoring";

type SpawnCall = {
  command: string;
  args: string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  };
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

const DATASET_ROOT = "/home/xense/.cache/huggingface/lerobot";
const DEFAULT_DATASET_RELATIVE = "TacVerse/taccap-g1-fold-garment-0819";
const DEFAULT_DATASET = `${DATASET_ROOT}/${DEFAULT_DATASET_RELATIVE}`;
const DEFAULT_INFO_JSON = `${DEFAULT_DATASET}/meta/info.json`;
const DOCTOR_BEFORE_JSON = `${DEFAULT_DATASET}/.tacflow/doctor-before.json`;
const OTHER_DATASET_RELATIVE = "TacVerse/taccap-g1-hang-shirt-0903";
const OTHER_DATASET = `${DATASET_ROOT}/${OTHER_DATASET_RELATIVE}`;
const OTHER_INFO_JSON = `${OTHER_DATASET}/meta/info.json`;
const OTHER_DOCTOR_BEFORE_JSON = `${OTHER_DATASET}/.tacflow/doctor-before.json`;

let spawnCalls: SpawnCall[] = [];
let nextExitCode: number | null = 0;
let nextStdout = "Pre-repair / Doctor checks\n";
let nextStderr = "";
let files = new Map<string, string>();

const spawnMock = mock(
  (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => {
    spawnCalls.push({ command, args, options });
    const child = new FakeChild();
    queueMicrotask(() => {
      if (nextStdout) child.stdout.emit("data", Buffer.from(nextStdout));
      if (nextStderr) child.stderr.emit("data", Buffer.from(nextStderr));
      child.emit("close", nextExitCode);
    });
    return child;
  },
);

const readFileMock = mock(async (filePath: string) => {
  const content = files.get(String(filePath));
  if (content === undefined) {
    const error = new Error(`ENOENT: no such file, open '${filePath}'`);
    (error as Error & { code?: string }).code = "ENOENT";
    throw error;
  }
  return content;
});

mock.module("node:child_process", () => ({
  spawn: spawnMock,
}));

mock.module("node:fs/promises", () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

async function routePost() {
  const mod = await import("@/app/api/tacflow/score/route");
  return mod.POST;
}

function postRequest(body?: unknown): Request {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new Request("http://localhost/api/tacflow/score", init);
}

async function readEvents(
  response: Response,
): Promise<TacFlowScoreStreamEvent[]> {
  const text = await response.text();
  return text
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TacFlowScoreStreamEvent);
}

function doctorReport(): string {
  return JSON.stringify({
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
}

beforeEach(() => {
  spawnCalls = [];
  nextExitCode = 0;
  nextStdout = "Pre-repair / Doctor checks\n";
  nextStderr = "";
  files = new Map([
    [DEFAULT_INFO_JSON, "{}"],
    [DOCTOR_BEFORE_JSON, doctorReport()],
  ]);
  spawnMock.mockClear();
  readFileMock.mockClear();
});

afterEach(() => {
  nextExitCode = 0;
  nextStdout = "";
  nextStderr = "";
  files = new Map();
});

describe("TacFlow score route", () => {
  test("streams NDJSON status, log, and result events", async () => {
    const POST = await routePost();

    const response = await POST(postRequest() as never);
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(events.some((event) => event.type === "status")).toBe(true);
    expect(events.some((event) => event.type === "log")).toBe(true);
    expect(result).toMatchObject({
      type: "result",
      ok: true,
      artifacts: {
        doctorBeforeJson: DOCTOR_BEFORE_JSON,
      },
      report: {
        checks: [
          { id: "metadata", severity: "PASS" },
          { id: "per_episode", severity: "WARN" },
        ],
      },
    });
    expect(
      events.some(
        (event) => event.type === "status" && event.status === "done",
      ),
    ).toBe(true);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("bash");
    expect(spawnCalls[0].args[0]).toBe("-lc");
    expect(spawnCalls[0].args[1]).toContain("mamba activate 'TacFlow-main'");
    expect(spawnCalls[0].args[1]).toContain(
      "'python' 'scripts/process_dataset.py'",
    );
    expect(spawnCalls[0].args[1]).toContain(DEFAULT_DATASET_RELATIVE);
    expect(spawnCalls[0].options.cwd).toBe("/home/xense/src/TacFlow-Engine");
  });

  test("uses the selected local dataset path", async () => {
    const POST = await routePost();
    files = new Map([
      [OTHER_INFO_JSON, "{}"],
      [OTHER_DOCTOR_BEFORE_JSON, doctorReport()],
    ]);

    const response = await POST(
      postRequest({ datasetPath: OTHER_DATASET_RELATIVE }) as never,
    );
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      type: "result",
      ok: true,
      artifacts: {
        doctorBeforeJson: OTHER_DOCTOR_BEFORE_JSON,
      },
    });
    expect(spawnCalls[0].args[1]).toContain(OTHER_DATASET_RELATIVE);
  });

  test("rejects invalid dataset paths", async () => {
    const POST = await routePost();
    const response = await POST(
      postRequest({ datasetPath: "TacVerse/../outside" }) as never,
    );

    expect(response.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "Local dataset paths cannot contain '..' segments.",
    });
  });

  test("returns the Doctor report when the command exits non-zero after writing it", async () => {
    const POST = await routePost();
    nextExitCode = 2;
    nextStdout = "Status: skipped_unsafe\n";
    nextStderr = "post-doctor warning\n";

    const response = await POST(postRequest() as never);
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");

    expect(result).toMatchObject({
      type: "result",
      ok: true,
      exitCode: 2,
      report: {
        checks: [
          { id: "metadata", severity: "PASS" },
          { id: "per_episode", severity: "WARN" },
        ],
      },
      summary: {
        stderrTail: ["post-doctor warning"],
      },
    });
    expect(
      events.some(
        (event) =>
          event.type === "status" &&
          event.status === "done" &&
          event.message.includes("Doctor report loaded"),
      ),
    ).toBe(true);
  });

  test("reports stderr tail when non-zero exit leaves no Doctor report", async () => {
    const POST = await routePost();
    nextExitCode = 2;
    nextStdout = "";
    nextStderr = "first warning\nlast failure\n";
    files = new Map([[DEFAULT_INFO_JSON, "{}"]]);

    const response = await POST(postRequest() as never);
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");
    const error = events.find((event) => event.type === "error");

    expect(result).toMatchObject({
      type: "result",
      ok: false,
      exitCode: 2,
      summary: {
        stderrTail: ["first warning", "last failure"],
      },
    });
    expect(error).toMatchObject({
      type: "error",
      error: expect.stringContaining("Unable to read doctor-before.json"),
    });
  });

  test("returns an error when doctor-before.json is missing", async () => {
    const POST = await routePost();
    files = new Map([[DEFAULT_INFO_JSON, "{}"]]);

    const response = await POST(postRequest() as never);
    const events = await readEvents(response);

    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.includes("Unable to read doctor-before.json"),
      ),
    ).toBe(true);
  });

  test("returns an error when doctor-before.json is invalid", async () => {
    const POST = await routePost();
    files = new Map([
      [DEFAULT_INFO_JSON, "{}"],
      [DOCTOR_BEFORE_JSON, "{"],
    ]);

    const response = await POST(postRequest() as never);
    const events = await readEvents(response);

    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.includes("Invalid doctor-before.json"),
      ),
    ).toBe(true);
  });
});

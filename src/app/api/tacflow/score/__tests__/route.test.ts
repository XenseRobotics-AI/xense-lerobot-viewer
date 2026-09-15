import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { TacFlowScoreStreamEvent } from "@/lib/tacflow/scoring";
import {
  fsMockModule,
  readFileMock,
  TACFLOW_TEST_DATASET_ROOT,
} from "@/app/api/tacflow/__tests__/fs-mock";

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

const DATASET_ROOT = TACFLOW_TEST_DATASET_ROOT;
const DEFAULT_DATASET_RELATIVE = "TacVerse/taccap-g1-fold-garment-0819";
const DEFAULT_DATASET = `${DATASET_ROOT}/${DEFAULT_DATASET_RELATIVE}`;
const DOCTOR_BEFORE_JSON = `${DEFAULT_DATASET}/.tacflow/doctor-before.json`;
const OTHER_DATASET_RELATIVE = "TacVerse/taccap-g1-hang-shirt-0903";
const OTHER_DATASET = `${DATASET_ROOT}/${OTHER_DATASET_RELATIVE}`;
const OTHER_DOCTOR_BEFORE_JSON = `${OTHER_DATASET}/.tacflow/doctor-before.json`;
const MISSING_DOCTOR_DATASET_RELATIVE = "TacVerse/tacflow-missing-doctor-0903";
const MISSING_DOCTOR_BEFORE_JSON = `${DATASET_ROOT}/${MISSING_DOCTOR_DATASET_RELATIVE}/.tacflow/doctor-before.json`;
const INVALID_DOCTOR_DATASET_RELATIVE = "TacVerse/tacflow-invalid-doctor-0903";

let spawnCalls: SpawnCall[] = [];
let nextExitCode: number | null = 0;
let nextStdout = "Pre-repair / Doctor checks\n";
let nextStderr = "";
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

mock.module("node:child_process", () => ({
  spawn: spawnMock,
}));

mock.module("node:fs/promises", () => fsMockModule);

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

beforeEach(() => {
  spawnCalls = [];
  nextExitCode = 0;
  nextStdout = "Pre-repair / Doctor checks\n";
  nextStderr = "";
  spawnMock.mockClear();
  readFileMock.mockClear();
});

afterEach(() => {
  nextExitCode = 0;
  nextStdout = "";
  nextStderr = "";
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

    const response = await POST(
      postRequest({ datasetPath: MISSING_DOCTOR_DATASET_RELATIVE }) as never,
    );
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
      error: expect.stringContaining(MISSING_DOCTOR_BEFORE_JSON),
    });
  });

  test("returns an error when doctor-before.json is missing", async () => {
    const POST = await routePost();

    const response = await POST(
      postRequest({ datasetPath: MISSING_DOCTOR_DATASET_RELATIVE }) as never,
    );
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

    const response = await POST(
      postRequest({ datasetPath: INVALID_DOCTOR_DATASET_RELATIVE }) as never,
    );
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

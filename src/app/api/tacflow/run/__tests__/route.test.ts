import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { TacFlowStreamEvent } from "@/types/tacflow.types";
import {
  fsMockModule,
  readFileMock,
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

const OTHER_DATASET_RELATIVE = "TacVerse/taccap-g1-hang-shirt-0903";

let spawnCalls: SpawnCall[] = [];
let nextExitCode: number | null = 0;
let nextStdout = "Source: /tmp/source\nRepaired dataset: /tmp/repaired\n";
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
  const mod = await import("@/app/api/tacflow/run/route");
  return mod.POST;
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/tacflow/run", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function readEvents(response: Response): Promise<TacFlowStreamEvent[]> {
  const text = await response.text();
  return text
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TacFlowStreamEvent);
}

beforeEach(() => {
  spawnCalls = [];
  nextExitCode = 0;
  nextStdout = "Source: /tmp/source\nRepaired dataset: /tmp/repaired\n";
  nextStderr = "";
  spawnMock.mockClear();
  readFileMock.mockClear();
});

afterEach(() => {
  nextExitCode = 0;
  nextStdout = "";
  nextStderr = "";
});

describe("TacFlow run route", () => {
  test("rejects unknown steps", async () => {
    const POST = await routePost();
    const response = await POST(postRequest({ step: "unknown" }) as never);

    expect(response.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "step must be one of: step_1, step_2, step_3.",
    });
  });

  test("streams status, log, result, and done events for each step", async () => {
    const POST = await routePost();

    for (const step of ["step_1", "step_2", "step_3"] as const) {
      nextStdout = `Source: /tmp/source-${step}\nManifest: /tmp/manifest\n`;
      const response = await POST(postRequest({ step }) as never);
      const events = await readEvents(response);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/x-ndjson",
      );
      expect(events.some((event) => event.type === "status")).toBe(true);
      expect(events.some((event) => event.type === "log")).toBe(true);
      expect(events.some((event) => event.type === "result" && event.ok)).toBe(
        true,
      );
      expect(
        events.some(
          (event) => event.type === "status" && event.status === "done",
        ),
      ).toBe(true);
    }

    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[0].command).toBe("bash");
    expect(spawnCalls[0].args[0]).toBe("-lc");
    expect(spawnCalls[0].args[1]).toContain("mamba activate 'TacFlow-main'");
    expect(spawnCalls[0].args[1]).toContain("'python' '-m' 'scan_dataset'");
    expect(spawnCalls[1].args[1]).toContain("scripts/repair_tactile.py");
    expect(spawnCalls[2].args[1]).toContain(
      "taccap-g1-fold-garment-0819-repair-tactile-0902",
    );
  });

  test("uses the selected dataset in step commands", async () => {
    const POST = await routePost();

    let response = await POST(
      postRequest({
        step: "step_1",
        datasetPath: OTHER_DATASET_RELATIVE,
      }) as never,
    );
    await readEvents(response);
    response = await POST(
      postRequest({
        step: "step_2",
        datasetPath: OTHER_DATASET_RELATIVE,
      }) as never,
    );
    await readEvents(response);

    expect(response.status).toBe(200);
    expect(spawnCalls[0].args[1]).toContain(OTHER_DATASET_RELATIVE);
    expect(spawnCalls[0].args[1]).toContain(
      "'--output' 'taccap-g1-hang-shirt-0903'",
    );
    expect(spawnCalls[1].args[1]).toContain(OTHER_DATASET_RELATIVE);
    expect(spawnCalls[1].args[1]).toContain(
      "taccap-g1-hang-shirt-0903-repair-tactile-0902",
    );
  });

  test("rejects invalid dataset paths", async () => {
    const POST = await routePost();
    const response = await POST(
      postRequest({ step: "step_1", datasetPath: "/tmp/outside" }) as never,
    );

    expect(response.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "datasetPath must be relative to the local dataset root.",
    });
  });

  test("reports stderr tail when the command exits non-zero", async () => {
    const POST = await routePost();
    nextExitCode = 2;
    nextStdout = "";
    nextStderr = "first warning\nlast failure\n";

    const response = await POST(postRequest({ step: "step_1" }) as never);
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
      error: "last failure",
    });
    expect(error).toMatchObject({ type: "error", error: "last failure" });
  });
});

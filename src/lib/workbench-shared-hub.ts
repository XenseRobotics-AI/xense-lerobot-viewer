"server-only";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import {
  PythonUnavailableError,
  pythonSpawnEnv,
  resolvePython,
} from "@/lib/python-runtime";
import { redactHfSecrets } from "@/lib/hf-identity";

const HUB_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LENGTH = 2_000_000;

export type WorkbenchSharedHubReadRequest = {
  action: "read";
  repoId: string;
  paths: string[];
};

export type WorkbenchSharedHubCommitFile = {
  path: string;
  content: string;
};

export type WorkbenchSharedHubCommitRequest = {
  action: "commit";
  repoId: string;
  expectedHead: string;
  message: string;
  files: WorkbenchSharedHubCommitFile[];
};

export type WorkbenchSharedHubRequest =
  | WorkbenchSharedHubReadRequest
  | WorkbenchSharedHubCommitRequest;

export type WorkbenchSharedHubReadResult = {
  action: "read";
  head: string;
  username: string | null;
  files: Record<string, unknown | null>;
};

export type WorkbenchSharedHubCommitResult = {
  action: "commit";
  commit: string;
  commitUrl: string | null;
  username: string | null;
};

export class WorkbenchSharedHubConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchSharedHubConflictError";
  }
}

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "workbench_hf_sync.py");
}

function parseResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore Python warnings or non-result lines.
    }
  }
  return null;
}

function safeMessage(value: unknown, token: string | null): string {
  const text = value instanceof Error ? value.message : String(value);
  return redactHfSecrets(text, [token ?? "", process.env.HF_TOKEN ?? ""]).slice(
    0,
    4_000,
  );
}

export async function runWorkbenchSharedHub(
  request: WorkbenchSharedHubRequest,
  token: string | null,
): Promise<WorkbenchSharedHubReadResult | WorkbenchSharedHubCommitResult> {
  let python;
  try {
    python = await resolvePython(["huggingface_hub"]);
  } catch (error: unknown) {
    throw new Error(
      error instanceof PythonUnavailableError ? error.message : String(error),
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...pythonSpawnEnv(),
    HF_ENDPOINT: "https://huggingface.co",
  };
  delete env.HF_TOKEN;
  if (token) env.XENSE_HF_TOKEN = token;

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(python.bin, [scriptPath()], {
        cwd: process.cwd(),
        env,
      });
    } catch (error: unknown) {
      reject(new Error(safeMessage(error, token)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error("Shared Hugging Face sync timed out after 60 seconds."),
        ),
      );
    }, HUB_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_LENGTH) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_LENGTH) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(() => reject(new Error(safeMessage(error, token))));
    });
    child.on("close", (code) => {
      const parsed = parseResult(stdout);
      finish(() => {
        if (parsed?.ok === true && parsed.result) {
          resolve(
            parsed.result as
              | WorkbenchSharedHubReadResult
              | WorkbenchSharedHubCommitResult,
          );
          return;
        }
        const errorCode =
          typeof parsed?.code === "string" ? parsed.code : "HF_SYNC_FAILED";
        const detail =
          typeof parsed?.error === "string"
            ? parsed.error
            : stderr.trim().split(/\r?\n/u).pop() ||
              "Hugging Face sync process exited with code " +
                String(code ?? "unknown") +
                ".";
        const message = safeMessage(detail, token);
        if (errorCode === "CONFLICT") {
          reject(new WorkbenchSharedHubConflictError(message));
          return;
        }
        reject(new Error(message));
      });
    });

    child.stdin.on("error", (error) => {
      finish(() => reject(new Error(safeMessage(error, token))));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

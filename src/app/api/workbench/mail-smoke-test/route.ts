import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/request-security";
import { pythonSpawnEnv } from "@/lib/python-runtime";
import {
  validateWorkbenchMailDraft,
  WORKBENCH_MAIL_SENDER,
  type WorkbenchMailDraft,
} from "@/lib/workbench-mail-draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SMTP_PASSWORD_FILE = "/tmp/qq_smtp_password";
const SCRIPT_TIMEOUT_MS = 45_000;
const MAX_ERROR_LENGTH = 2_000;

type MailScriptEvent = {
  type?: unknown;
  stage?: unknown;
  code?: unknown;
  error?: unknown;
  result?: unknown;
};

type MailScriptSuccess = {
  ok: true;
  message: string;
  result: Record<string, unknown>;
};

type MailScriptFailure = {
  ok: false;
  status: number;
  stage: string;
  code: string;
  error: string;
};

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRequestBody(
  value: unknown,
): { org: string; draft: WorkbenchMailDraft } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Expected a JSON object body." };
  }

  const raw = value as { org?: unknown; draft?: unknown };
  const org = cleanText(raw.org);
  if (!org) {
    return { error: "Workbench mail smoke test requires an organization." };
  }
  if (!raw.draft || typeof raw.draft !== "object" || Array.isArray(raw.draft)) {
    return { error: "Workbench mail smoke test requires a draft." };
  }

  const rawDraft = raw.draft as Record<string, unknown>;
  const recipient = cleanText(rawDraft.recipient);
  const subject = cleanText(rawDraft.subject);
  const body = typeof rawDraft.body === "string" ? rawDraft.body : "";
  const draft = {
    sender: WORKBENCH_MAIL_SENDER,
    recipient: recipient ?? "",
    subject: subject ?? "",
    body,
  };
  const validationError = validateWorkbenchMailDraft(draft);
  if (validationError) return { error: validationError };
  return { org, draft };
}

function scriptPath(): string {
  return path.join(
    process.cwd(),
    "scripts",
    "mail-smoke-test",
    "smtp_smoke_test.py",
  );
}

function pythonBin(): string {
  return process.env.PYTHON_BIN?.trim() || "python3";
}

function mailSpawnEnv(draft: WorkbenchMailDraft): NodeJS.ProcessEnv {
  const env = {
    ...pythonSpawnEnv(),
    SMTP_FROM_ADDRESS: WORKBENCH_MAIL_SENDER,
    SMTP_USERNAME: process.env.SMTP_USERNAME?.trim() || WORKBENCH_MAIL_SENDER,
    SMTP_TO_ADDRESS: draft.recipient,
    SMTP_SUBJECT: draft.subject,
    SMTP_BODY: draft.body,
  } as NodeJS.ProcessEnv;

  if (!env.SMTP_PASSWORD?.trim() && !env.SMTP_PASSWORD_FILE?.trim()) {
    env.SMTP_PASSWORD_FILE = DEFAULT_SMTP_PASSWORD_FILE;
  }

  return env;
}

function safeMailError(value: unknown, env?: NodeJS.ProcessEnv): string {
  let text = value instanceof Error ? value.message : String(value);
  const secrets = [env?.SMTP_PASSWORD, process.env.SMTP_PASSWORD].filter(
    (secret): secret is string => Boolean(secret?.trim()),
  );
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
  }
  const trimmed = text.trim() || "SMTP smoke test failed.";
  return trimmed.length > MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_LENGTH)}...`
    : trimmed;
}

function statusForScriptStage(stage: string): number {
  if (stage === "config") return 500;
  if (stage === "timeout") return 504;
  if (stage === "spawn" || stage === "script") return 502;
  if (stage === "auth" || stage === "connect" || stage === "send") return 502;
  return 500;
}

function scriptFailure(
  stage: string,
  code: string,
  error: unknown,
  env?: NodeJS.ProcessEnv,
): MailScriptFailure {
  return {
    ok: false,
    status: statusForScriptStage(stage),
    stage,
    code,
    error: safeMailError(error, env),
  };
}

function parseScriptOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  env: NodeJS.ProcessEnv,
): MailScriptSuccess | MailScriptFailure {
  let malformedLine: string | null = null;

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: MailScriptEvent;
    try {
      event = JSON.parse(trimmed) as MailScriptEvent;
    } catch {
      malformedLine = trimmed;
      continue;
    }

    if (event.type === "result") {
      const result =
        event.result && typeof event.result === "object"
          ? (event.result as Record<string, unknown>)
          : {};
      const message =
        typeof result.message === "string" && result.message.trim()
          ? result.message
          : "SMTP smoke test sent.";
      return { ok: true, message, result };
    }

    if (event.type === "error") {
      const stage = typeof event.stage === "string" ? event.stage : "script";
      const code =
        typeof event.code === "string" ? event.code : "smtp_script_error";
      const error = event.error ?? "SMTP smoke test failed.";
      return scriptFailure(stage, code, error, env);
    }
  }

  if (malformedLine) {
    return scriptFailure(
      "script",
      "SMTP_OUTPUT_INVALID",
      `SMTP smoke test produced malformed output: ${malformedLine}`,
      env,
    );
  }

  const stderrTail = stderr.trim().split(/\r?\n/u).filter(Boolean).pop();
  return scriptFailure(
    "script",
    "SMTP_NO_RESULT",
    stderrTail || `SMTP smoke test exited without a result (exit ${exitCode}).`,
    env,
  );
}

function runMailScript(
  draft: WorkbenchMailDraft,
): Promise<MailScriptSuccess | MailScriptFailure> {
  const env = mailSpawnEnv(draft);
  const py = pythonBin();

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(py, [scriptPath()], {
        cwd: process.cwd(),
        env,
      });
    } catch (error: unknown) {
      resolve(
        scriptFailure(
          "spawn",
          "SMTP_SCRIPT_LAUNCH_FAILED",
          `Failed to launch ${py}: ${safeMailError(error, env)}`,
          env,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let closed = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeout = setTimeout(() => {
      if (settled) return;
      if (!closed) {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 5_000);
        forceKillTimer.unref?.();
      }
      settled = true;
      resolve(
        scriptFailure(
          "timeout",
          "SMTP_SCRIPT_TIMEOUT",
          `SMTP smoke test exceeded ${SCRIPT_TIMEOUT_MS / 1_000} seconds.`,
          env,
        ),
      );
    }, SCRIPT_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(
        scriptFailure(
          "spawn",
          "SMTP_SCRIPT_LAUNCH_FAILED",
          `Failed to launch ${py}: ${error.message}`,
          env,
        ),
      );
    });
    child.on("close", (code) => {
      closed = true;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(parseScriptOutput(stdout, stderr, code, env));
    });
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      {
        error: "Cross-origin mail smoke tests are not allowed.",
        stage: "request",
        code: "ORIGIN_REJECTED",
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const normalized = normalizeRequestBody(body);
  if ("error" in normalized) {
    return Response.json({ error: normalized.error }, { status: 400 });
  }

  const result = await runMailScript(normalized.draft);
  if (result.ok) {
    return Response.json({
      message: result.message,
      result: result.result,
    });
  }

  return Response.json(
    {
      error: result.error,
      stage: result.stage,
      code: result.code,
    },
    { status: result.status },
  );
}

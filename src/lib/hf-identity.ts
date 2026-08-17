import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import {
  PythonUnavailableError,
  pythonSpawnEnv,
  resolvePython,
  type ResolvedPython,
} from "@/lib/python-runtime";

export const HF_DEFAULT_ENDPOINT = "https://hf-mirror.com";
const IDENTITY_TIMEOUT_MS = 30_000;

export type HfIdentityResult = {
  endpoint: string;
  tokenPresent: boolean;
  tokenValid: boolean | null;
  username: string | null;
  visibleDatasets: number | null;
  identityError?: string;
  listingError?: string;
};

export class HfIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HfIdentityError";
  }
}

export function redactHfSecrets(
  message: string,
  secrets: readonly string[],
): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "hf_identity.py");
}

function parseJsonLines(stdout: string): HfIdentityResult | null {
  let result: HfIdentityResult | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        result?: HfIdentityResult;
      };
      if (event.type === "result" && event.result) result = event.result;
    } catch {
      // Ignore Python warnings/noise; the final result event is authoritative.
    }
  }
  return result;
}

export function parseHfIdentityOutput(stdout: string): HfIdentityResult | null {
  return parseJsonLines(stdout);
}

function spawnIdentity(
  python: ResolvedPython,
  org: string,
  token: string | null,
  whoamiOnly: boolean,
): ChildProcessWithoutNullStreams {
  const env = pythonSpawnEnv();
  env.HF_ENDPOINT = process.env.HF_ENDPOINT?.trim() || HF_DEFAULT_ENDPOINT;
  // Do not put secrets in argv. When token is null, leave HF_TOKEN untouched so
  // huggingface_hub can use the normal CLI cache or an inherited environment.
  if (token) env.HF_TOKEN = token;
  const args = [scriptPath(), "--org", org];
  if (whoamiOnly) args.push("--whoami-only");
  return spawn(python.bin, args, {
    cwd: process.cwd(),
    env,
  });
}

export async function runHfIdentity(options: {
  org: string;
  token?: string | null;
  whoamiOnly?: boolean;
  timeoutMs?: number;
}): Promise<HfIdentityResult> {
  let python: ResolvedPython;
  try {
    python = await resolvePython(["huggingface_hub"]);
  } catch (err) {
    throw new HfIdentityError(
      err instanceof PythonUnavailableError
        ? err.message
        : `Failed to resolve Python: ${String(err)}`,
    );
  }

  const timeoutMs = options.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnIdentity(
        python,
        options.org,
        options.token ?? null,
        options.whoamiOnly === true,
      );
    } catch (err) {
      reject(new HfIdentityError(`Failed to launch Python: ${String(err)}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new HfIdentityError(
            `Identity check timed out after ${timeoutMs / 1000}s.`,
          ),
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) =>
      finish(() =>
        reject(
          new HfIdentityError(
            `Failed to launch ${python.bin}: ${err.message}. Is Python installed?`,
          ),
        ),
      ),
    );
    child.on("close", (code) => {
      const result = parseJsonLines(stdout);
      finish(() => {
        if (result) {
          resolve(result);
          return;
        }
        const detail =
          stderr.trim().split(/\r?\n/u).pop() || "No identity result.";
        reject(
          new HfIdentityError(redactHfSecrets(detail, [options.token ?? ""])),
        );
        // A non-zero code is intentionally not surfaced separately: the human
        // diagnostic above is more useful than a duplicate exit-code message.
        void code;
      });
    });
  });
}

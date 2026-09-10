import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { normalizeHfEndpoint } from "@/lib/hf-endpoints";
import { resolveHfToken } from "@/lib/hf-token-store";
import { addHfMirrorProxyBypass } from "@/lib/proxy-bypass";
import {
  PythonUnavailableError,
  pythonSpawnEnv,
  resolvePython,
} from "@/lib/python-runtime";
import { normalizeHfToken } from "@/utils/hfValidation";
import type {
  HfDownloadCheck,
  HfDownloadRequest,
  HfDownloadScope,
} from "@/types/hf-download.types";

const SOURCE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;
const CHECK_TIMEOUT_MS = 120_000;

export type ParsedHfDownloadRequest = Omit<HfDownloadRequest, "token"> & {
  token: string | null;
};

export function defaultHfDownloadRoot(): string {
  return path.resolve(resolveLocalDatasetRoot());
}
export function hfDownloadTargetKey(
  request: Pick<ParsedHfDownloadRequest, "destinationRoot" | "source">,
): string {
  return path.resolve(request.destinationRoot, ...request.source.split("/"));
}

export function redactHfDownloadError(
  message: string,
  token: string | null,
): string {
  return token ? message.split(token).join("[REDACTED]") : message;
}

export async function parseHfDownloadRequest(
  body: unknown,
): Promise<ParsedHfDownloadRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Expected a JSON object.");
  }
  const value = body as Record<string, unknown>;
  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (!SOURCE.test(source) || source.includes("\\") || source.includes("://")) {
    throw new TypeError(
      "`source` must be a safe Hugging Face path with two or three segments.",
    );
  }
  const destinationRoot =
    typeof value.destinationRoot === "string"
      ? value.destinationRoot.trim()
      : "";
  if (!destinationRoot || destinationRoot.includes("\0")) {
    throw new TypeError("`destinationRoot` must be a non-empty path.");
  }
  const scope = value.scope;
  if (scope !== "all" && scope !== "meta") {
    throw new TypeError("`scope` must be `all` or `meta`.");
  }
  const endpoint = normalizeHfEndpoint(value.endpoint);
  if (!endpoint) {
    throw new TypeError(
      "`endpoint` must be https://hf-mirror.com or https://huggingface.co.",
    );
  }
  let token: string | null = null;
  if (value.token !== undefined) {
    token = normalizeHfToken(value.token);
    if (!token)
      throw new TypeError("`token` must be a non-empty Hugging Face token.");
  }
  if (!token) {
    try {
      token = (await resolveHfToken(resolveLocalDatasetRoot())).token;
    } catch {
      token = null;
    }
  }
  return {
    source,
    destinationRoot,
    scope: scope as HfDownloadScope,
    endpoint,
    token,
  };
}

export async function hfDownloadPython(): Promise<string> {
  try {
    return (await resolvePython(["huggingface_hub"])).bin;
  } catch (error) {
    throw new Error(
      error instanceof PythonUnavailableError ? error.message : String(error),
    );
  }
}

export function spawnHfDownload(
  python: string,
  request: ParsedHfDownloadRequest & {
    action: "check" | "download";
    revisionSha?: string;
  },
): ChildProcessWithoutNullStreams {
  const env = addHfMirrorProxyBypass(
    {
      ...pythonSpawnEnv(),
      HF_ENDPOINT: request.endpoint,
      ...(request.token ? { XENSE_HF_TOKEN: request.token } : {}),
    } as NodeJS.ProcessEnv,
    request.endpoint,
  );
  const child = spawn(
    python,
    [path.join(process.cwd(), "scripts", "hf_download.py")],
    {
      cwd: process.cwd(),
      env,
    },
  );
  const publicRequest = { ...request } as Record<string, unknown>;
  delete publicRequest.token;
  child.stdin.end(JSON.stringify(publicRequest));
  return child;
}

export async function runHfDownloadCheck(
  request: ParsedHfDownloadRequest,
): Promise<HfDownloadCheck> {
  const python = await hfDownloadPython();
  return new Promise((resolve, reject) => {
    const child = spawnHfDownload(python, { ...request, action: "check" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: HfDownloadCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Download check returned no result."));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Download check timed out."));
    }, CHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => finish(error));
    child.on("close", () => {
      let error: string | null = null;
      let result: HfDownloadCheck | undefined;
      for (const line of stdout.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            ok?: boolean;
            result?: HfDownloadCheck;
            error?: string;
          };
          if (event.ok && event.result) result = event.result;
          if (event.error) error = event.error;
        } catch {
          // The final structured event is authoritative.
        }
      }
      finish(
        error || !result
          ? new Error(
              redactHfDownloadError(
                error || stderr.trim() || "Download check failed.",
                request.token,
              ),
            )
          : undefined,
        result,
      );
    });
  });
}

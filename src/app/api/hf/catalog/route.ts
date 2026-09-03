import { NextRequest } from "next/server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  normalizeHfEndpoint,
  resolveHfCatalogEndpoint,
} from "@/lib/hf-endpoints";
import {
  PythonUnavailableError,
  pythonSpawnEnv,
  resolvePython,
  type ResolvedPython,
} from "@/lib/python-runtime";
import {
  hfCatalogCachePath,
  mergeWorkbenchHistory,
  type HfCatalogDocument,
} from "@/lib/hf-catalog-cache";
import { resolveHfToken } from "@/lib/hf-token-store";
import { redactHfSecrets } from "@/lib/hf-identity";
import { addHfMirrorProxyBypass } from "@/lib/proxy-bypass";
import { isSameOriginRequest } from "@/lib/request-security";
import { normalizeHfSource, normalizeHfToken } from "@/utils/hfValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATALOG_ENDPOINT = resolveHfCatalogEndpoint();
const CATALOG_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ERROR_LENGTH = 4_000;

function safeCatalogError(value: unknown, secrets: readonly string[]): string {
  const raw = value instanceof Error ? value.message : String(value);
  const redacted = redactHfSecrets(raw, secrets);
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "hf_catalog.py");
}

function spawnCatalog(
  python: ResolvedPython,
  org: string,
  root: string,
  cache: string,
  endpoint: string,
  force: boolean,
  token: string | null,
): ChildProcessWithoutNullStreams {
  const env = addHfMirrorProxyBypass(
    {
      ...pythonSpawnEnv(),
      HF_ENDPOINT: endpoint,
    } as NodeJS.ProcessEnv,
    endpoint,
  );
  if (token) env.HF_TOKEN = token;
  const args = [scriptPath(), "--org", org, "--root", root, "--cache", cache];
  if (force) args.push("--force");
  return spawn(python.bin, args, { cwd: process.cwd(), env });
}

export async function GET(request: NextRequest): Promise<Response> {
  const org = normalizeHfSource(request.nextUrl.searchParams.get("org"));
  if (!org) return Response.json({ error: "Invalid org." }, { status: 400 });
  try {
    const root = resolveLocalDatasetRoot();
    const file = hfCatalogCachePath(root, org);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as HfCatalogDocument;
    const catalog = await mergeWorkbenchHistory(parsed, org);
    return Response.json(catalog, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return Response.json(
        { org, refreshedAt: null, datasets: [], failures: [], cached: false },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to read catalog.",
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }
  let body: {
    org?: unknown;
    force?: unknown;
    endpoint?: unknown;
    token?: unknown;
  } = {};
  try {
    const value = await request.json();
    if (value && typeof value === "object") body = value as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const org = normalizeHfSource(body.org);
  if (!org) return Response.json({ error: "Invalid org." }, { status: 400 });

  let endpoint = CATALOG_ENDPOINT;
  if (body.endpoint !== undefined) {
    const selectedEndpoint = normalizeHfEndpoint(body.endpoint);
    if (!selectedEndpoint) {
      return Response.json(
        {
          error:
            "`endpoint` must be https://hf-mirror.com or https://huggingface.co.",
        },
        { status: 400 },
      );
    }
    endpoint = selectedEndpoint;
  }
  let requestedToken: string | null = null;
  if (body.token !== undefined) {
    requestedToken = normalizeHfToken(body.token);
    if (!requestedToken) {
      return Response.json(
        { error: "`token` must be a non-empty Hugging Face token." },
        { status: 400 },
      );
    }
  }

  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (error: unknown) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
  let credentials: { token: string | null };
  try {
    credentials = {
      token: requestedToken ?? (await resolveHfToken(root)).token,
    };
  } catch {
    credentials = { token: null };
  }
  let python: ResolvedPython;
  try {
    python = await resolvePython(["huggingface_hub"]);
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof PythonUnavailableError
            ? error.message
            : String(error),
      },
      { status: 502 },
    );
  }

  const cache = hfCatalogCachePath(root, org);
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const secretValues = [
          credentials.token ?? "",
          process.env.HF_TOKEN ?? "",
        ];
        let closed = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const send = (value: unknown) => {
          if (closed) return;
          try {
            const serialized = JSON.stringify(value);
            controller.enqueue(
              encoder.encode(`${redactHfSecrets(serialized, secretValues)}\n`),
            );
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        try {
          activeChild = spawnCatalog(
            python,
            org,
            root,
            cache,
            endpoint,
            body.force === true,
            credentials.token,
          );
        } catch (error: unknown) {
          send({
            type: "error",
            error: safeCatalogError(error, secretValues),
          });
          close();
          return;
        }
        const child = activeChild;
        if (!child) {
          send({ type: "error", error: "Catalog process was not created." });
          close();
          return;
        }
        let buffer = "";
        let stderr = "";
        let sentError = false;
        const armIdleTimeout = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (closed) return;
            sentError = true;
            send({
              type: "error",
              error: `统计进程超过 ${CATALOG_IDLE_TIMEOUT_MS / 60_000} 分钟没有进展，已终止。`,
            });
            if (!child.killed) child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              if (!child.killed) child.kill("SIGKILL");
            }, 5_000);
          }, CATALOG_IDLE_TIMEOUT_MS);
        };
        armIdleTimeout();
        child.stdout.on("data", (chunk) => {
          armIdleTimeout();
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.type === "error") sentError = true;
              if (typeof event.error === "string") {
                event.error = safeCatalogError(event.error, secretValues);
              }
              send(event);
            } catch {
              /* ignore noise */
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          armIdleTimeout();
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          send({
            type: "error",
            error: safeCatalogError(
              `Catalog process failed: ${error.message}`,
              secretValues,
            ),
          });
          close();
        });
        child.on("close", (code) => {
          if (buffer.trim()) {
            try {
              send(JSON.parse(buffer));
            } catch {
              /* ignore */
            }
          }
          if (code !== 0 && !sentError) {
            send({
              type: "error",
              error: safeCatalogError(
                stderr.trim().split(/\r?\n/u).pop() ||
                  `Catalog exited with code ${code}.`,
                secretValues,
              ),
            });
          }
          activeChild = null;
          close();
        });
      },
      cancel() {
        if (activeChild && !activeChild.killed) {
          activeChild.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (activeChild && !activeChild.killed) activeChild.kill("SIGKILL");
          }, 5_000);
        }
      },
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
      },
    },
  );
}

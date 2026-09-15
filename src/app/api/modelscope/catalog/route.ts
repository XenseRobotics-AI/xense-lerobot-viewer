import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readDatasetXumiDeviceInfo,
  resolveLocalDatasetRoot,
} from "@/lib/local-datasets-discovery";
import {
  modelscopeCatalogCachePath,
  type ModelScopeCatalogDocument,
} from "@/lib/modelscope-catalog-cache";
import { resolveModelScopeToken } from "@/lib/modelscope-token-store";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import { HF_REPO_NAME_PATTERN } from "@/utils/hfValidation";
import {
  resolveModelScopeTarget,
  type ModelScopeDatasetTarget,
} from "@/utils/modelscopeValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODELSCOPE_ENDPOINT = "https://modelscope.cn";
// ModelScope OpenAPI rejects page_size values above 50.
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKEN_LENGTH = 4096;

type ModelScopeDataset = {
  id?: unknown;
  file_size?: unknown;
  downloads?: unknown;
  created_at?: unknown;
  last_modified?: unknown;
};

type ModelScopeListResponse = {
  success?: unknown;
  data?: {
    datasets?: unknown;
    total_count?: unknown;
  };
};

type ModelScopeTreeFile = {
  Name?: unknown;
  Type?: unknown;
  Path?: unknown;
  Revision?: unknown;
  CommittedDate?: unknown;
};

type ModelScopeTreeResponse = {
  Code?: unknown;
  Message?: unknown;
  Data?: {
    Files?: unknown;
    TotalCount?: unknown;
  };
  TotalCount?: unknown;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerIfWhole(value: number | null): number | null {
  return value === null ? null : Number.isInteger(value) ? value : value;
}

function safeError(value: unknown, token: string | null): string {
  const message = value instanceof Error ? value.message : String(value);
  return token ? message.split(token).join("[REDACTED]") : message;
}

function resolveUrl(target: ModelScopeDatasetTarget, filename: string): string {
  const encoded = target.repoId.split("/").map(encodeURIComponent).join("/");
  const encodedFile = filename.split("/").map(encodeURIComponent).join("/");
  return `${MODELSCOPE_ENDPOINT}/api/v1/datasets/${encoded}/repo?Revision=master&FilePath=${encodedFile}`;
}

function validNestedDatasetPath(value: string): boolean {
  const segments = value.split("/").filter(Boolean);
  return (
    segments.length > 0 &&
    segments.join("/") === value &&
    segments.every((segment) => HF_REPO_NAME_PATTERN.test(segment))
  );
}

function authHeaders(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(
  url: string,
  token: string | null,
  requestSignal?: AbortSignal,
): Promise<unknown> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, timeout.signal])
    : timeout.signal;
  try {
    const response = await fetch(url, {
      headers: authHeaders(token),
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      const suffix = detail
        ? `: ${detail.replace(/\s+/gu, " ").slice(0, 240)}`
        : "";
      throw new Error(
        `ModelScope request failed (${response.status})${suffix}.`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function infoFields(info: Record<string, unknown>): Record<string, unknown> {
  const number = (key: string): number | null => nonNegativeNumber(info[key]);
  const frames = number("total_frames");
  const episodes = number("total_episodes");
  const tasks = number("total_tasks");
  const fps = number("fps");
  const durationHours =
    frames !== null && fps !== null && frames > 0 && fps > 0
      ? frames / fps / 3600
      : null;
  const robotType = stringOrNull(info.robot_type);
  return {
    totalEpisodes: integerIfWhole(episodes),
    totalFrames: integerIfWhole(frames),
    totalTasks: integerIfWhole(tasks),
    fps,
    durationHours:
      durationHours === null
        ? null
        : Math.round(durationHours * 1_000_000) / 1_000_000,
    robotType,
  };
}

function baseEntry(
  item: ModelScopeDataset,
  target: ModelScopeDatasetTarget,
  datasetPath: string,
  treeFile: ModelScopeTreeFile,
): Record<string, unknown> {
  const repoId = `${target.logicalOrg}/${datasetPath}`;
  const committedDate =
    typeof treeFile.CommittedDate === "number" &&
    Number.isFinite(treeFile.CommittedDate)
      ? new Date(treeFile.CommittedDate * 1000).toISOString()
      : null;
  return {
    repoId,
    org: target.logicalOrg,
    name: datasetPath,
    hubRepoId: target.repoId,
    hubPath: datasetPath,
    layout: "dataset",
    children: [],
    localState: "missing",
    totalEpisodes: null,
    totalFrames: null,
    totalTasks: null,
    fps: null,
    durationHours: null,
    robotType: null,
    sha: stringOrNull(treeFile.Revision),
    createdAt: committedDate ?? stringOrNull(item.created_at),
    lastModified: committedDate ?? stringOrNull(item.last_modified),
    // ModelScope reports downloads and size for the containing repository, not
    // for each nested LeRobot dataset. Repeating those values would inflate the
    // Workbench totals, so nested entries leave them unavailable.
    downloads: null,
    storageBytes: null,
  };
}

async function catalogEntry(
  item: ModelScopeDataset,
  target: ModelScopeDatasetTarget,
  datasetPath: string,
  treeFile: ModelScopeTreeFile,
  token: string | null,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  if (!validNestedDatasetPath(datasetPath)) {
    throw new Error("ModelScope returned an invalid nested dataset path.");
  }
  const base = baseEntry(item, target, datasetPath, treeFile);
  try {
    const payload = await fetchJson(
      resolveUrl(target, `${datasetPath}/meta/info.json`),
      token,
      signal,
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("meta/info.json must contain a JSON object.");
    }
    let deviceFields: ReturnType<typeof readDatasetXumiDeviceInfo> = {
      collectorSerialNumber: null,
      robotId: null,
      leftGripperSn: null,
    };
    try {
      const devicePayload = await fetchJson(
        resolveUrl(target, `${datasetPath}/meta/xumi_collection_devices.json`),
        token,
        signal,
      );
      if (
        !devicePayload ||
        typeof devicePayload !== "object" ||
        Array.isArray(devicePayload)
      ) {
        throw new Error(
          "meta/xumi_collection_devices.json must contain a JSON object.",
        );
      }
      deviceFields = readDatasetXumiDeviceInfo(devicePayload);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      // Device metadata is optional for older datasets.
    }
    return {
      ...base,
      ...infoFields(payload as Record<string, unknown>),
      ...deviceFields,
      metadataState: "ok",
    };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return {
      ...base,
      metadataState: "error",
      metadataError: safeError(error, token),
    };
  }
}

async function listDatasets(
  owner: string,
  token: string | null,
  signal: AbortSignal | undefined,
  onProgress: (progress: Record<string, unknown>) => void,
): Promise<ModelScopeDataset[]> {
  const output: ModelScopeDataset[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  for (;;) {
    const url = new URL(`${MODELSCOPE_ENDPOINT}/openapi/v1/datasets`);
    url.searchParams.set("owner", owner);
    url.searchParams.set("page_number", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    url.searchParams.set("sort", "last_modified");
    const payload = (await fetchJson(
      url.toString(),
      token,
      signal,
    )) as ModelScopeListResponse | null;
    if (!payload?.data || payload.success === false) {
      throw new Error("ModelScope returned an invalid dataset list.");
    }
    const items = Array.isArray(payload.data.datasets)
      ? payload.data.datasets.filter(
          (item): item is ModelScopeDataset =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    total = nonNegativeNumber(payload.data.total_count) ?? output.length;
    output.push(...items);
    onProgress({
      phase: "catalog",
      index: output.length,
      total,
      percent: total
        ? Math.min(100, Math.round((output.length / total) * 100))
        : 100,
    });
    if (
      items.length === 0 ||
      output.length >= total ||
      items.length < PAGE_SIZE
    ) {
      return output;
    }
    page += 1;
  }
}

function treeFilePath(file: ModelScopeTreeFile): string | null {
  return stringOrNull(file.Path);
}

function treeFileType(file: ModelScopeTreeFile): string | null {
  return stringOrNull(file.Type)?.toLowerCase() ?? null;
}

async function listTree(
  target: ModelScopeDatasetTarget,
  rootPath: string,
  token: string | null,
  signal: AbortSignal | undefined,
): Promise<ModelScopeTreeFile[]> {
  const output: ModelScopeTreeFile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  for (;;) {
    const url = new URL(
      `${MODELSCOPE_ENDPOINT}/api/v1/datasets/${target.repoId
        .split("/")
        .map(encodeURIComponent)
        .join("/")}/repo/tree`,
    );
    url.searchParams.set("Root", rootPath);
    url.searchParams.set("PageNumber", String(page));
    url.searchParams.set("PageSize", String(PAGE_SIZE));
    url.searchParams.set("Revision", "master");
    const payload = (await fetchJson(
      url.toString(),
      token,
      signal,
    )) as ModelScopeTreeResponse | null;
    if (
      !payload ||
      payload.Code !== 200 ||
      !payload.Data ||
      !Array.isArray(payload.Data.Files)
    ) {
      throw new Error(
        stringOrNull(payload?.Message) ||
          "ModelScope returned an invalid repository tree.",
      );
    }
    const files = payload.Data.Files.filter(
      (file): file is ModelScopeTreeFile =>
        Boolean(file) && typeof file === "object" && !Array.isArray(file),
    );
    total =
      nonNegativeNumber(payload.Data.TotalCount) ??
      nonNegativeNumber(payload.TotalCount) ??
      output.length;
    output.push(...files);
    if (
      files.length === 0 ||
      output.length >= total ||
      files.length < PAGE_SIZE
    ) {
      return output;
    }
    page += 1;
  }
}

async function discoverNestedDatasets(
  target: ModelScopeDatasetTarget,
  token: string | null,
  signal: AbortSignal | undefined,
  onProgress: (progress: Record<string, unknown>) => void,
): Promise<Array<{ path: string; treeFile: ModelScopeTreeFile }>> {
  const pending = [""];
  const visited = new Set<string>();
  const datasets = new Map<string, ModelScopeTreeFile>();
  while (pending.length > 0) {
    const rootPath = pending.shift() ?? "";
    if (visited.has(rootPath)) continue;
    visited.add(rootPath);
    const files = await listTree(target, rootPath, token, signal);
    for (const file of files) {
      const filePath = treeFilePath(file);
      if (!filePath) continue;
      const type = treeFileType(file);
      if (type !== "tree") continue;
      const segments = filePath.split("/").filter(Boolean);
      const name = segments.at(-1) ?? "";
      if (name === "meta" && segments.length > 1) {
        const datasetPath = segments.slice(0, -1).join("/");
        if (validNestedDatasetPath(datasetPath)) {
          datasets.set(datasetPath, file);
        }
        continue;
      }
      if (name === "data" || name === "videos" || name === ".git") continue;
      pending.push(filePath);
    }
    onProgress({
      phase: "tree",
      index: visited.size,
      total: visited.size + pending.length,
      percent: pending.length
        ? Math.round((visited.size / (visited.size + pending.length)) * 100)
        : 100,
    });
  }
  return [...datasets.entries()]
    .map(([path, treeFile]) => ({ path, treeFile }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function buildCatalog(
  target: ModelScopeDatasetTarget,
  root: string,
  token: string | null,
  signal: AbortSignal | undefined,
  onProgress: (progress: Record<string, unknown>) => void,
): Promise<ModelScopeCatalogDocument> {
  const repos = await listDatasets(target.owner, token, signal, onProgress);
  const containingRepo = repos.find(
    (item) => stringOrNull(item.id) === target.repoId,
  ) ?? {
    id: target.repoId,
  };
  const nestedDatasets = await discoverNestedDatasets(
    target,
    token,
    signal,
    onProgress,
  );
  const entries: Record<string, unknown>[] = [];
  const failures: Array<{ repoId: string; error: string }> = [];
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= nestedDatasets.length) return;
      const dataset = nestedDatasets[index];
      const repoId = `${target.logicalOrg}/${dataset.path}`;
      onProgress({
        phase: "metadata",
        index: index + 1,
        total: nestedDatasets.length,
        repoId,
      });
      try {
        const entry = await catalogEntry(
          containingRepo,
          target,
          dataset.path,
          dataset.treeFile,
          token,
          signal,
        );
        const localDir = path.join(root, ...repoId.split("/"));
        entry.localState = await fs
          .stat(path.join(localDir, "meta", "info.json"))
          .then(() => "downloaded")
          .catch(() => "missing");
        entries[index] = entry;
        if (entry.metadataState === "error") {
          failures.push({
            repoId,
            error: String(entry.metadataError ?? "Metadata unavailable"),
          });
        }
      } catch (error: unknown) {
        if (signal?.aborted) throw error;
        const message = safeError(error, token);
        failures.push({ repoId, error: message });
        entries[index] = {
          ...baseEntry(containingRepo, target, dataset.path, dataset.treeFile),
          metadataState: "error",
          metadataError: message,
        };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(8, Math.max(1, nestedDatasets.length)) },
      worker,
    ),
  );
  return {
    catalogVersion: 1,
    org: target.logicalOrg,
    hubRepoId: target.repoId,
    refreshedAt: new Date().toISOString(),
    datasets: entries.filter(Boolean),
    failures,
  };
}

function bodyToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const target = resolveModelScopeTarget(
    request.nextUrl.searchParams.get("org"),
  );
  if (!target)
    return Response.json(
      { error: "Invalid ModelScope repository." },
      { status: 400 },
    );
  try {
    const root = resolveLocalDatasetRoot();
    const raw = await fs.readFile(
      modelscopeCatalogCachePath(root, target.logicalOrg),
      "utf8",
    );
    return Response.json(JSON.parse(raw) as ModelScopeCatalogDocument, {
      headers: noStoreHeaders(),
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return Response.json(
        {
          org: target.logicalOrg,
          hubRepoId: target.repoId,
          refreshedAt: null,
          datasets: [],
          failures: [],
          cached: false,
        },
        { headers: noStoreHeaders() },
      );
    }
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to read catalog.",
      },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403, headers: noStoreHeaders() },
    );
  }
  let body: { org?: unknown; token?: unknown } = {};
  try {
    const value = await request.json();
    if (value && typeof value === "object") body = value as typeof body;
  } catch {
    return Response.json(
      { error: "Expected a JSON body." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  const target = resolveModelScopeTarget(body.org);
  if (!target) {
    return Response.json(
      { error: "Invalid ModelScope repository." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  if (body.token !== undefined && !bodyToken(body.token)) {
    return Response.json(
      { error: "`token` must be a non-empty ModelScope token." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  const requestedToken =
    body.token === undefined ? null : bodyToken(body.token);
  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (error: unknown) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: noStoreHeaders() },
    );
  }
  const token = requestedToken ?? (await resolveModelScopeToken(root)).token;

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (value: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          } catch {
            // The browser may have cancelled the stream.
          }
        };
        try {
          const catalog = await buildCatalog(
            target,
            root,
            token,
            request.signal,
            (progress) => send({ type: "progress", progress }),
          );
          const cache = modelscopeCatalogCachePath(root, target.logicalOrg);
          await fs.mkdir(path.dirname(cache), { recursive: true });
          const temporary = `${cache}.${process.pid}.${Date.now()}.tmp`;
          await fs.writeFile(
            temporary,
            JSON.stringify(catalog, null, 2) + "\n",
            "utf8",
          );
          await fs.rename(temporary, cache);
          send({ type: "result", result: catalog });
        } catch (error: unknown) {
          send({
            type: "error",
            error: safeError(error, token),
          });
        } finally {
          try {
            controller.close();
          } catch {
            // The browser may have cancelled the stream.
          }
        }
      },
    }),
    { headers: noStoreHeaders("application/x-ndjson; charset=utf-8") },
  );
}

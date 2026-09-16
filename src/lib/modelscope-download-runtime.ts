import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { resolveModelScopeToken } from "@/lib/modelscope-token-store";
import { HF_REPO_NAME_PATTERN } from "@/utils/hfValidation";
import {
  normalizeModelScopeRepo,
  resolveModelScopeTarget,
  type ModelScopeDatasetTarget,
} from "@/utils/modelscopeValidation";
import type {
  ModelScopeDownloadCheck,
  ModelScopeDownloadProgress,
  ModelScopeDownloadRequest,
  ModelScopeDownloadResult,
  ModelScopeDownloadScope,
  ModelScopeDownloadStreamEvent,
} from "@/types/modelscope-download.types";

const MODELSCOPE_ENDPOINT = "https://modelscope.cn";
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_TOKEN_LENGTH = 4096;
const CONTROL_DIR = ".xense-viewer";
const STAGING_DIR = "modelscope-download-staging";
const BACKUP_DIR = "modelscope-download-backups";
const STATE_DIR = "modelscope-download-state";
const PROGRESS_REPORT_INTERVAL_MS = 500;

export const DEFAULT_MODELSCOPE_DOWNLOAD_CONCURRENCY = 4;
export const MAX_MODELSCOPE_DOWNLOAD_CONCURRENCY = 8;

type ModelScopeTreeFile = {
  Name?: unknown;
  Type?: unknown;
  Path?: unknown;
  Revision?: unknown;
  Size?: unknown;
  Sha256?: unknown;
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

type SelectedModelScopeFile = {
  remotePath: string;
  localPath: string;
  size: number | null;
  revision: string | null;
  sha256: string | null;
};

export type ParsedModelScopeDownloadRequest = Omit<
  ModelScopeDownloadRequest,
  "concurrency" | "token"
> & {
  concurrency: number;
  token: string | null;
  target: ModelScopeDatasetTarget;
  sourceParts: string[];
  repoPath: string;
  destinationRoot: string;
};

export class ModelScopeDownloadConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelScopeDownloadConflict";
  }
}

export class ModelScopeDownloadCancelled extends Error {
  constructor(message = "Download cancelled.") {
    super(message);
    this.name = "ModelScopeDownloadCancelled";
  }
}

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

function integerSize(value: unknown): number | null {
  const parsed = nonNegativeNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function authHeaders(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function redact(value: unknown, token: string | null): string {
  const message = value instanceof Error ? value.message : String(value);
  return token ? message.split(token).join("[REDACTED]") : message;
}

export function redactModelScopeDownloadError(
  value: unknown,
  token: string | null,
): string {
  return redact(value, token);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModelScopeDownloadCancelled();
}

function timeoutSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const combined = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;
  return {
    signal: combined,
    cleanup: () => clearTimeout(timer),
  };
}

async function fetchModelScope(
  url: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const timed = timeoutSignal(signal);
  try {
    const response = await fetch(url, {
      headers: authHeaders(token),
      signal: timed.signal,
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
    return response;
  } catch (error: unknown) {
    if (signal?.aborted || timed.signal.aborted) {
      throw new ModelScopeDownloadCancelled();
    }
    throw error;
  } finally {
    timed.cleanup();
  }
}

async function fetchJson(
  url: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  return await (await fetchModelScope(url, token, signal)).json();
}

function encodedRepo(target: ModelScopeDatasetTarget): string {
  return target.repoId.split("/").map(encodeURIComponent).join("/");
}

function fileUrl(
  target: ModelScopeDatasetTarget,
  filename: string,
  revision: string | null,
): string {
  const encodedFile = filename.split("/").map(encodeURIComponent).join("/");
  return `${MODELSCOPE_ENDPOINT}/api/v1/datasets/${encodedRepo(target)}/repo?Revision=${encodeURIComponent(revision || "master")}&FilePath=${encodedFile}`;
}

function treeUrl(target: ModelScopeDatasetTarget, rootPath: string): string {
  const url = new URL(
    `${MODELSCOPE_ENDPOINT}/api/v1/datasets/${encodedRepo(target)}/repo/tree`,
  );
  url.searchParams.set("Root", rootPath);
  url.searchParams.set("PageNumber", "1");
  url.searchParams.set("PageSize", String(PAGE_SIZE));
  url.searchParams.set("Revision", "master");
  return url.toString();
}

function pagedTreeUrl(
  target: ModelScopeDatasetTarget,
  rootPath: string,
  page: number,
): string {
  const url = new URL(treeUrl(target, rootPath));
  url.searchParams.set("PageNumber", String(page));
  return url.toString();
}

function safeSegment(value: string): boolean {
  return HF_REPO_NAME_PATTERN.test(value);
}

function validRelativePath(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length > 0 &&
    parts.every((part) => safeSegment(part) && part !== "." && part !== "..") &&
    parts.join("/") === value
  );
}

function defaultTarget(): ModelScopeDatasetTarget {
  const target = resolveModelScopeTarget("");
  if (!target) throw new Error("Invalid ModelScope repository.");
  return target;
}

function parseSource(value: unknown): {
  source: string;
  target: ModelScopeDatasetTarget;
  sourceParts: string[];
  repoPath: string;
} {
  if (typeof value !== "string") {
    throw new TypeError(
      "`source` must be a safe ModelScope path like TacVerse/dataset.",
    );
  }
  const source = value.trim();
  if (
    !source ||
    source.includes("\\") ||
    source.includes("://") ||
    source.startsWith("/") ||
    source.endsWith("/")
  ) {
    throw new TypeError(
      "`source` must be a safe ModelScope path like TacVerse/dataset.",
    );
  }
  const parts = source.split("/");
  if (parts.length < 2 || !parts.every(safeSegment)) {
    throw new TypeError(
      "`source` must be a safe ModelScope path with at least two segments.",
    );
  }

  const configured = defaultTarget();
  if (parts[0] === configured.logicalOrg) {
    const repoPath = parts.slice(1).join("/");
    if (!validRelativePath(repoPath)) {
      throw new TypeError("`source` contains an invalid dataset path.");
    }
    return {
      source: [configured.logicalOrg, repoPath].join("/"),
      target: configured,
      sourceParts: [configured.logicalOrg, ...parts.slice(1)],
      repoPath,
    };
  }

  const physicalRepo = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
  const normalizedPhysical = normalizeModelScopeRepo(physicalRepo);
  const physicalTarget = normalizedPhysical
    ? resolveModelScopeTarget(normalizedPhysical)
    : null;
  if (physicalTarget) {
    const repoPath = parts.slice(2).join("/");
    if (!validRelativePath(repoPath)) {
      throw new TypeError("`source` contains an invalid dataset path.");
    }
    return {
      source: [physicalTarget.logicalOrg, repoPath].join("/"),
      target: physicalTarget,
      sourceParts: [physicalTarget.logicalOrg, ...parts.slice(2)],
      repoPath,
    };
  }

  throw new TypeError(
    "`source` must start with the ModelScope logical org or physical repo.",
  );
}

function normalizeRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError("`destinationRoot` must be a non-empty path.");
  }
  return path.resolve(value.trim());
}

function targetFor(root: string, parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("The destination escapes the selected download root.");
  }
  return target;
}

function normalizeScope(value: unknown): ModelScopeDownloadScope {
  if (value !== "all" && value !== "meta") {
    throw new TypeError("`scope` must be `all` or `meta`.");
  }
  return value;
}

function normalizeConcurrency(value: unknown): number {
  if (value === undefined) return DEFAULT_MODELSCOPE_DOWNLOAD_CONCURRENCY;
  if (typeof value === "boolean") {
    throw new TypeError(
      `\`concurrency\` must be an integer from 1 to ${MAX_MODELSCOPE_DOWNLOAD_CONCURRENCY}.`,
    );
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_MODELSCOPE_DOWNLOAD_CONCURRENCY
  ) {
    throw new TypeError(
      `\`concurrency\` must be an integer from 1 to ${MAX_MODELSCOPE_DOWNLOAD_CONCURRENCY}.`,
    );
  }
  return parsed;
}

function normalizeToken(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError("`token` must be a non-empty ModelScope token.");
  }
  const token = value.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new TypeError("`token` must be a non-empty ModelScope token.");
  }
  return token;
}

export function defaultModelScopeDownloadRoot(): string {
  return path.resolve(resolveLocalDatasetRoot());
}

export function modelScopeDownloadTargetKey(
  request: Pick<
    ParsedModelScopeDownloadRequest,
    "destinationRoot" | "sourceParts"
  >,
): string {
  return targetFor(request.destinationRoot, request.sourceParts);
}

export async function parseModelScopeDownloadRequest(
  body: unknown,
): Promise<ParsedModelScopeDownloadRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Expected a JSON object.");
  }
  const value = body as Record<string, unknown>;
  const source = parseSource(value.source);
  const destinationRoot = normalizeRoot(value.destinationRoot);
  const token =
    normalizeToken(value.token) ??
    (
      await resolveModelScopeToken(resolveLocalDatasetRoot()).catch(() => ({
        token: null,
      }))
    ).token;
  return {
    source: source.source,
    destinationRoot,
    scope: normalizeScope(value.scope),
    concurrency: normalizeConcurrency(value.concurrency),
    token,
    target: source.target,
    sourceParts: source.sourceParts,
    repoPath: source.repoPath,
  };
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
  signal?: AbortSignal,
): Promise<ModelScopeTreeFile[]> {
  const output: ModelScopeTreeFile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  for (;;) {
    const payload = (await fetchJson(
      pagedTreeUrl(target, rootPath, page),
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

async function listSelectedFiles(
  request: ParsedModelScopeDownloadRequest,
  signal?: AbortSignal,
): Promise<SelectedModelScopeFile[]> {
  const rootPath =
    request.scope === "meta" ? `${request.repoPath}/meta` : request.repoPath;
  const pending = [rootPath];
  const visited = new Set<string>();
  const output: SelectedModelScopeFile[] = [];
  while (pending.length > 0) {
    assertNotAborted(signal);
    const current = pending.shift() ?? "";
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const tree = await listTree(request.target, current, request.token, signal);
    for (const file of tree) {
      const remotePath = treeFilePath(file);
      if (!remotePath) continue;
      const type = treeFileType(file);
      if (type === "tree") {
        if (!validRelativePath(remotePath)) {
          throw new Error("ModelScope returned an unsafe directory path.");
        }
        pending.push(remotePath);
        continue;
      }
      if (type !== "blob" && type !== "file") continue;
      if (!validRelativePath(remotePath)) {
        throw new Error("ModelScope returned an unsafe file path.");
      }
      const prefix = `${request.repoPath}/`;
      if (!remotePath.startsWith(prefix)) continue;
      const localPath = remotePath.slice(prefix.length);
      if (request.scope === "meta" && !localPath.startsWith("meta/")) {
        continue;
      }
      if (!validRelativePath(localPath)) {
        throw new Error("ModelScope returned an unsafe file path.");
      }
      output.push({
        remotePath,
        localPath,
        size: integerSize(file.Size),
        revision: stringOrNull(file.Revision),
        sha256: stringOrNull(file.Sha256),
      });
    }
  }
  return output.sort((left, right) =>
    left.remotePath.localeCompare(right.remotePath),
  );
}

function manifestSha(files: SelectedModelScopeFile[]): string {
  const hash = createHash("sha256");
  hash.update("modelscope-download-manifest-v1\n");
  for (const file of files) {
    hash.update(
      JSON.stringify({
        path: file.remotePath,
        size: file.size,
        revision: file.revision,
        sha256: file.sha256,
      }),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

function statePath(root: string, parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(
    resolvedRoot,
    CONTROL_DIR,
    STATE_DIR,
    ...parts.slice(0, -1),
    `${parts.at(-1)}.json`,
  );
  const relative = path.relative(resolvedRoot, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The download state path escapes the selected root.");
  }
  return destination;
}

async function readState(
  root: string,
  parts: string[],
): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await fs.readFile(statePath(root, parts), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeState(
  request: ParsedModelScopeDownloadRequest,
  sha: string,
): Promise<void> {
  const destination = statePath(request.destinationRoot, request.sourceParts);
  const previous = await readState(
    request.destinationRoot,
    request.sourceParts,
  );
  if (request.scope === "all") {
    previous.fullSha = sha;
    previous.metaSha = sha;
    previous.fullConsistency = "current";
  } else {
    previous.metaSha = sha;
    previous.fullSha = null;
    previous.fullConsistency = "unknown";
  }
  previous.source = request.source;
  previous.repoId = request.source;
  previous.hubRepoId = request.target.repoId;
  previous.repoPath = request.repoPath;
  previous.subfolder = request.repoPath;
  previous.lastScope = request.scope;
  previous.updatedAt = new Date().toISOString();

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(previous, null, 2) + "\n");
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function exists(value: string): Promise<boolean> {
  return await fs
    .lstat(value)
    .then(() => true)
    .catch(() => false);
}

async function removePath(value: string): Promise<void> {
  await fs.rm(value, { recursive: true, force: true });
}

function backupTarget(
  root: string,
  parts: string[],
  scope: ModelScopeDownloadScope,
): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace("T", "T")
    .replace("Z", "Z");
  const resolvedRoot = path.resolve(root);
  const base = path.resolve(
    resolvedRoot,
    CONTROL_DIR,
    BACKUP_DIR,
    stamp,
    ...parts,
  );
  const candidate = scope === "meta" ? path.join(base, "meta") : base;
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The backup path escapes the selected root.");
  }
  return candidate;
}

async function promoteDownload(
  staged: string,
  target: string,
  request: ParsedModelScopeDownloadRequest,
  failAfterBackup = false,
): Promise<string | null> {
  const existing =
    request.scope === "meta" ? path.join(target, "meta") : target;
  const incoming =
    request.scope === "meta" ? path.join(staged, "meta") : staged;
  const backup = (await exists(existing))
    ? backupTarget(request.destinationRoot, request.sourceParts, request.scope)
    : null;
  const createdTarget = request.scope === "meta" && !(await exists(target));

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (request.scope === "meta") await fs.mkdir(target, { recursive: true });

  try {
    if (backup) {
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.rename(existing, backup);
    }
    if (failAfterBackup) throw new Error("injected promotion failure");
    await fs.rename(incoming, existing);
    return backup;
  } catch (error: unknown) {
    await removePath(existing);
    if (backup && (await exists(backup))) {
      await fs.mkdir(path.dirname(existing), { recursive: true });
      await fs.rename(backup, existing);
    } else if (createdTarget) {
      await fs.rmdir(target).catch(() => undefined);
    }
    throw error;
  }
}

async function rollbackPromoted(
  target: string,
  backup: string | null,
  scope: ModelScopeDownloadScope,
): Promise<void> {
  const installed = scope === "meta" ? path.join(target, "meta") : target;
  await removePath(installed);
  if (backup && (await exists(backup))) {
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.rename(backup, installed);
  } else if (scope === "meta") {
    await fs.rmdir(target).catch(() => undefined);
  }
}

function checkResult(
  request: ParsedModelScopeDownloadRequest,
  files: SelectedModelScopeFile[],
  sha: string,
): ModelScopeDownloadCheck {
  const targetPath = targetFor(request.destinationRoot, request.sourceParts);
  const knownSizes = files.flatMap((file) =>
    file.size === null ? [] : [file.size],
  );
  return {
    source: request.source,
    repoId: request.source,
    hubRepoId: request.target.repoId,
    repoPath: request.repoPath,
    subfolder: request.repoPath,
    revisionSha: sha,
    destinationRoot: request.destinationRoot,
    targetPath,
    fileCount: files.length,
    sizeBytes: knownSizes.reduce((sum, size) => sum + size, 0),
    unknownSizeFiles: files.length - knownSizes.length,
    targetExists: false,
    scopeExists: false,
    localScopeSha: null,
    matchesRevision: false,
  };
}

export async function runModelScopeDownloadCheck(
  request: ParsedModelScopeDownloadRequest,
  signal?: AbortSignal,
): Promise<ModelScopeDownloadCheck> {
  const files = await listSelectedFiles(request, signal);
  if (!files.length) {
    throw new TypeError("No files match the selected download scope.");
  }
  const sha = manifestSha(files);
  const result = checkResult(request, files, sha);
  const scopeTarget =
    request.scope === "meta"
      ? path.join(result.targetPath, "meta")
      : result.targetPath;
  const state = await readState(request.destinationRoot, request.sourceParts);
  const localSha = state[request.scope === "meta" ? "metaSha" : "fullSha"];
  result.targetExists = await exists(result.targetPath);
  result.scopeExists = await exists(scopeTarget);
  result.localScopeSha = typeof localSha === "string" ? localSha : null;
  result.matchesRevision = result.localScopeSha === sha && result.scopeExists;
  return result;
}

function progressSnapshot(
  started: number,
  files: SelectedModelScopeFile[],
  processedBytes: number,
  completedFiles: number,
  downloadedByFile: Map<string, number>,
  activeFiles: Set<string>,
  workers: number,
  totalKnown: number,
  unknownSizeFiles: number,
  currentFile?: string | null,
  currentFileBytes?: number | null,
  currentFileTotalBytes?: number | null,
): ModelScopeDownloadProgress {
  const bytes =
    processedBytes +
    [...downloadedByFile.values()].reduce((sum, value) => sum + value, 0);
  const elapsed = Math.max((Date.now() - started) / 1000, 0.001);
  const percent =
    totalKnown > 0 && unknownSizeFiles === 0
      ? Math.min(99.9, Math.round((bytes / totalKnown) * 1000) / 10)
      : Math.round((completedFiles / files.length) * 1000) / 10;
  const visibleActive = [...activeFiles].sort().slice(0, workers);
  return {
    phase: "downloading",
    currentFile: currentFile || visibleActive[0] || null,
    filesDone: completedFiles,
    filesTotal: files.length,
    bytes,
    totalBytes: totalKnown,
    currentFileBytes,
    currentFileTotalBytes,
    activeFiles: visibleActive,
    concurrency: workers,
    bytesPerSecond: Math.round(bytes / elapsed),
    percent,
  };
}

export async function downloadModelScopeDataset(
  request: ParsedModelScopeDownloadRequest,
  revisionSha: string,
  onEvent: (event: ModelScopeDownloadStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ModelScopeDownloadResult> {
  const files = await listSelectedFiles(request, signal);
  if (!files.length) {
    throw new TypeError("No files match the selected download scope.");
  }
  const actualSha = manifestSha(files);
  if (actualSha !== revisionSha) {
    throw new ModelScopeDownloadConflict(
      "The ModelScope dataset changed after it was checked. Check the download again.",
    );
  }

  const stagingParent = path.resolve(
    request.destinationRoot,
    CONTROL_DIR,
    STAGING_DIR,
  );
  const relativeStaging = path.relative(request.destinationRoot, stagingParent);
  if (relativeStaging.startsWith("..") || path.isAbsolute(relativeStaging)) {
    throw new TypeError("The staging path escapes the selected root.");
  }
  await fs.mkdir(stagingParent, { recursive: true });
  const job = await fs.mkdtemp(path.join(stagingParent, "download-"));
  const snapshot = path.join(job, "snapshot");
  const targetPath = targetFor(request.destinationRoot, request.sourceParts);
  await fs.mkdir(snapshot, { recursive: true });

  const totalKnown = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const unknownSizeFiles = files.filter((file) => file.size === null).length;
  const workers = Math.min(request.concurrency, files.length);
  const started = Date.now();
  const downloadedByFile = new Map<string, number>();
  const activeFiles = new Set<string>();
  let processedBytes = 0;
  let completedFiles = 0;
  let lastReport = 0;
  const failure = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, failure.signal])
    : failure.signal;

  const emitProgress = (
    currentFile?: string | null,
    currentFileBytes?: number | null,
    currentFileTotalBytes?: number | null,
    force = false,
  ) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_REPORT_INTERVAL_MS) return;
    lastReport = now;
    onEvent({
      type: "progress",
      progress: progressSnapshot(
        started,
        files,
        processedBytes,
        completedFiles,
        downloadedByFile,
        activeFiles,
        workers,
        totalKnown,
        unknownSizeFiles,
        currentFile,
        currentFileBytes,
        currentFileTotalBytes,
      ),
    });
  };

  const downloadOne = async (file: SelectedModelScopeFile): Promise<void> => {
    assertNotAborted(combinedSignal);
    activeFiles.add(file.remotePath);
    downloadedByFile.set(file.remotePath, 0);
    emitProgress(file.remotePath, 0, file.size, true);
    const destination = path.join(snapshot, ...file.localPath.split("/"));
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const response = await fetchModelScope(
        fileUrl(request.target, file.remotePath, file.revision),
        request.token,
        combinedSignal,
      );
      const contentLength = integerSize(response.headers.get("content-length"));
      const total = file.size ?? contentLength;
      const expectedSha256 =
        file.sha256 && /^[a-f0-9]{64}$/iu.test(file.sha256)
          ? file.sha256.toLowerCase()
          : null;
      const hash = expectedSha256 ? createHash("sha256") : null;
      const handle = await fs.open(destination, "w");
      let written = 0;
      try {
        if (!response.body) {
          const buffer = Buffer.from(await response.arrayBuffer());
          hash?.update(buffer);
          await handle.write(buffer);
          written = buffer.byteLength;
          downloadedByFile.set(file.remotePath, written);
          emitProgress(file.remotePath, written, total, true);
        } else {
          const reader = response.body.getReader();
          for (;;) {
            assertNotAborted(combinedSignal);
            const { done, value } = await reader.read();
            if (done) break;
            const buffer = Buffer.from(value);
            hash?.update(buffer);
            await handle.write(buffer);
            written += buffer.byteLength;
            downloadedByFile.set(file.remotePath, written);
            emitProgress(file.remotePath, written, total);
          }
        }
      } finally {
        await handle.close();
      }
      if (file.size !== null && written !== file.size) {
        throw new Error(`Size verification failed for ${file.remotePath}.`);
      }
      if (expectedSha256 && hash?.digest("hex") !== expectedSha256) {
        throw new Error(`SHA-256 verification failed for ${file.remotePath}.`);
      }
      processedBytes += written;
      completedFiles += 1;
      downloadedByFile.delete(file.remotePath);
      activeFiles.delete(file.remotePath);
      onEvent({
        type: "progress",
        progress: {
          ...progressSnapshot(
            started,
            files,
            processedBytes,
            completedFiles,
            downloadedByFile,
            activeFiles,
            workers,
            totalKnown,
            unknownSizeFiles,
            file.remotePath,
            written,
            total,
          ),
          percent:
            totalKnown > 0 && unknownSizeFiles === 0
              ? Math.min(
                  100,
                  Math.round((processedBytes / totalKnown) * 1000) / 10,
                )
              : Math.round((completedFiles / files.length) * 1000) / 10,
        },
      });
    } catch (error: unknown) {
      downloadedByFile.delete(file.remotePath);
      activeFiles.delete(file.remotePath);
      throw error;
    }
  };

  try {
    emitProgress(null, null, null, true);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        assertNotAborted(combinedSignal);
        const index = cursor;
        cursor += 1;
        const file = files[index];
        if (!file) return;
        await downloadOne(file);
      }
    };
    try {
      await Promise.all(Array.from({ length: workers }, worker));
    } catch (error: unknown) {
      failure.abort();
      throw error;
    }

    assertNotAborted(combinedSignal);
    onEvent({
      type: "progress",
      progress: { phase: "promoting", percent: 100 },
    });
    const backupPath = await promoteDownload(snapshot, targetPath, request);
    try {
      assertNotAborted(combinedSignal);
      await writeState(request, revisionSha);
    } catch (error: unknown) {
      await rollbackPromoted(targetPath, backupPath, request.scope);
      throw error;
    }
    return {
      source: request.source,
      repoId: request.source,
      hubRepoId: request.target.repoId,
      repoPath: request.repoPath,
      subfolder: request.repoPath,
      scope: request.scope,
      revisionSha,
      targetPath,
      backupPath,
      fileCount: files.length,
      sizeBytes: processedBytes,
      concurrency: workers,
      metaOnly: request.scope === "meta",
    };
  } finally {
    await fs.rm(job, { recursive: true, force: true });
  }
}

export const LOCAL_ROUTE_ORG = "_local";
export const DEFAULT_LOCAL_DATASET_ROOT_SUFFIX = "/.cache/huggingface/lerobot";
export const DEFAULT_LOCAL_DATASET_ROOT_DISPLAY =
  "~/.cache/huggingface/lerobot";
const LOCAL_PREFIX = "local:";
const LOCAL_ROUTE_PREFIX = "/_local";
const LOCAL_FILE_ROUTE_PREFIX = "/api/local-datasets";

function encodeUtf8ToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64UrlToUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function isLocalRepoId(repoId: string): boolean {
  return repoId.startsWith(LOCAL_PREFIX);
}

export function makeLocalRepoId(datasetPath: string): string {
  return `${LOCAL_PREFIX}${datasetPath}`;
}

export function getLocalDatasetPath(repoId: string): string | null {
  if (!isLocalRepoId(repoId)) return null;
  return repoId.slice(LOCAL_PREFIX.length) || null;
}

export function encodeLocalDatasetPath(datasetPath: string): string {
  return encodeUtf8ToBase64Url(datasetPath);
}

export function decodeLocalDatasetPath(encodedPath: string): string {
  return decodeBase64UrlToUtf8(encodedPath);
}

export function resolveServerLocalDatasetPath(value: string): string {
  const normalized = normalizeDatasetPathInput(value.trim());
  if (!normalized) {
    throw new Error("Local dataset path cannot be empty.");
  }

  if (isAbsoluteDatasetPath(normalized)) {
    return normalized;
  }

  const homeDir = process.env.HOME?.trim();
  const configuredRoot =
    process.env.LOCAL_DATASET_ROOT?.trim() ||
    process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT?.trim() ||
    (homeDir ? `${homeDir}${DEFAULT_LOCAL_DATASET_ROOT_SUFFIX}` : "");

  if (!configuredRoot) {
    throw new Error(
      "Unable to resolve local dataset root. Set LOCAL_DATASET_ROOT or HOME.",
    );
  }

  return resolveLocalDatasetInput(normalized, configuredRoot);
}

export function getLocalDatasetRoute(encodedPath: string): string {
  return `${LOCAL_ROUTE_PREFIX}/${encodedPath}`;
}

export function getLocalDatasetFileBase(repoId: string): string {
  const datasetPath = getLocalDatasetPath(repoId);
  if (!datasetPath) {
    throw new Error(`Not a local dataset repo id: ${repoId}`);
  }
  return `${LOCAL_FILE_ROUTE_PREFIX}/${encodeLocalDatasetPath(datasetPath)}`;
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/[\\/]+$/g, "");
  return trimmed || value;
}

function normalizeComparablePath(value: string): string {
  return trimTrailingSlashes(
    normalizeDatasetPathInput(value).replace(/\\/g, "/"),
  );
}

export function normalizeRelativeLocalDatasetPath(value: string): string {
  const segments: string[] = [];
  for (const segment of normalizeDatasetPathInput(value)
    .replace(/\\/g, "/")
    .split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new Error("Local dataset paths cannot contain '..' segments.");
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function getConfiguredClientLocalDatasetRoot(): string | null {
  const configuredRoot = process.env.NEXT_PUBLIC_LOCAL_DATASET_ROOT?.trim();
  if (!configuredRoot) return null;
  return trimTrailingSlashes(normalizeDatasetPathInput(configuredRoot));
}

export function resolveLocalDatasetInput(
  value: string,
  localDatasetRoot: string,
): string {
  const normalized = normalizeDatasetPathInput(value.trim());
  if (!normalized) {
    throw new Error("Local dataset path cannot be empty.");
  }
  if (isAbsoluteDatasetPath(normalized)) {
    return normalized;
  }

  const relativePath = normalizeRelativeLocalDatasetPath(normalized);
  if (!relativePath) {
    throw new Error("Local dataset path cannot be empty.");
  }
  return `${trimTrailingSlashes(normalizeDatasetPathInput(localDatasetRoot))}/${relativePath}`;
}

export function getLocalDatasetRelativePath(
  datasetPath: string,
  localDatasetRoot?: string,
): string | null {
  const comparablePath = normalizeComparablePath(datasetPath);
  const explicitRoot =
    localDatasetRoot ?? getConfiguredClientLocalDatasetRoot() ?? undefined;

  if (explicitRoot) {
    const comparableRoot = normalizeComparablePath(explicitRoot);
    const rootPrefix = `${comparableRoot}/`;

    if (comparablePath.startsWith(rootPrefix)) {
      const relativePath = comparablePath.slice(rootPrefix.length);
      return relativePath || null;
    }
  }

  const defaultRootPrefix = `${DEFAULT_LOCAL_DATASET_ROOT_SUFFIX}/`;
  const markerIndex = comparablePath.indexOf(defaultRootPrefix);
  if (markerIndex < 0) {
    return null;
  }

  const relativePath = comparablePath.slice(
    markerIndex + defaultRootPrefix.length,
  );
  if (!relativePath) {
    return null;
  }

  return relativePath;
}

export function getDisplayNameForRepoId(repoId: string): string {
  const datasetPath = getLocalDatasetPath(repoId);
  if (!datasetPath) return repoId;

  return getLocalDatasetRelativePath(datasetPath) ?? datasetPath;
}

/**
 * The Hugging Face `owner/name` a local dataset came from, or null when the
 * path cannot name one.
 *
 * The relative path used to be exactly `<org>/<name>`, so a two-segment test
 * was the whole rule. Since 2026-09-01 the TacVerse corpus is bucketed —
 * `TacVerse/merged/<name>`, `TacVerse/raw/<name>`, … — and the middle segment
 * is a local storage detail that has no counterpart on the Hub. A strict
 * two-segment test would return null for every dataset in the corpus, and
 * because null is also the legitimate answer for "not from the Hub", every
 * back-link would simply vanish with nothing to notice.
 *
 * So: first and last segment, ignoring whatever buckets sit between them.
 */
export function getLinkedHubDatasetRepoId(repoId: string): string | null {
  if (!isLocalRepoId(repoId)) return repoId;

  const displayName = getDisplayNameForRepoId(repoId).trim();
  // `getDisplayNameForRepoId` falls back to the absolute path when the dataset
  // is not under the root — `/tmp/lerobot-root` must not become the repo id
  // `tmp/lerobot-root`. A leading separator is the tell.
  if (displayName.startsWith("/")) return null;
  const segments = displayName.split("/");
  if (segments.length < 2 || segments.some((s) => !s || /\s/.test(s))) {
    return null;
  }
  return `${segments[0]}/${segments[segments.length - 1]}`;
}

export function isAbsoluteDatasetPath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("file://")) return true;

  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

export function normalizeDatasetPathInput(value: string): string {
  if (value.startsWith("file://")) {
    return decodeURIComponent(value.slice("file://".length));
  }
  return value;
}

export function repoIdFromRouteParams(org: string, dataset: string): string {
  if (org === LOCAL_ROUTE_ORG) {
    return makeLocalRepoId(decodeLocalDatasetPath(dataset));
  }
  return `${org}/${dataset}`;
}

export function routePathFromRepoId(
  repoId: string,
  episodeId?: number,
): string {
  const suffix =
    episodeId === undefined ? "" : `/episode_${Math.max(0, episodeId)}`;

  if (isLocalRepoId(repoId)) {
    const datasetPath = getLocalDatasetPath(repoId);
    if (!datasetPath) {
      throw new Error(`Invalid local repo id: ${repoId}`);
    }
    return `${LOCAL_ROUTE_PREFIX}/${encodeLocalDatasetPath(datasetPath)}${suffix}`;
  }

  return `/${repoId}${suffix}`;
}

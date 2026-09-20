import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { resolveHfToken } from "@/lib/hf-token-store";
import { redactHfSecrets } from "@/lib/hf-identity";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  IMPACT_COLLECTION_SLUG,
  IMPACT_COLLECTION_URL,
  IMPACT_REPO_ID,
  IMPACT_REQUIRED_PRIVATE_REPOS,
  aggregateAdvancedLogs,
  buildImpactData,
  parsePublisherAnalytics,
  readDeveloperHashes,
  readImpactCache,
  writeImpactCache,
  type ImpactRepositoryDefinition,
} from "@/lib/tacverse-impact";
import type {
  ImpactSourceState,
  TacVerseImpactData,
} from "@/types/tacverse-impact.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PUBLISHER_URL =
  "https://huggingface.co/organizations/TacVerse/settings/publisher-analytics/download-breakdown";
const DEFAULT_COLLECTION_API_URL =
  "https://huggingface.co/api/collections/TacVerse/tacverse";
const DEFAULT_METADATA_URL = `https://huggingface.co/api/datasets/${IMPACT_REPO_ID}?blobs=true`;
const DEFAULT_TREE_URL = `https://huggingface.co/api/datasets/${IMPACT_REPO_ID}/tree/main?recursive=false&expand=false`;
const REQUEST_TIMEOUT_MS = 20_000;
const ACCESS_HEADER = "x-tacverse-impact-key";
const PROJECT_IMPACT_SECRET_PATH = path.join(
  process.cwd(),
  ".xense-viewer",
  "secrets",
  "tacverse-impact-key",
);
const MAX_SECRET_LENGTH = 4096;
const DEFAULT_ADVANCED_LOG_PATH = path.join(
  process.cwd(),
  ".xense-viewer",
  "tacverse-impact",
  "request-logs.csv",
);

class ImpactSourceError extends Error {
  fallback: TacVerseImpactData | null = null;

  constructor(
    message: string,
    readonly status: ImpactSourceState,
  ) {
    super(message);
  }
}

let refreshInFlight: Promise<TacVerseImpactData> | null = null;

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store, no-transform" },
  });
}

async function readProjectImpactSecret(): Promise<string | null> {
  try {
    const value = (
      await fs.readFile(PROJECT_IMPACT_SECRET_PATH, "utf8")
    ).trim();
    return value && value.length <= MAX_SECRET_LENGTH ? value : null;
  } catch {
    return null;
  }
}

async function accessError(request?: NextRequest): Promise<Response | null> {
  const expected =
    process.env.TACVERSE_IMPACT_ACCESS_KEY?.trim() ||
    (await readProjectImpactSecret());
  if (!expected) {
    return json(
      {
        error:
          "Configure TACVERSE_IMPACT_ACCESS_KEY or .xense-viewer/secrets/tacverse-impact-key before private analytics can be served.",
        code: "impact_access_not_configured",
      },
      503,
    );
  }
  const provided = request?.headers.get(ACCESS_HEADER)?.trim() ?? "";
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  const valid =
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);
  return valid
    ? null
    : json(
        {
          error: "A valid TacVerse Impact access key is required.",
          code: "impact_access_denied",
        },
        401,
      );
}

function authHeaders(token: string | null): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function fetchText(
  url: string,
  token: string | null,
  source: "collection" | "publisher" | "metadata",
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Network request failed.";
    throw new ImpactSourceError(
      `${source} request failed: ${message}`,
      "unavailable",
    );
  }
  if (!response.ok) {
    const state =
      response.status === 401 || response.status === 403
        ? "unauthorized"
        : "unavailable";
    throw new ImpactSourceError(
      `${source} request returned HTTP ${response.status}.`,
      state,
    );
  }
  return response.text();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function requiredPrivateRepos(): string[] {
  const configured = process.env.TACVERSE_IMPACT_REQUIRED_PRIVATE_REPOS;
  if (configured === undefined) return [...IMPACT_REQUIRED_PRIVATE_REPOS];
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

type CollectionResult = {
  repositories: ImpactRepositoryDefinition[];
  collection: TacVerseImpactData["collection"];
};

async function fetchCollection(token: string): Promise<CollectionResult> {
  const url =
    process.env.TACVERSE_IMPACT_COLLECTION_URL?.trim() ||
    DEFAULT_COLLECTION_API_URL;
  const payload = JSON.parse(
    await fetchText(url, token, "collection"),
  ) as Record<string, unknown>;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const byId = new Map<string, ImpactRepositoryDefinition>();

  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = item.type ?? item.repoType;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (type !== "dataset" || !id || id === IMPACT_REPO_ID) continue;
    byId.set(id, {
      id,
      scope: "collection",
      private: item.private === true,
      position:
        typeof item.position === "number" && Number.isFinite(item.position)
          ? item.position
          : null,
      lastModified:
        typeof item.lastModified === "string" ? item.lastModified : null,
    });
  }

  const missingPrivate = requiredPrivateRepos().filter(
    (repository) => !byId.has(repository),
  );
  if (missingPrivate.length) {
    throw new ImpactSourceError(
      `The Hugging Face credential cannot see required private Collection members: ${missingPrivate.join(", ")}.`,
      "unauthorized",
    );
  }

  const repositories = [...byId.values()];
  const privateDatasetCount = repositories.filter(
    (repository) => repository.private,
  ).length;
  const slug =
    typeof payload.slug === "string" && payload.slug.trim()
      ? payload.slug
      : IMPACT_COLLECTION_SLUG;
  return {
    repositories,
    collection: {
      slug,
      title:
        typeof payload.title === "string" && payload.title.trim()
          ? payload.title
          : "TacVerse",
      url: IMPACT_COLLECTION_URL,
      description:
        typeof payload.description === "string" ? payload.description : null,
      lastModified:
        typeof payload.lastUpdated === "string" ? payload.lastUpdated : null,
      datasetCount: repositories.length,
      publicDatasetCount: repositories.length - privateDatasetCount,
      privateDatasetCount,
      requiredPrivateReposVisible: true,
    },
  };
}

function metadataFromPayload(value: unknown): {
  storageBytes: number | null;
  lastModified: string | null;
} {
  if (!value || typeof value !== "object") {
    return { storageBytes: null, lastModified: null };
  }
  const payload = value as Record<string, unknown>;
  const siblings = Array.isArray(payload.siblings) ? payload.siblings : [];
  let siblingTotal = 0;
  let hasSiblingSize = false;
  for (const item of siblings) {
    if (!item || typeof item !== "object") continue;
    const sibling = item as Record<string, unknown>;
    const lfs =
      sibling.lfs && typeof sibling.lfs === "object"
        ? (sibling.lfs as Record<string, unknown>)
        : null;
    const size = numberOrNull(lfs?.size) ?? numberOrNull(sibling.size);
    if (size !== null) {
      siblingTotal += size;
      hasSiblingSize = true;
    }
  }
  const cardData =
    payload.cardData && typeof payload.cardData === "object"
      ? (payload.cardData as Record<string, unknown>)
      : null;
  return {
    storageBytes:
      numberOrNull(payload.usedStorage) ??
      numberOrNull(payload.storage) ??
      numberOrNull(cardData?.size_in_bytes) ??
      (hasSiblingSize ? siblingTotal : null),
    lastModified:
      typeof payload.lastModified === "string" ? payload.lastModified : null,
  };
}

function rootDirectoryCount(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return row.type === "directory" || row.type === "tree";
  }).length;
}

async function fetchRepositoryMetadata(token: string): Promise<{
  repository: Partial<TacVerseImpactData["repository"]>;
  status: ImpactSourceState;
}> {
  const metadataUrl =
    process.env.TACVERSE_IMPACT_METADATA_URL?.trim() || DEFAULT_METADATA_URL;
  const treeUrl =
    process.env.TACVERSE_IMPACT_TREE_URL?.trim() || DEFAULT_TREE_URL;
  try {
    const [metadataText, treeText] = await Promise.all([
      fetchText(metadataUrl, token, "metadata"),
      fetchText(treeUrl, token, "metadata"),
    ]);
    return {
      repository: {
        ...metadataFromPayload(JSON.parse(metadataText)),
        subdatasetCount: rootDirectoryCount(JSON.parse(treeText)),
      },
      status: "live",
    };
  } catch {
    return { repository: {}, status: "unavailable" };
  }
}

async function advancedData(
  root: string,
  repositoryIds: ReadonlySet<string>,
  collectionIds: ReadonlySet<string>,
): Promise<{
  aggregation: ReturnType<typeof aggregateAdvancedLogs> | null;
  bySource: {
    collection: ReturnType<typeof aggregateAdvancedLogs>;
    opendata: ReturnType<typeof aggregateAdvancedLogs>;
  } | null;
  status: ImpactSourceState;
}> {
  const configuredPath = process.env.TACVERSE_IMPACT_LOG_PATH?.trim();
  const logPath = configuredPath || DEFAULT_ADVANCED_LOG_PATH;
  try {
    const [csv, hashes] = await Promise.all([
      fs.readFile(logPath, "utf8"),
      readDeveloperHashes(root),
    ]);
    return {
      aggregation: aggregateAdvancedLogs(csv, hashes, repositoryIds),
      bySource: {
        collection: aggregateAdvancedLogs(csv, hashes, collectionIds),
        opendata: aggregateAdvancedLogs(csv, hashes, new Set([IMPACT_REPO_ID])),
      },
      status: "live",
    };
  } catch (error: unknown) {
    const missing =
      (error as NodeJS.ErrnoException)?.code === "ENOENT" && !configuredPath;
    return {
      aggregation: null,
      bySource: null,
      status: missing ? "not_configured" : "unavailable",
    };
  }
}

function standaloneRepository(): ImpactRepositoryDefinition {
  return {
    id: IMPACT_REPO_ID,
    scope: "standalone",
    private: false,
    position: null,
    lastModified: null,
  };
}

function emptyData(
  status: ImpactSourceState,
  message: string,
): TacVerseImpactData {
  return buildImpactData({
    publisher: parsePublisherAnalytics(""),
    repositories: [standaloneRepository()],
    collectionStatus: status,
    publisherStatus: status,
    metadataStatus: "unavailable",
    advancedStatus: process.env.TACVERSE_IMPACT_LOG_PATH
      ? "unavailable"
      : "not_configured",
    message,
  });
}

async function refresh(
  root: string,
  token: string | null,
): Promise<TacVerseImpactData> {
  if (!token) {
    const data = emptyData(
      "not_configured",
      "A Hugging Face token is required to read the private TacVerse Collection and Publisher Analytics.",
    );
    await writeImpactCache(root, data).catch(() => undefined);
    return data;
  }

  let collection: CollectionResult;
  try {
    collection = await fetchCollection(token);
  } catch (error: unknown) {
    if (error instanceof ImpactSourceError) {
      error.fallback = emptyData(error.status, error.message);
    }
    throw error;
  }

  const repositories = [...collection.repositories, standaloneRepository()];
  const repositoryIds = new Set(
    repositories.map((repository) => repository.id),
  );
  const collectionIds = new Set(
    collection.repositories.map((repository) => repository.id),
  );
  const publisherUrl =
    process.env.TACVERSE_IMPACT_PUBLISHER_ANALYTICS_URL?.trim() ||
    DEFAULT_PUBLISHER_URL;

  const [metadata, advanced] = await Promise.all([
    fetchRepositoryMetadata(token),
    advancedData(root, repositoryIds, collectionIds),
  ]);

  let csv: string;
  try {
    csv = await fetchText(publisherUrl, token, "publisher");
  } catch (error: unknown) {
    if (error instanceof ImpactSourceError) {
      error.fallback = buildImpactData({
        publisher: parsePublisherAnalytics("", repositoryIds),
        repositories,
        collection: collection.collection,
        collectionStatus: "live",
        publisherStatus: error.status,
        metadataStatus: metadata.status,
        repository: metadata.repository,
        advanced: advanced.aggregation,
        advancedBySource: advanced.bySource ?? undefined,
        advancedStatus: advanced.status,
        message: error.message,
      });
    }
    throw error;
  }

  const publisher = parsePublisherAnalytics(csv, repositoryIds);
  const data = buildImpactData({
    publisher,
    publisherBySource: {
      collection: parsePublisherAnalytics(csv, collectionIds),
      opendata: parsePublisherAnalytics(csv, new Set([IMPACT_REPO_ID])),
    },
    repositories,
    collection: collection.collection,
    collectionStatus: "live",
    publisherStatus: "live",
    metadataStatus: metadata.status,
    repository: metadata.repository,
    advanced: advanced.aggregation,
    advancedBySource: advanced.bySource ?? undefined,
    advancedStatus: advanced.status,
  });
  await writeImpactCache(root, data).catch(() => undefined);
  return data;
}

function asCached(
  data: TacVerseImpactData,
  stale: boolean,
  message?: string,
): TacVerseImpactData {
  const copy = structuredClone(data);
  copy.sourceStatus.cache = stale ? "stale" : "fresh";
  for (const source of [
    "collection",
    "publisherAnalytics",
    "metadata",
    "advancedLog",
  ] as const) {
    if (copy.sourceStatus[source] === "live") {
      copy.sourceStatus[source] = stale ? "stale" : "cache";
    }
  }
  if (message) copy.sourceStatus.message = message;
  return copy;
}

async function loadImpact(force: boolean): Promise<TacVerseImpactData> {
  const root = resolveLocalDatasetRoot();
  const projectSecret = await readProjectImpactSecret();
  const cached = await readImpactCache(root);
  const fresh = cached && new Date(cached.expiresAt).valueOf() > Date.now();
  if (!force && fresh) return asCached(cached, false);

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const credential = await resolveHfToken(root);
      const token = credential.token ?? projectSecret;
      if (!token && cached) {
        throw new ImpactSourceError(
          "A Hugging Face token is required to refresh private Collection analytics.",
          "not_configured",
        );
      }
      return refresh(root, token);
    })().finally(() => {
      refreshInFlight = null;
    });
  }

  try {
    return await refreshInFlight;
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = redactHfSecrets(raw, [
      process.env.HF_TOKEN ?? "",
      projectSecret ?? "",
    ]);
    if (cached) return asCached(cached, true, message);
    if (error instanceof ImpactSourceError && error.fallback) {
      error.fallback.sourceStatus.message = message;
      return error.fallback;
    }
    const state =
      error instanceof ImpactSourceError ? error.status : "unavailable";
    return emptyData(state, message);
  }
}

export async function GET(request?: NextRequest): Promise<Response> {
  const denied = await accessError(request);
  if (denied) return denied;
  try {
    return json(await loadImpact(false));
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Impact data unavailable.",
      },
      500,
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = await accessError(request);
  if (denied) return denied;
  if (!isSameOriginRequest(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  try {
    return json(await loadImpact(true));
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Impact refresh failed.",
      },
      500,
    );
  }
}

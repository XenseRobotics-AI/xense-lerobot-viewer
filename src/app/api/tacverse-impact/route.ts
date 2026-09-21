import { randomBytes, timingSafeEqual } from "node:crypto";
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
  publisherSeriesFromRepositoryTotals,
  readDeveloperHashes,
  replacePublisherAnalytics,
  readImpactCache,
  writeImpactCache,
  type ImpactRepositoryDefinition,
} from "@/lib/tacverse-impact";
import type {
  ImpactCommunityEngagement,
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
const PROJECT_IMPACT_SESSION_PATH = path.join(
  process.cwd(),
  ".xense-viewer",
  "secrets",
  "tacverse-impact-session",
);
const SESSION_COOKIE = "tacverse-impact-session";
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
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

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store, no-transform",
      ...headers,
    },
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

async function readProjectImpactSession(): Promise<string | null> {
  try {
    const value = (
      await fs.readFile(PROJECT_IMPACT_SESSION_PATH, "utf8")
    ).trim();
    return value && value.length <= MAX_SECRET_LENGTH ? value : null;
  } catch {
    return null;
  }
}

async function writePrivateFile(
  filePath: string,
  value: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${value}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function secretsEqual(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function sessionCookie(value: string, request: NextRequest): string {
  const secure = request.nextUrl.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secure}`;
}

function clearSessionCookie(request: NextRequest): string {
  const secure = request.nextUrl.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}

type Authorization = {
  denied: Response | null;
  setCookie: string | null;
};

async function authorizePrivateRequest(
  request: NextRequest,
  allowTokenEnrollment: boolean,
): Promise<Authorization> {
  const session = await readProjectImpactSession();
  const cookie = request.cookies.get(SESSION_COOKIE)?.value ?? null;
  if (secretsEqual(session, cookie)) {
    return { denied: null, setCookie: null };
  }

  const provided = request.headers.get(ACCESS_HEADER)?.trim() ?? "";
  const expected =
    process.env.TACVERSE_IMPACT_ACCESS_KEY?.trim() ||
    (await readProjectImpactSecret());
  let accepted = secretsEqual(expected, provided);
  let enrolled = false;

  if (!accepted && provided && allowTokenEnrollment) {
    try {
      await fetchCollection(provided, true);
      await writePrivateFile(PROJECT_IMPACT_SECRET_PATH, provided);
      accepted = true;
      enrolled = true;
    } catch {
      accepted = false;
    }
  }

  if (!accepted) {
    return {
      denied: json(
        {
          error:
            "A Hugging Face token with access to the private TacVerse Collection is required.",
          code: "impact_access_denied",
        },
        401,
      ),
      setCookie: null,
    };
  }

  const nextSession =
    !session || enrolled ? randomBytes(32).toString("hex") : session;
  if (!session || enrolled) {
    await writePrivateFile(PROJECT_IMPACT_SESSION_PATH, nextSession);
  }
  return {
    denied: null,
    setCookie: sessionCookie(nextSession, request),
  };
}

function authHeaders(token: string | null): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function fetchText(
  url: string,
  token: string | null,
  source: "collection" | "publisher" | "metadata" | "community",
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

async function fetchCollection(
  token: string | null,
  requirePrivate = true,
): Promise<CollectionResult> {
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
    if (
      type !== "dataset" ||
      !id ||
      id === IMPACT_REPO_ID ||
      (!requirePrivate && item.private === true)
    )
      continue;
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
      likes: numberOrNull(item.likes) ?? 0,
      downloads: numberOrNull(item.downloads) ?? 0,
    });
  }

  if (requirePrivate) {
    const missingPrivate = requiredPrivateRepos().filter(
      (repository) => !byId.has(repository),
    );
    if (missingPrivate.length) {
      throw new ImpactSourceError(
        `The Hugging Face credential cannot see required private Collection members: ${missingPrivate.join(", ")}.`,
        "unauthorized",
      );
    }
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
      requiredPrivateReposVisible: requirePrivate,
    },
  };
}

function metadataFromPayload(value: unknown): {
  storageBytes: number | null;
  lastModified: string | null;
  likes: number | null;
  downloads: number | null;
} {
  if (!value || typeof value !== "object") {
    return {
      storageBytes: null,
      lastModified: null,
      likes: null,
      downloads: null,
    };
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
    likes: numberOrNull(payload.likes),
    downloads: numberOrNull(payload.downloads),
  };
}

async function fetchPublicRepositoryDownloads(
  repositoryId: string,
  fallback: number,
): Promise<number> {
  const encodedId = repositoryId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const params = new URLSearchParams();
  params.append("expand[]", "downloadsAllTime");
  params.append("expand[]", "downloads");
  try {
    const payload = JSON.parse(
      await fetchText(
        `https://huggingface.co/api/datasets/${encodedId}?${params.toString()}`,
        null,
        "metadata",
      ),
    ) as Record<string, unknown>;
    return (
      numberOrNull(payload.downloadsAllTime) ??
      numberOrNull(payload.downloads) ??
      fallback
    );
  } catch {
    return fallback;
  }
}

async function enrichPublicRepositoryDownloads(
  repositories: ImpactRepositoryDefinition[],
): Promise<ImpactRepositoryDefinition[]> {
  const enriched = new Array<ImpactRepositoryDefinition>(repositories.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < repositories.length) {
      const index = cursor;
      cursor += 1;
      const repository = repositories[index];
      enriched[index] = {
        ...repository,
        downloads: await fetchPublicRepositoryDownloads(
          repository.id,
          repository.downloads,
        ),
      };
    }
  };
  const workerCount = Math.min(8, repositories.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return enriched;
}

function rootDirectoryCount(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return row.type === "directory" || row.type === "tree";
  }).length;
}

async function fetchRepositoryMetadata(token: string | null): Promise<{
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

type RepositoryCommunity = {
  discussions: number;
  pullRequests: number;
  comments: number;
  automatedThreads: number;
};

type CommunityResult = {
  byRepository: Map<string, RepositoryCommunity>;
  status: ImpactSourceState;
};

function automatedCommunityAuthor(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const author = value as Record<string, unknown>;
  const label =
    `${typeof author.name === "string" ? author.name : ""} ${typeof author.fullname === "string" ? author.fullname : ""}`.toLowerCase();
  return (
    label.includes("(bot)") ||
    label.endsWith("-bot") ||
    label.includes(" bot ") ||
    label.includes("parquet-converter")
  );
}

async function fetchRepositoryCommunity(
  repositoryId: string,
  token: string | null,
): Promise<RepositoryCommunity> {
  const encodedId = repositoryId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  let page = 0;
  let seen = 0;
  let expected = Number.POSITIVE_INFINITY;
  const result: RepositoryCommunity = {
    discussions: 0,
    pullRequests: 0,
    comments: 0,
    automatedThreads: 0,
  };

  while (seen < expected && page < 100) {
    const response = await fetch(
      `https://huggingface.co/api/datasets/${encodedId}/discussions?status=all&p=${page}`,
      {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new ImpactSourceError(
        `community request for ${repositoryId} returned HTTP ${response.status}.`,
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : "unavailable",
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const rows = Array.isArray(payload.discussions) ? payload.discussions : [];
    expected = numberOrNull(payload.count) ?? rows.length;
    if (!rows.length) break;

    for (const value of rows) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      if (row.isPullRequest === true) result.pullRequests += 1;
      else result.discussions += 1;
      result.comments += numberOrNull(row.numComments) ?? 0;
      if (automatedCommunityAuthor(row.author)) {
        result.automatedThreads += 1;
      }
    }
    seen += rows.length;
    page += 1;
  }

  return result;
}

async function fetchCommunityData(
  repositories: ImpactRepositoryDefinition[],
  token: string | null,
): Promise<CommunityResult> {
  const byRepository = new Map<string, RepositoryCommunity>();
  let cursor = 0;
  let failures = 0;
  const worker = async () => {
    while (cursor < repositories.length) {
      const repository = repositories[cursor];
      cursor += 1;
      try {
        byRepository.set(
          repository.id,
          await fetchRepositoryCommunity(repository.id, token),
        );
      } catch {
        failures += 1;
      }
    }
  };
  const workerCount = Math.min(8, repositories.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    byRepository,
    status:
      failures === 0 ? "live" : byRepository.size ? "partial" : "unavailable",
  };
}

function aggregateCommunity(
  repositories: ImpactRepositoryDefinition[],
  byRepository: ReadonlyMap<string, RepositoryCommunity>,
): ImpactCommunityEngagement {
  const rows = repositories
    .map((repository) => byRepository.get(repository.id))
    .filter((row): row is RepositoryCommunity => row !== undefined);
  const known = rows.length > 0;
  return {
    likes: repositories.reduce((sum, repository) => sum + repository.likes, 0),
    discussions: known
      ? rows.reduce((sum, row) => sum + row.discussions, 0)
      : null,
    pullRequests: known
      ? rows.reduce((sum, row) => sum + row.pullRequests, 0)
      : null,
    comments: known ? rows.reduce((sum, row) => sum + row.comments, 0) : null,
    automatedThreads: known
      ? rows.reduce((sum, row) => sum + row.automatedThreads, 0)
      : null,
    repositoriesCovered: rows.length,
    repositoriesTotal: repositories.length,
  };
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

function standaloneRepository(
  likes = 0,
  downloads = 0,
): ImpactRepositoryDefinition {
  return {
    id: IMPACT_REPO_ID,
    scope: "standalone",
    private: false,
    position: null,
    lastModified: null,
    likes,
    downloads,
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
    communityStatus: "unavailable",
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

  const initialRepositories = [
    ...collection.repositories,
    standaloneRepository(),
  ];
  const repositoryIds = new Set(
    initialRepositories.map((repository) => repository.id),
  );
  const collectionIds = new Set(
    collection.repositories.map((repository) => repository.id),
  );
  const publisherUrl =
    process.env.TACVERSE_IMPACT_PUBLISHER_ANALYTICS_URL?.trim() ||
    DEFAULT_PUBLISHER_URL;

  const [metadata, advanced, community] = await Promise.all([
    fetchRepositoryMetadata(token),
    advancedData(root, repositoryIds, collectionIds),
    fetchCommunityData(initialRepositories, token),
  ]);
  const repositories = [
    ...collection.repositories,
    standaloneRepository(
      metadata.repository.likes ?? 0,
      metadata.repository.downloads ?? 0,
    ),
  ];
  const communityBySource = {
    collection: aggregateCommunity(
      collection.repositories,
      community.byRepository,
    ),
    opendata: aggregateCommunity(
      repositories.filter((repository) => repository.id === IMPACT_REPO_ID),
      community.byRepository,
    ),
  };

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
        communityBySource,
        communityStatus: community.status,
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
    communityBySource,
    communityStatus: community.status,
  });
  await writeImpactCache(root, data).catch(() => undefined);
  return data;
}

async function refreshCachedPublisherAnalytics(
  root: string,
  cached: TacVerseImpactData,
  token: string,
): Promise<TacVerseImpactData> {
  const repositoryIds = new Set(
    cached.repositories.map((repository) => repository.id),
  );
  const collectionIds = new Set(
    cached.repositories
      .filter((repository) => repository.scope === "collection")
      .map((repository) => repository.id),
  );
  const publisherUrl =
    process.env.TACVERSE_IMPACT_PUBLISHER_ANALYTICS_URL?.trim() ||
    DEFAULT_PUBLISHER_URL;
  const csv = await fetchText(publisherUrl, token, "publisher");
  const data = replacePublisherAnalytics(
    asCached(cached, false),
    parsePublisherAnalytics(csv, repositoryIds),
    {
      collection: parsePublisherAnalytics(csv, collectionIds),
      opendata: parsePublisherAnalytics(csv, new Set([IMPACT_REPO_ID])),
    },
  );
  await writeImpactCache(root, data).catch(() => undefined);
  return data;
}

async function loadPublicImpact(): Promise<TacVerseImpactData> {
  const [collection, metadata] = await Promise.all([
    fetchCollection(null, false),
    fetchRepositoryMetadata(null),
  ]);
  const repositories = await enrichPublicRepositoryDownloads([
    ...collection.repositories,
    standaloneRepository(
      metadata.repository.likes ?? 0,
      metadata.repository.downloads ?? 0,
    ),
  ]);
  const collectionRepositories = repositories.filter(
    (repository) => repository.scope === "collection",
  );
  const opendataRepositories = repositories.filter(
    (repository) => repository.id === IMPACT_REPO_ID,
  );
  const community = await fetchCommunityData(repositories, null);
  const collectionPublisher = publisherSeriesFromRepositoryTotals(
    new Map(
      collectionRepositories.map((repository) => [
        repository.id,
        repository.downloads,
      ]),
    ),
  );
  const opendataPublisher = publisherSeriesFromRepositoryTotals(
    new Map(
      opendataRepositories.map((repository) => [
        repository.id,
        repository.downloads,
      ]),
    ),
  );
  const publisher = publisherSeriesFromRepositoryTotals(
    new Map(
      repositories.map((repository) => [repository.id, repository.downloads]),
    ),
  );

  return buildImpactData({
    accessMode: "public",
    publisher,
    publisherBySource: {
      collection: collectionPublisher,
      opendata: opendataPublisher,
    },
    repositories,
    collection: collection.collection,
    repository: metadata.repository,
    collectionStatus: "live",
    publisherStatus: "live",
    metadataStatus: metadata.status,
    advancedStatus: "not_configured",
    communityBySource: {
      collection: aggregateCommunity(
        collectionRepositories,
        community.byRepository,
      ),
      opendata: aggregateCommunity(
        opendataRepositories,
        community.byRepository,
      ),
    },
    communityStatus: community.status,
  });
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
    "community",
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
  const credential = await resolveHfToken(root);
  const token = projectSecret ?? credential.token;
  const fresh = cached && new Date(cached.expiresAt).valueOf() > Date.now();

  if (!force && fresh) {
    if (!token) return asCached(cached, false);
    try {
      return await refreshCachedPublisherAnalytics(root, cached, token);
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = redactHfSecrets(raw, [
        process.env.HF_TOKEN ?? "",
        projectSecret ?? "",
      ]);
      return asCached(cached, false, message);
    }
  }

  if (!refreshInFlight) {
    refreshInFlight = refresh(root, token).finally(() => {
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

export async function GET(request: NextRequest): Promise<Response> {
  if (request.nextUrl.searchParams.get("scope") === "public") {
    try {
      return json(await loadPublicImpact());
    } catch (error: unknown) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Public Impact data unavailable.",
        },
        500,
      );
    }
  }

  const authorization = await authorizePrivateRequest(request, false);
  if (authorization.denied) return authorization.denied;
  try {
    return json(
      await loadImpact(false),
      200,
      authorization.setCookie
        ? { "set-cookie": authorization.setCookie }
        : undefined,
    );
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
  if (!isSameOriginRequest(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  const authorization = await authorizePrivateRequest(request, true);
  if (authorization.denied) return authorization.denied;
  try {
    return json(
      await loadImpact(true),
      200,
      authorization.setCookie
        ? { "set-cookie": authorization.setCookie }
        : undefined,
    );
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

export async function DELETE(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(request) });
}

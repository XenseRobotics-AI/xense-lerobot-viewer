import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ImpactRepositoryScope,
  ImpactSourceState,
  TacVerseImpactDailyRow,
  TacVerseImpactData,
  TacVerseImpactSourceView,
} from "@/types/tacverse-impact.types";

export const IMPACT_REPO_ID = "TacVerse/opendata" as const;
export const IMPACT_COLLECTION_SLUG = "TacVerse/tacverse" as const;
export const IMPACT_COLLECTION_URL =
  "https://huggingface.co/collections/TacVerse/tacverse";
export const IMPACT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const IMPACT_REQUIRED_PRIVATE_REPOS = [
  "TacVerse/taccap-g1-coil-secure-cable-with-velcro",
  "TacVerse/taccap-g1-cosmetics-are-scanned-and-boxed",
] as const;

type CsvRow = Record<string, string>;

export type ImpactRepositoryDefinition = {
  id: string;
  scope: ImpactRepositoryScope;
  private: boolean;
  position: number | null;
  lastModified: string | null;
};

type PublisherRepositorySeries = {
  daily: Map<string, number>;
  totalDownloads: number;
  reportedTotal: number;
};

export type PublisherSeries = {
  daily: Array<{ date: string; downloads: number }>;
  totalDownloads: number;
  /** The largest upstream total, retained only for reconciliation. */
  cumulativeDownloads: number;
  coverage: { start: string; end: string } | null;
  byRepository: Map<string, PublisherRepositorySeries>;
};

type AdvancedRepositoryAggregation = {
  sessions: number;
  identities: Set<string>;
};

export type AdvancedAggregation = {
  byDate: Map<
    string,
    {
      externalSessions: number;
      developerSessions: number;
      externalUsers: number;
    }
  >;
  byRepository: Map<string, AdvancedRepositoryAggregation>;
  externalSessions: number;
  developerSessions: number;
  externalUsers: number;
  authenticatedIdentifiers: number;
  anonymousIpIdentifiers: number;
  crossRepositoryIdentifiers: number;
  repeatIdentifiers: number;
  coverage: { start: string; end: string } | null;
  geography: TacVerseImpactData["geography"];
};

function csvRecords(input: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      if (row.some((value) => value.trim())) records.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim())) records.push(row);
  return records;
}

export function parseCsv(input: string): CsvRow[] {
  const records = csvRecords(input);
  const headers =
    records
      .shift()
      ?.map((value, index) =>
        (index === 0 ? value.replace(/^\uFEFF/u, "") : value).trim(),
      ) ?? [];
  if (!headers.length) return [];
  return records.map((record) =>
    Object.fromEntries(
      headers.map((header, index) => [header, record[index]?.trim() ?? ""]),
    ),
  );
}

function logRow(value: unknown): CsvRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      field === null || field === undefined ? "" : String(field).trim(),
    ]),
  );
}

export function parseRequestLogs(input: string): CsvRow[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      return Array.isArray(value)
        ? value.map(logRow).filter((row): row is CsvRow => row !== null)
        : [];
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith("{")) {
    const rows: CsvRow[] = [];
    for (const line of trimmed.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const row = logRow(JSON.parse(line) as unknown);
        if (row) rows.push(row);
      } catch {
        return [];
      }
    }
    return rows;
  }
  return parseCsv(input);
}

function utcDate(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/\s*T\s*/iu, "T")
    .replace(/\s*Z$/iu, "Z");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function chinaDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const final = new Date(`${end}T00:00:00Z`);
  while (cursor <= final) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function parsePublisherAnalytics(
  input: string,
  repositoryIds: ReadonlySet<string> = new Set([IMPACT_REPO_ID]),
): PublisherSeries {
  const totals = new Map<string, number>();
  const byRepository = new Map<string, PublisherRepositorySeries>();
  let cumulativeDownloads = 0;

  for (const row of parseCsv(input)) {
    if (row.repoType !== "dataset" || !repositoryIds.has(row.repoName))
      continue;
    const date = utcDate(row.timestamp);
    const downloads = Number(row.downloads);
    if (!date || !Number.isFinite(downloads) || downloads < 0) continue;

    totals.set(date, (totals.get(date) ?? 0) + downloads);
    const repository = byRepository.get(row.repoName) ?? {
      daily: new Map<string, number>(),
      totalDownloads: 0,
      reportedTotal: 0,
    };
    repository.daily.set(date, (repository.daily.get(date) ?? 0) + downloads);
    repository.totalDownloads += downloads;
    const reportedTotal = Number(row.total);
    if (Number.isFinite(reportedTotal) && reportedTotal >= 0) {
      repository.reportedTotal = Math.max(
        repository.reportedTotal,
        reportedTotal,
      );
    }
    byRepository.set(row.repoName, repository);
  }

  cumulativeDownloads = [...byRepository.values()].reduce(
    (sum, row) => sum + row.reportedTotal,
    0,
  );
  const dates = [...totals.keys()].sort();
  const totalDownloads = [...byRepository.values()].reduce(
    (sum, row) => sum + row.totalDownloads,
    0,
  );
  if (!dates.length) {
    return {
      daily: [],
      totalDownloads,
      cumulativeDownloads,
      coverage: null,
      byRepository,
    };
  }
  const completeDates = dateRange(dates[0], dates.at(-1)!);
  return {
    daily: completeDates.map((date) => ({
      date,
      downloads: totals.get(date) ?? 0,
    })),
    totalDownloads,
    cumulativeDownloads,
    coverage: { start: completeDates[0], end: completeDates.at(-1)! },
    byRepository,
  };
}

function identityFor(
  row: CsvRow,
): { key: string; authenticated: boolean } | null {
  if (row.hashedUserId) {
    return { key: `user:${row.hashedUserId}`, authenticated: true };
  }
  if (row.hashedIp) {
    return { key: `ip:${row.hashedIp}`, authenticated: false };
  }
  return null;
}

export function developerHashesFromJson(value: unknown): Set<string> {
  const hashes = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate === "string" && candidate.trim()) {
      hashes.add(candidate.trim());
    }
  };
  if (Array.isArray(value)) {
    value.forEach(add);
    return hashes;
  }
  if (!value || typeof value !== "object") return hashes;
  for (const raw of Object.values(value)) {
    if (Array.isArray(raw)) raw.forEach(add);
    else add(raw);
  }
  return hashes;
}

export function aggregateAdvancedLogs(
  input: string,
  developerHashes: ReadonlySet<string>,
  repositoryIds: ReadonlySet<string> = new Set([IMPACT_REPO_ID]),
): AdvancedAggregation {
  type Event = {
    timestamp: number;
    date: string;
    identity: string;
    authenticated: boolean;
    repoName: string;
    developer: boolean;
    country: string;
  };

  const events: Event[] = [];
  for (const row of parseRequestLogs(input)) {
    if (row.repoType !== "dataset" || !repositoryIds.has(row.repoName))
      continue;
    if (row.method !== "GET" && row.method !== "HEAD") continue;
    if (row.status !== "200" && row.status !== "206") continue;
    const timestamp = new Date(row.timestamp).valueOf();
    const identity = identityFor(row);
    if (!identity || !Number.isFinite(timestamp)) continue;
    events.push({
      timestamp,
      date: chinaDate(timestamp),
      identity: identity.key,
      authenticated: identity.authenticated,
      repoName: row.repoName,
      developer:
        identity.authenticated && developerHashes.has(row.hashedUserId),
      country: row.country?.trim().toUpperCase() || "ZZ",
    });
  }
  events.sort((a, b) => a.timestamp - b.timestamp);

  const byDate = new Map<
    string,
    {
      externalSessions: number;
      developerSessions: number;
      externalUsers: number;
    }
  >();
  const byRepository = new Map<string, AdvancedRepositoryAggregation>();
  const externalUsers = new Set<string>();
  const authenticatedIdentifiers = new Set<string>();
  const anonymousIpIdentifiers = new Set<string>();
  const dailyUsers = new Map<string, Set<string>>();
  const repositoriesByIdentity = new Map<string, Set<string>>();
  const lastByIdentityAndRepo = new Map<string, number>();
  const sessionsByIdentity = new Map<string, number>();
  const countries = new Map<string, { sessions: number; users: Set<string> }>();
  let externalSessions = 0;
  let developerSessions = 0;

  for (const event of events) {
    if (!event.developer) {
      externalUsers.add(event.identity);
      (event.authenticated
        ? authenticatedIdentifiers
        : anonymousIpIdentifiers
      ).add(event.identity);
      const daily = dailyUsers.get(event.date) ?? new Set<string>();
      daily.add(event.identity);
      dailyUsers.set(event.date, daily);
      const repositories =
        repositoriesByIdentity.get(event.identity) ?? new Set<string>();
      repositories.add(event.repoName);
      repositoriesByIdentity.set(event.identity, repositories);
    }

    const sessionKey = `${event.identity}\0${event.repoName}`;
    const previous = lastByIdentityAndRepo.get(sessionKey);
    lastByIdentityAndRepo.set(sessionKey, event.timestamp);
    if (previous !== undefined && event.timestamp - previous < 5 * 60 * 1000) {
      continue;
    }

    const current = byDate.get(event.date) ?? {
      externalSessions: 0,
      developerSessions: 0,
      externalUsers: 0,
    };
    if (event.developer) {
      current.developerSessions += 1;
      developerSessions += 1;
    } else {
      current.externalSessions += 1;
      externalSessions += 1;
      sessionsByIdentity.set(
        event.identity,
        (sessionsByIdentity.get(event.identity) ?? 0) + 1,
      );
      const repository = byRepository.get(event.repoName) ?? {
        sessions: 0,
        identities: new Set<string>(),
      };
      repository.sessions += 1;
      repository.identities.add(event.identity);
      byRepository.set(event.repoName, repository);

      const country = countries.get(event.country) ?? {
        sessions: 0,
        users: new Set<string>(),
      };
      country.sessions += 1;
      country.users.add(event.identity);
      countries.set(event.country, country);
    }
    byDate.set(event.date, current);
  }

  for (const [date, users] of dailyUsers) {
    const current = byDate.get(date) ?? {
      externalSessions: 0,
      developerSessions: 0,
      externalUsers: 0,
    };
    current.externalUsers = users.size;
    byDate.set(date, current);
  }

  const dates = events.map((event) => event.date).sort();
  return {
    byDate,
    byRepository,
    externalSessions,
    developerSessions,
    externalUsers: externalUsers.size,
    authenticatedIdentifiers: authenticatedIdentifiers.size,
    anonymousIpIdentifiers: anonymousIpIdentifiers.size,
    crossRepositoryIdentifiers: [...repositoriesByIdentity.values()].filter(
      (repositories) => repositories.size > 1,
    ).length,
    repeatIdentifiers: [...sessionsByIdentity.values()].filter(
      (sessions) => sessions > 1,
    ).length,
    coverage: dates.length ? { start: dates[0], end: dates.at(-1)! } : null,
    geography: [...countries.entries()]
      .map(([country, value]) => ({
        country,
        sessions: value.sessions,
        users: value.users.size,
      }))
      .sort(
        (a, b) => b.sessions - a.sessions || a.country.localeCompare(b.country),
      ),
  };
}

function sumTail(values: number[], count: number): number {
  return values.slice(-count).reduce((sum, value) => sum + value, 0);
}

function repositoryWindow(
  series: PublisherRepositorySeries | undefined,
  days: number,
): number {
  if (!series?.daily.size) return 0;
  return [...series.daily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-days)
    .reduce((sum, [, downloads]) => sum + downloads, 0);
}

function impactDailyRows(publisher: PublisherSeries): TacVerseImpactDailyRow[] {
  const values = publisher.daily.map((row) => row.downloads);
  let runningTotal = 0;
  return publisher.daily.map((row, index) => {
    runningTotal += row.downloads;
    return {
      date: row.date,
      totalDownloads: row.downloads,
      cumulativeDownloads: runningTotal,
      externalSessions: null,
      developerSessions: null,
      externalUsers: null,
      rolling7Average:
        values
          .slice(Math.max(0, index - 6), index + 1)
          .reduce((sum, value) => sum + value, 0) / Math.min(7, index + 1),
    };
  });
}

function buildSourceView(
  publisher: PublisherSeries,
  advanced: AdvancedAggregation | null,
): TacVerseImpactSourceView {
  const values = publisher.daily.map((row) => row.downloads);
  return {
    metrics: {
      totalDownloads: publisher.totalDownloads,
      last30Days: sumTail(values, 30),
      last7Days: sumTail(values, 7),
      dailyAverage7:
        sumTail(values, 7) / Math.min(7, Math.max(1, values.length)),
      externalSessions: advanced?.externalSessions ?? null,
      externalUsers: advanced?.externalUsers ?? null,
      authenticatedIdentifiers: advanced?.authenticatedIdentifiers ?? null,
      anonymousIpIdentifiers: advanced?.anonymousIpIdentifiers ?? null,
      crossRepositoryIdentifiers: advanced?.crossRepositoryIdentifiers ?? null,
      repeatIdentifiers: advanced?.repeatIdentifiers ?? null,
      developerSessions: advanced?.developerSessions ?? null,
    },
    daily: impactDailyRows(publisher),
    advancedDaily: advanced
      ? [...advanced.byDate.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([date, row]) => ({
            date,
            externalSessions: row.externalSessions,
            developerSessions: row.developerSessions,
            anonymousIdentifiers: row.externalUsers,
          }))
      : [],
    coverage: {
      total: publisher.coverage,
      advancedLog: advanced?.coverage ?? null,
    },
    geography: advanced?.geography ?? [],
  };
}

export function buildImpactData(options: {
  publisher: PublisherSeries;
  publisherBySource?: {
    collection: PublisherSeries;
    opendata: PublisherSeries;
  };
  repositories?: ImpactRepositoryDefinition[];
  collection?: Partial<TacVerseImpactData["collection"]>;
  advanced?: AdvancedAggregation | null;
  advancedBySource?: {
    collection: AdvancedAggregation | null;
    opendata: AdvancedAggregation | null;
  };
  repository?: Partial<TacVerseImpactData["repository"]>;
  collectionStatus?: ImpactSourceState;
  publisherStatus?: ImpactSourceState;
  advancedStatus?: ImpactSourceState;
  metadataStatus?: ImpactSourceState;
  message?: string | null;
  now?: Date;
}): TacVerseImpactData {
  const now = options.now ?? new Date();
  const definitions = options.repositories ?? [
    {
      id: IMPACT_REPO_ID,
      scope: "standalone" as const,
      private: false,
      position: null,
      lastModified: null,
    },
  ];
  const values = options.publisher.daily.map((row) => row.downloads);
  const daily = impactDailyRows(options.publisher);
  const emptyPublisher = parsePublisherAnalytics("");
  const publisherBySource = options.publisherBySource ?? {
    collection: emptyPublisher,
    opendata: options.publisher,
  };
  const advancedBySource = options.advancedBySource ?? {
    collection: null,
    opendata: options.advanced ?? null,
  };

  const repositories = definitions
    .map((definition) => {
      const publisher = options.publisher.byRepository.get(definition.id);
      const advanced = options.advanced?.byRepository.get(definition.id);
      return {
        ...definition,
        url: `https://huggingface.co/datasets/${definition.id}`,
        downloads: publisher?.totalDownloads ?? 0,
        last30Days: repositoryWindow(publisher, 30),
        last7Days: repositoryWindow(publisher, 7),
        externalSessions: options.advanced ? (advanced?.sessions ?? 0) : null,
        anonymousIdentifiers: options.advanced
          ? (advanced?.identities.size ?? 0)
          : null,
      };
    })
    .sort(
      (a, b) =>
        b.downloads - a.downloads ||
        (a.position ?? Number.MAX_SAFE_INTEGER) -
          (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );

  const totalDownloads = values.reduce((sum, value) => sum + value, 0);
  const collectionDownloads = repositories
    .filter((repository) => repository.scope === "collection")
    .reduce((sum, repository) => sum + repository.downloads, 0);
  const opendataDownloads =
    repositories.find((repository) => repository.id === IMPACT_REPO_ID)
      ?.downloads ?? 0;
  const refreshedAt = now.toISOString();

  return {
    schemaVersion: 4,
    collection: {
      slug: options.collection?.slug ?? IMPACT_COLLECTION_SLUG,
      title: options.collection?.title ?? "TacVerse",
      url: options.collection?.url ?? IMPACT_COLLECTION_URL,
      description: options.collection?.description ?? null,
      lastModified: options.collection?.lastModified ?? null,
      datasetCount:
        options.collection?.datasetCount ??
        definitions.filter((repository) => repository.scope === "collection")
          .length,
      publicDatasetCount: options.collection?.publicDatasetCount ?? 0,
      privateDatasetCount: options.collection?.privateDatasetCount ?? 0,
      requiredPrivateReposVisible:
        options.collection?.requiredPrivateReposVisible ?? false,
    },
    repository: {
      id: IMPACT_REPO_ID,
      url: `https://huggingface.co/datasets/${IMPACT_REPO_ID}`,
      subdatasetCount: options.repository?.subdatasetCount ?? null,
      storageBytes: options.repository?.storageBytes ?? null,
      lastModified: options.repository?.lastModified ?? null,
    },
    repositories,
    metrics: {
      totalDownloads,
      collectionDownloads,
      opendataDownloads,
      cumulativeDownloads: totalDownloads,
      last30Days: sumTail(values, 30),
      last7Days: sumTail(values, 7),
      dailyAverage7:
        sumTail(values, 7) / Math.min(7, Math.max(1, values.length)),
      externalSessions: options.advanced?.externalSessions ?? null,
      externalUsers: options.advanced?.externalUsers ?? null,
      authenticatedIdentifiers:
        options.advanced?.authenticatedIdentifiers ?? null,
      anonymousIpIdentifiers: options.advanced?.anonymousIpIdentifiers ?? null,
      crossRepositoryIdentifiers:
        options.advanced?.crossRepositoryIdentifiers ?? null,
      repeatIdentifiers: options.advanced?.repeatIdentifiers ?? null,
      developerSessions: options.advanced?.developerSessions ?? null,
    },
    daily,
    sourceViews: {
      collection: buildSourceView(
        publisherBySource.collection,
        advancedBySource.collection,
      ),
      opendata: buildSourceView(
        publisherBySource.opendata,
        advancedBySource.opendata,
      ),
    },
    advancedDaily: options.advanced
      ? [...options.advanced.byDate.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([date, row]) => ({
            date,
            externalSessions: row.externalSessions,
            developerSessions: row.developerSessions,
            anonymousIdentifiers: row.externalUsers,
          }))
      : [],
    coverage: {
      total: options.publisher.coverage,
      advancedLog: options.advanced?.coverage ?? null,
    },
    sourceStatus: {
      collection: options.collectionStatus ?? "live",
      publisherAnalytics: options.publisherStatus ?? "live",
      advancedLog:
        options.advancedStatus ??
        (options.advanced ? "live" : "not_configured"),
      metadata: options.metadataStatus ?? "live",
      cache: "miss",
      message: options.message ?? null,
    },
    geography: options.advanced?.geography ?? [],
    refreshedAt,
    expiresAt: new Date(now.valueOf() + IMPACT_CACHE_TTL_MS).toISOString(),
  };
}

export function impactCachePath(root: string): string {
  return path.join(
    root,
    ".xense-viewer",
    "tacverse-impact",
    "collection-summary.json",
  );
}

export async function readImpactCache(
  root: string,
): Promise<TacVerseImpactData | null> {
  try {
    const data = JSON.parse(
      await fs.readFile(impactCachePath(root), "utf8"),
    ) as TacVerseImpactData;
    return data.schemaVersion === 4 ? data : null;
  } catch {
    return null;
  }
}

export async function writeImpactCache(
  root: string,
  data: TacVerseImpactData,
): Promise<void> {
  const destination = impactCachePath(root);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function readDeveloperHashes(root: string): Promise<Set<string>> {
  try {
    const file = path.join(
      root,
      ".xense-viewer",
      "tacverse-impact",
      "internal-hashes.json",
    );
    return developerHashesFromJson(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return new Set();
  }
}

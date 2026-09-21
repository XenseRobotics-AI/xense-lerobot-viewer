export type ImpactSourceState =
  | "live"
  | "cache"
  | "stale"
  | "partial"
  | "not_configured"
  | "unauthorized"
  | "unavailable";

export type DateCoverage = {
  start: string;
  end: string;
};

export type ImpactRepositoryScope = "collection" | "standalone";
export type ImpactDataSource = "collection" | "opendata";

export type ImpactCommunityEngagement = {
  likes: number | null;
  discussions: number | null;
  pullRequests: number | null;
  comments: number | null;
  automatedThreads: number | null;
  repositoriesCovered: number;
  repositoriesTotal: number;
};

export type TacVerseImpactRepository = {
  id: string;
  url: string;
  scope: ImpactRepositoryScope;
  private: boolean;
  position: number | null;
  lastModified: string | null;
  likes: number;
  downloads: number;
  last30Days: number;
  last7Days: number;
  externalSessions: number | null;
  anonymousIdentifiers: number | null;
};

export type TacVerseImpactDailyRow = {
  /** Hugging Face Publisher Analytics UTC bucket date. */
  date: string;
  totalDownloads: number;
  /** Visible-history running sum. Kept for cached-data compatibility. */
  cumulativeDownloads: number;
  externalSessions: number | null;
  developerSessions: number | null;
  externalUsers: number | null;
  rolling7Average: number;
};

export type TacVerseImpactSourceView = {
  metrics: {
    totalDownloads: number;
    last30Days: number;
    last7Days: number;
    dailyAverage7: number;
    externalSessions: number | null;
    externalUsers: number | null;
    authenticatedIdentifiers: number | null;
    anonymousIpIdentifiers: number | null;
    crossRepositoryIdentifiers: number | null;
    repeatIdentifiers: number | null;
    developerSessions: number | null;
  };
  daily: TacVerseImpactDailyRow[];
  advancedDaily: Array<{
    date: string;
    externalSessions: number;
    developerSessions: number;
    anonymousIdentifiers: number;
  }>;
  coverage: {
    total: DateCoverage | null;
    advancedLog: DateCoverage | null;
  };
  geography: Array<{
    country: string;
    sessions: number;
    users: number;
  }>;
  community: ImpactCommunityEngagement;
};

export type TacVerseImpactData = {
  schemaVersion: 6;
  accessMode: "private" | "public";
  collection: {
    slug: string;
    title: string;
    url: string;
    description: string | null;
    lastModified: string | null;
    datasetCount: number;
    publicDatasetCount: number;
    privateDatasetCount: number;
    requiredPrivateReposVisible: boolean;
  };
  /** Legacy standalone repository retained alongside the Collection. */
  repository: {
    id: "TacVerse/opendata";
    url: string;
    subdatasetCount: number | null;
    storageBytes: number | null;
    lastModified: string | null;
    likes: number | null;
    downloads: number | null;
  };
  repositories: TacVerseImpactRepository[];
  metrics: {
    totalDownloads: number;
    collectionDownloads: number;
    opendataDownloads: number;
    /** Compatibility alias. The UI labels totalDownloads as Downloads. */
    cumulativeDownloads: number;
    last30Days: number;
    last7Days: number;
    dailyAverage7: number;
    externalSessions: number | null;
    externalUsers: number | null;
    authenticatedIdentifiers: number | null;
    anonymousIpIdentifiers: number | null;
    crossRepositoryIdentifiers: number | null;
    repeatIdentifiers: number | null;
    developerSessions: number | null;
  };
  daily: TacVerseImpactDailyRow[];
  sourceViews: Record<ImpactDataSource, TacVerseImpactSourceView>;
  advancedDaily: Array<{
    date: string;
    externalSessions: number;
    developerSessions: number;
    anonymousIdentifiers: number;
  }>;
  coverage: {
    total: DateCoverage | null;
    advancedLog: DateCoverage | null;
  };
  sourceStatus: {
    collection: ImpactSourceState;
    publisherAnalytics: ImpactSourceState;
    advancedLog: ImpactSourceState;
    community: ImpactSourceState;
    metadata: ImpactSourceState;
    cache: "miss" | "fresh" | "stale";
    message: string | null;
  };
  geography: Array<{
    country: string;
    sessions: number;
    users: number;
  }>;
  refreshedAt: string;
  expiresAt: string;
};

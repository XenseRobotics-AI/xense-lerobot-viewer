"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FiExternalLink, FiInfo, FiLock, FiRefreshCw } from "react-icons/fi";
import { useLocale } from "@/context/locale-context";
import { formatBytes } from "@/utils/byteSize";
import type {
  ImpactDataSource,
  ImpactSourceState,
  TacVerseImpactData,
} from "@/types/tacverse-impact.types";

type WindowSize = 7 | 30 | 90 | "all";

const COPY = {
  en: {
    eyebrow: "PRIVATE COLLECTION ANALYTICS",
    title: "TacVerse Impact",
    subtitle:
      "Publisher Analytics for the private TacVerse Collection plus TacVerse/opendata.",
    publicEyebrow: "PUBLIC DATASET ANALYTICS",
    publicSubtitle:
      "Public Hugging Face metadata for the TacVerse Collection and TacVerse/opendata.",
    publicModeTitle: "Public-only mode",
    publicModeBody:
      "Anonymous Hugging Face APIs provide only current lifetime Downloads, public repository metadata, and Community activity. They do not provide Publisher Analytics daily history, private datasets, or Enterprise logs.",
    publicDownloadsHint:
      "Current lifetime total reported by the public HF API.",
    publicMetadataSource: "Public HF metadata",
    dataSource: "Data source",
    collectionChoice: "TacVerse Collection",
    opendataChoice: "TacVerse/opendata",
    selectedDatasets: "Datasets in source",
    collectionRankingHint: "Datasets in the current private Collection.",
    opendataRankingHint: "The standalone TacVerse/opendata repository.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    downloads: "Downloads",
    totalDownloads: "Total downloads",
    todayDownloads: "Current HF day",
    dayOverDayInProgress: "HF has published this still-open UTC day",
    dayOverDayWaiting: "HF has not published this UTC day yet",
    publisherTimingTitle: "Publisher reporting window",
    publisherTimingCurrent:
      "Current HF day: {date} · China Standard Time {start} 08:00 → {end} 08:00.",
    publisherTimingPublished:
      "Latest day published by HF: {date} · China Standard Time {start} 08:00 → {end} 08:00.",
    publisherTimingEmpty:
      "HF has not published any daily rows for this source.",
    publisherTimingWaiting:
      "This reporting window closes at {end} 08:00 China Standard Time. HF does not guarantee a publication time, so a reliable update countdown is unavailable; Refresh checks upstream immediately.",
    publisherTimingAvailable:
      "HF has published the current, incomplete window. Its value can continue changing until the window closes at {end} 08:00 China Standard Time.",
    publisherTimingNaturalDay:
      "Publisher daily rows are UTC buckets, not China calendar days. Exact 00:00–24:00 China-day reporting requires the Enterprise request-level log export.",
    downloadsDefinition: "How HF counts Downloads",
    downloadsDefinitionIntro:
      "HF combines file requests from the same IP in the same dataset repository within a five-minute window into one dataset download.",
    downloadsDefinitionRepeat:
      "The same person can be counted again after five minutes or when using another IP or device.",
    downloadsDefinitionLimits:
      "Downloads are not deduplicated across days, IPs, or devices and must not be interpreted as a user count.",
    datasetDownloadRules: "HF dataset download counting rules",
    publisherAnalyticsRules: "Publisher Analytics documentation",
    collectionDownloads: "Collection downloads",
    opendataDownloads: "opendata downloads",
    last30: "Last 30 HF days",
    last7: "Last 7 HF days",
    average7: "7-day daily average",
    externalSessions: "Download sessions",
    uniqueDownloaders: "Unique downloaders",
    uniqueDownloaderHint:
      "Distinct hashed account IDs or anonymous IP hashes during the log coverage period.",
    anonymousIdentifiers: "Anonymous identifiers",
    authenticatedIdentifiers: "Signed-in hashes",
    anonymousIpIdentifiers: "Anonymous IP hashes",
    crossRepository: "Cross-repository users",
    repeatDownloaders: "Repeat downloaders",
    countriesReached: "Countries / regions reached",
    community: "Community engagement",
    communityHint:
      "HF Likes and Community activity for repositories in the selected source. Counts may include automated accounts.",
    likes: "Likes",
    discussions: "Discussions",
    pullRequests: "Pull requests",
    comments: "Comments",
    automatedThreads: "Automated threads",
    repositoryCoverage: "Repository coverage",
    advancedMissing:
      "Add the Enterprise Plus request-log export at .xense-viewer/tacverse-impact/request-logs.csv",
    advancedSetupTitle: "Unique-downloader data is waiting for its log export",
    advancedSetupBody:
      "Ask Hugging Face Enterprise support to provision the anonymized request-level export, then place the delivered file at .xense-viewer/tacverse-impact/request-logs.csv.",
    learnMore: "Official setup details",
    exactSince: "Exact since {date}",
    downloaderTrend: "Downloader impact trend",
    downloaderTrendHint:
      "China-day unique anonymous identifiers and five-minute download sessions from Enterprise Plus request logs.",
    dailyUniqueDownloaders: "Daily unique downloaders",
    downloadTrend: "Download trend",
    downloadTrendHint:
      "Publisher daily downloads, including the current incomplete UTC day as soon as HF publishes it. Each HF UTC day spans 08:00–08:00 China Standard Time.",
    publicDownloadChart: "Public download overview",
    publicDownloadChartHint:
      "Current all-time Downloads for each public dataset. Daily history requires Publisher Analytics access.",
    cumulativeDownloads: "All-time Downloads",
    daily: "Daily downloads",
    rolling: "7-day average",
    all: "All",
    ranking: "Dataset popularity",
    rankingHint:
      "Current Collection members plus the standalone opendata repository.",
    dataset: "Dataset",
    scope: "Scope",
    private: "Private",
    public: "Public",
    collectionScope: "Collection",
    standaloneScope: "Standalone",
    sessions: "Sessions",
    identifiers: "Identifiers",
    geography: "Country / region",
    country: "Country",
    users: "Identifiers",
    table: "Daily detail",
    date: "HF day (CST 08:00 → next day 08:00)",
    total: "Downloads",
    devSessions: "Internal sessions",
    collection: "Collection",
    datasets: "Datasets",
    publicDatasets: "Public datasets",
    privateDatasets: "Private datasets",
    opendata: "TacVerse/opendata",
    subdatasets: "Root sub-datasets",
    storage: "Storage",
    modified: "Last updated",
    open: "Open on Hugging Face",
    status: "Data status",
    refreshed: "Refreshed",
    coverage: "Publisher history",
    logCoverage: "Enterprise-log history (CST)",
    cache: "Cache",
    publisher: "Publisher Analytics",
    advanced: "Enterprise logs",
    collectionSource: "Private Collection",
    communitySource: "HF Community",
    loading: "Loading private analytics…",
    emptyTitle: "No Publisher Analytics history is available.",
    permission:
      "The Hugging Face credential cannot read the complete private Collection or Publisher Analytics.",
    incomplete:
      "Private Collection completeness check failed. Partial public results are not displayed.",
    stale:
      "The latest refresh failed. Showing the last complete cached snapshot.",
    error: "Unable to load TacVerse Impact data.",
    unlockTitle: "Unlock private analytics",
    unlockHint:
      "Private analytics use the same Hugging Face credential as Workbench data pulls. If no token is configured yet, enter one here and it will be saved to the shared project credential store.",
    accessKey: "Hugging Face access token",
    unlock: "Save shared token and unlock",
    useExisting: "Use existing data-pull credential",
    publicOnly: "View public datasets",
    publicOnlyHint:
      "No token required. Includes lifetime Downloads, public metadata, and Community activity only; daily history is unavailable.",
    accessNotConfigured:
      "Save a Hugging Face token in Workbench data pull settings, or enter one here.",
    accessSetupCommand:
      "TACVERSE_IMPACT_ACCESS_KEY=<a separate random value> bun dev",
    hfTokenSetup: "Shared project credential: .xense-viewer/secrets/hf-token.",
    accessDenied:
      "This HF token cannot read the required private TacVerse datasets.",
    lock: "Lock",
    source_live: "Live",
    source_cache: "Cached",
    source_stale: "Stale cache",
    source_partial: "Partial",
    source_not_configured: "Not configured",
    source_unauthorized: "No permission",
    source_unavailable: "Unavailable",
    cache_miss: "Live response",
    cache_fresh: "Fresh · 6-hour TTL",
    cache_stale: "Expired fallback",
  },
  zh: {
    eyebrow: "私有 COLLECTION 分析",
    title: "TacVerse Impact",
    subtitle: "统计私有 TacVerse Collection，并额外纳入 TacVerse/opendata。",
    publicEyebrow: "公开数据集分析",
    publicSubtitle:
      "通过 Hugging Face 公开接口统计 TacVerse Collection 与 TacVerse/opendata。",
    publicModeTitle: "仅公开数据模式",
    publicModeBody:
      "匿名 Hugging Face API 仅提供当前累计 Downloads、公开仓库元数据和社区数据，不提供 Publisher Analytics 逐日历史，也不访问私有数据集或 Enterprise 日志。",
    publicDownloadsHint: "HF 公开接口当前提供的累计下载总数。",
    publicMetadataSource: "HF 公开元数据",
    dataSource: "数据来源",
    collectionChoice: "TacVerse Collection",
    opendataChoice: "TacVerse/opendata",
    selectedDatasets: "当前来源数据集",
    collectionRankingHint: "当前私有 Collection 中的数据集。",
    opendataRankingHint: "独立的 TacVerse/opendata 仓库。",
    refresh: "刷新",
    refreshing: "刷新中…",
    downloads: "Downloads",
    totalDownloads: "总下载量",
    todayDownloads: "当前 HF 统计日",
    dayOverDayInProgress: "HF 已发布这个尚未结束的 UTC 统计日",
    dayOverDayWaiting: "HF 尚未发布当前 UTC 统计日",
    publisherTimingTitle: "Publisher 统计时间说明",
    publisherTimingCurrent:
      "当前 HF 统计日：{date} · 北京时间 {start} 08:00 → {end} 08:00。",
    publisherTimingPublished:
      "HF 最新已发布：{date} · 北京时间 {start} 08:00 → {end} 08:00。",
    publisherTimingEmpty: "HF 尚未为当前来源发布任何逐日数据。",
    publisherTimingWaiting:
      "本统计窗口将在北京时间 {end} 08:00 结束。HF 没有承诺固定发布时间，因此无法提供可靠的更新倒计时；点击“刷新”会立即重新检查上游。",
    publisherTimingAvailable:
      "HF 已发布当前尚未结束的统计窗口；数值仍可能变化，窗口将在北京时间 {end} 08:00 结束。",
    publisherTimingNaturalDay:
      "Publisher 逐日数据是 UTC 分桶，不是北京时间自然日。若要精确统计北京时间 00:00–24:00，必须配置 Enterprise 请求级日志导出。",
    downloadsDefinition: "HF 如何计算 Downloads",
    downloadsDefinitionIntro:
      "HF 会把同一 IP 在同一数据集仓库五分钟内产生的多个文件请求合并成一次 dataset download。",
    downloadsDefinitionRepeat:
      "同一人在五分钟后再次下载，或者更换 IP、设备后，仍可能再次计数。",
    downloadsDefinitionLimits:
      "Downloads 没有跨天、跨 IP、跨设备进行用户去重，不能直接解释为使用人数。",
    datasetDownloadRules: "HF 数据集下载统计规则",
    publisherAnalyticsRules: "Publisher Analytics 官方说明",
    collectionDownloads: "Collection 下载",
    opendataDownloads: "opendata 下载",
    last30: "最近 30 个 HF 统计日",
    last7: "最近 7 个 HF 统计日",
    average7: "7 日日均",
    externalSessions: "下载会话",
    uniqueDownloaders: "唯一使用者",
    uniqueDownloaderHint:
      "在日志覆盖期内，按已登录账号哈希或匿名 IP 哈希统计唯一标识。",
    anonymousIdentifiers: "匿名标识",
    authenticatedIdentifiers: "已登录账号哈希",
    anonymousIpIdentifiers: "匿名 IP 哈希",
    crossRepository: "跨仓库使用者",
    repeatDownloaders: "重复使用者",
    countriesReached: "有效下载覆盖国家 / 地区",
    community: "社区参与度",
    communityHint:
      "统计当前数据来源下各仓库的 HF Likes 与 Community 活动，可能包含自动化账号。",
    likes: "Likes",
    discussions: "Discussion",
    pullRequests: "PR",
    comments: "评论",
    automatedThreads: "自动化主题",
    repositoryCoverage: "仓库覆盖",
    advancedMissing:
      "请将 Enterprise Plus 请求日志放到 .xense-viewer/tacverse-impact/request-logs.csv",
    advancedSetupTitle: "唯一使用者统计正在等待请求日志",
    advancedSetupBody:
      "请联系 Hugging Face Enterprise 支持开通匿名请求级日志导出，再将交付的文件放到 .xense-viewer/tacverse-impact/request-logs.csv。",
    learnMore: "查看官方配置说明",
    exactSince: "精确统计自 {date}",
    downloaderTrend: "使用人数与影响力趋势",
    downloaderTrendHint:
      "按北京时间自然日统计匿名唯一标识和五分钟下载会话，数据来自 Enterprise Plus 请求日志。",
    dailyUniqueDownloaders: "每日唯一使用者",
    downloadTrend: "下载趋势",
    downloadTrendHint:
      "Publisher 每日 downloads；HF 一旦发布当天数据，即使 UTC 统计日尚未结束也会计入。每个 HF UTC 日对应北京时间 08:00 至次日 08:00。",
    publicDownloadChart: "公开下载量概览",
    publicDownloadChartHint:
      "展示各公开数据集当前的累计 Downloads；每日历史趋势需要 Publisher Analytics 权限。",
    cumulativeDownloads: "累计 Downloads",
    daily: "每日下载",
    rolling: "7 日均线",
    all: "全部",
    ranking: "数据集热度排行",
    rankingHint: "当前 Collection 成员，并额外包含独立的 opendata 仓库。",
    dataset: "数据集",
    scope: "范围",
    private: "私有",
    public: "公开",
    collectionScope: "Collection",
    standaloneScope: "独立仓库",
    sessions: "会话",
    identifiers: "匿名标识",
    geography: "国家 / 地区",
    country: "国家 / 地区",
    users: "匿名标识",
    table: "每日明细",
    date: "HF 统计日（北京时间 08:00 → 次日 08:00）",
    total: "Downloads",
    devSessions: "内部会话",
    collection: "Collection",
    datasets: "数据集",
    publicDatasets: "公开数据集",
    privateDatasets: "私有数据集",
    opendata: "TacVerse/opendata",
    subdatasets: "根目录子数据集",
    storage: "存储量",
    modified: "最后更新时间",
    open: "在 Hugging Face 打开",
    status: "数据状态",
    refreshed: "数据更新时间",
    coverage: "Publisher 历史覆盖",
    logCoverage: "Enterprise 日志覆盖（北京时间）",
    cache: "缓存",
    publisher: "Publisher Analytics",
    advanced: "Enterprise 日志",
    collectionSource: "私有 Collection",
    communitySource: "HF Community",
    loading: "正在加载私有统计…",
    emptyTitle: "暂无 Publisher Analytics 下载历史。",
    permission:
      "当前 Hugging Face 凭据无法读取完整私有 Collection 或 Publisher Analytics。",
    incomplete: "私有 Collection 完整性检查失败，不展示不完整的公开部分。",
    stale: "最新刷新失败，当前展示上一次完整缓存。",
    error: "无法加载 TacVerse Impact 数据。",
    unlockTitle: "解锁私有统计",
    unlockHint:
      "私有统计使用与 Workbench 数据拉取相同的 Hugging Face 凭据。若尚未配置 token，可在这里输入，验证后会保存到本工程共享凭据。",
    accessKey: "Hugging Face access token",
    unlock: "保存共享令牌并进入",
    useExisting: "使用已有数据拉取配置进入",
    publicOnly: "直接查看公开数据集",
    publicOnlyHint:
      "无需令牌；仅提供累计 Downloads、公开元数据和社区数据，不提供逐日历史。",
    accessNotConfigured:
      "请先在 Workbench 数据拉取中保存 Hugging Face token，或直接在这里输入。",
    accessSetupCommand: "TACVERSE_IMPACT_ACCESS_KEY=<另一条随机密钥> bun dev",
    hfTokenSetup: "工程共享凭据路径：.xense-viewer/secrets/hf-token。",
    accessDenied: "此 HF token 无法读取要求的 TacVerse 私有数据集。",
    lock: "锁定",
    source_live: "实时",
    source_cache: "缓存",
    source_stale: "过期缓存",
    source_partial: "部分可用",
    source_not_configured: "未配置",
    source_unauthorized: "无权限",
    source_unavailable: "不可用",
    cache_miss: "实时响应",
    cache_fresh: "有效 · 6 小时 TTL",
    cache_stale: "过期回退",
  },
} as const;

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatAddedInteger(value: number): string {
  return `+${formatInteger(value)}`;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function interpolate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    template,
  );
}

function coverageLabel(
  coverage: { start: string; end: string } | null,
  locale: string,
): string {
  return coverage
    ? `${formatDate(coverage.start, locale)} – ${formatDate(coverage.end, locale)}`
    : "—";
}

function MetricCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="panel-raised relative min-h-32 p-4">
      <p className="pr-8 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-slate-100 tabular">
        {value}
      </p>
      {note && (
        <span className="group/note absolute right-3 top-3 z-20">
          <button
            type="button"
            aria-label={note}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-white/10 text-[10px] text-slate-600 transition hover:border-cyan-400/30 hover:text-cyan-300 focus:border-cyan-400/40 focus:text-cyan-300 focus:outline-none"
          >
            <FiInfo />
          </button>
          <span
            role="tooltip"
            className="pointer-events-none absolute right-0 top-7 hidden w-64 rounded-md border border-white/10 bg-[#11172a] px-3 py-2 text-[11px] font-normal normal-case leading-5 tracking-normal text-slate-300 shadow-xl group-hover/note:block group-focus-within/note:block"
          >
            {note}
          </span>
        </span>
      )}
    </div>
  );
}

function StatusPill({
  state,
  label,
}: {
  state: ImpactSourceState;
  label: string;
}) {
  const tone =
    state === "live"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
      : state === "cache"
        ? "border-cyan-400/25 bg-cyan-400/10 text-cyan-300"
        : state === "stale" || state === "partial" || state === "unauthorized"
          ? "border-amber-400/25 bg-amber-400/10 text-amber-300"
          : "border-white/10 bg-white/[0.03] text-slate-400";
  return (
    <span className={`rounded-full border px-2 py-1 text-[10px] ${tone}`}>
      {label}
    </span>
  );
}

export default function TacVerseImpactPanel() {
  const { locale } = useLocale();
  const c = COPY[locale];
  const [data, setData] = useState<TacVerseImpactData | null>(null);
  const [candidateKey, setCandidateKey] = useState("");
  const [locked, setLocked] = useState(true);
  const [hasExistingCredential, setHasExistingCredential] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [windowSize, setWindowSize] = useState<WindowSize>("all");
  const [dataSource, setDataSource] = useState<ImpactDataSource>("collection");

  const load = useCallback(
    async (
      key = "",
      refresh = false,
      publicOnly = false,
      silentDenied = false,
    ) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const shouldPost = !publicOnly && (refresh || Boolean(key));
        const response = await fetch(
          publicOnly
            ? "/api/tacverse-impact?scope=public"
            : "/api/tacverse-impact",
          {
            method: shouldPost ? "POST" : "GET",
            credentials: "same-origin",
            headers: {
              ...(key ? { "x-tacverse-impact-key": key } : {}),
              ...(shouldPost ? { "content-type": "application/json" } : {}),
            },
            body: shouldPost ? "{}" : undefined,
          },
        );
        const payload = (await response.json()) as
          | TacVerseImpactData
          | { error?: string; code?: string; hasCredential?: boolean };
        if (response.status === 401) {
          setData(null);
          setLocked(true);
          setHasExistingCredential(
            "hasCredential" in payload && payload.hasCredential === true,
          );
          if (!silentDenied) throw new Error(c.accessDenied);
          return;
        }
        if (
          !response.ok ||
          !("schemaVersion" in payload) ||
          payload.schemaVersion !== 6
        ) {
          throw new Error("error" in payload ? payload.error : c.error);
        }
        setCandidateKey("");
        setLocked(false);
        setHasExistingCredential(false);
        if (
          payload.accessMode === "public" &&
          !payload.repositories.some(
            (repository) => repository.scope === "collection",
          )
        ) {
          setDataSource("opendata");
        }
        setData(payload);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : c.error);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [c.accessDenied, c.error],
  );

  useEffect(() => {
    void load("", false, false, true);
  }, [load]);

  const submitAccessKey = (event: FormEvent) => {
    event.preventDefault();
    void load(candidateKey.trim());
  };

  const lock = async () => {
    try {
      await fetch("/api/tacverse-impact", {
        method: "DELETE",
        credentials: "same-origin",
      });
    } finally {
      setCandidateKey("");
      setData(null);
      setError(null);
      setLocked(true);
      setHasExistingCredential(false);
    }
  };
  const chartData = useMemo(() => {
    const daily = data?.sourceViews[dataSource].daily ?? [];
    return windowSize === "all" ? daily : daily.slice(-windowSize);
  }, [data, dataSource, windowSize]);

  const usageChartData = useMemo(() => {
    const daily = data?.sourceViews[dataSource].advancedDaily ?? [];
    return windowSize === "all" ? daily : daily.slice(-windowSize);
  }, [data, dataSource, windowSize]);

  const publicChartData = useMemo(
    () =>
      (data?.repositories ?? [])
        .filter((repository) =>
          dataSource === "collection"
            ? repository.scope === "collection"
            : repository.id === "TacVerse/opendata",
        )
        .map((repository) => ({
          repository: repository.id,
          downloads: repository.downloads,
        })),
    [data, dataSource],
  );

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-400">
        <FiRefreshCw className="mr-3 animate-spin text-cyan-400" /> {c.loading}
      </div>
    );
  }

  if (locked || !data) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center">
        <form
          onSubmit={submitAccessKey}
          className="panel-raised w-full border-cyan-400/10 p-6"
        >
          <FiLock className="text-2xl text-cyan-300" />
          <h1 className="mt-4 text-xl font-semibold text-slate-100">
            {c.unlockTitle}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {c.unlockHint}
          </p>
          <label className="mt-5 block text-xs text-slate-500">
            {c.accessKey}
            <input
              autoComplete="off"
              type="password"
              value={candidateKey}
              onChange={(event) => setCandidateKey(event.target.value)}
              className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
            />
          </label>
          {error && <div className="mt-3 text-xs text-red-300">{error}</div>}
          <button
            type="submit"
            disabled={!candidateKey.trim()}
            className="mt-5 w-full rounded-md bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 disabled:opacity-40"
          >
            {c.unlock}
          </button>
          {hasExistingCredential && (
            <button
              type="button"
              onClick={() => void load("", true)}
              className="mt-3 w-full rounded-md border border-cyan-400/20 px-4 py-2 text-sm font-medium text-cyan-200 hover:border-cyan-300/40"
            >
              {c.useExisting}
            </button>
          )}
          <div className="my-4 h-px bg-white/5" />
          <button
            type="button"
            onClick={() => void load("", false, true)}
            className="w-full rounded-md border border-white/10 px-4 py-2 text-sm font-medium text-slate-200 hover:border-cyan-400/25 hover:text-cyan-200"
          >
            {c.publicOnly}
          </button>
          <p className="mt-2 text-center text-xs leading-5 text-slate-500">
            {c.publicOnlyHint}
          </p>
        </form>
      </div>
    );
  }

  const statusText = (state: ImpactSourceState) => c[`source_${state}`];
  const privateMode = data.accessMode === "private";
  const sourceView = data.sourceViews[dataSource];
  const sourceRepositories = data.repositories.filter((repository) =>
    dataSource === "collection"
      ? repository.scope === "collection"
      : repository.id === "TacVerse/opendata",
  );
  const advancedAvailable =
    data.sourceStatus.advancedLog !== "not_configured" &&
    sourceView.metrics.externalSessions !== null;
  const exactNote = sourceView.coverage.advancedLog
    ? c.exactSince.replace(
        "{date}",
        formatDate(sourceView.coverage.advancedLog.start, locale),
      )
    : c.advancedMissing;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const todayUtcEnd = addUtcDays(todayUtc, 1);
  const latestPublishedDay = sourceView.coverage.total?.end ?? null;
  const latestPublishedEnd = latestPublishedDay
    ? addUtcDays(latestPublishedDay, 1)
    : null;
  const todayDownloads = sourceView.daily.find(
    (row) => row.date === todayUtc,
  )?.totalDownloads;
  const currentWindowText = interpolate(c.publisherTimingCurrent, {
    date: todayUtc,
    start: todayUtc,
    end: todayUtcEnd,
  });
  const latestPublishedText =
    latestPublishedDay && latestPublishedEnd
      ? interpolate(c.publisherTimingPublished, {
          date: latestPublishedDay,
          start: latestPublishedDay,
          end: latestPublishedEnd,
        })
      : c.publisherTimingEmpty;
  const publisherAvailabilityText = interpolate(
    todayDownloads === undefined
      ? c.publisherTimingWaiting
      : c.publisherTimingAvailable,
    { end: todayUtcEnd },
  );
  const todayDownloadsNote =
    todayDownloads === undefined
      ? c.dayOverDayWaiting
      : `${todayUtc.slice(5)} · ${c.dayOverDayInProgress}`;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 pb-8">
      <section className="panel-raised flex flex-wrap items-center gap-3 border-cyan-400/15 px-4 py-3">
        <label
          htmlFor="tacverse-impact-source"
          className="text-xs font-medium text-slate-400"
        >
          {c.dataSource}
        </label>
        <select
          id="tacverse-impact-source"
          value={dataSource}
          onChange={(event) =>
            setDataSource(event.target.value as ImpactDataSource)
          }
          className="min-w-64 rounded-md border border-cyan-400/20 bg-[var(--surface-1)] px-3 py-2 text-sm text-cyan-100 outline-none focus:border-cyan-400/50"
        >
          <option value="collection">{c.collectionChoice}</option>
          <option value="opendata">{c.opendataChoice}</option>
        </select>
      </section>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-white/5 pb-5">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.22em] text-cyan-400">
            {privateMode ? c.eyebrow : c.publicEyebrow}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-100">
            {c.title}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {privateMode ? c.subtitle : c.publicSubtitle}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void load("", true, !privateMode)}
            className="inline-flex items-center gap-2 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-200 disabled:opacity-50"
          >
            <FiRefreshCw className={refreshing ? "animate-spin" : ""} />
            {refreshing ? c.refreshing : c.refresh}
          </button>
          <button
            type="button"
            onClick={() => void lock()}
            className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs text-slate-400"
          >
            <FiLock /> {c.lock}
          </button>
        </div>
      </header>

      {!privateMode && (
        <section className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.06] px-4 py-3 text-sm text-cyan-100">
          <p className="font-medium">{c.publicModeTitle}</p>
          <p className="mt-1 text-xs leading-5 text-cyan-100/70">
            {c.publicModeBody}
          </p>
        </section>
      )}

      {privateMode && (
        <section
          className={`rounded-md border px-4 py-3 text-sm ${
            todayDownloads === undefined
              ? "border-amber-400/25 bg-amber-400/[0.07] text-amber-100"
              : "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-100"
          }`}
        >
          <p className="font-medium">{c.publisherTimingTitle}</p>
          <div className="mt-1 space-y-1 text-xs leading-5 opacity-75">
            <p>{currentWindowText}</p>
            <p>{latestPublishedText}</p>
            <p>{publisherAvailabilityText}</p>
            <p>{c.publisherTimingNaturalDay}</p>
          </div>
        </section>
      )}

      {data.sourceStatus.cache === "stale" && (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {c.stale} {data.sourceStatus.message}
        </div>
      )}
      {privateMode &&
        dataSource === "collection" &&
        data.sourceStatus.collection === "unauthorized" && (
          <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            {c.incomplete} {data.sourceStatus.message}
          </div>
        )}
      {privateMode &&
        data.sourceStatus.publisherAnalytics === "unauthorized" && (
          <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            {c.permission}
          </div>
        )}
      {error && <div className="text-xs text-red-300">{error}</div>}

      <section
        className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${
          privateMode ? "xl:grid-cols-4" : "xl:grid-cols-2"
        }`}
      >
        <MetricCard
          label={c.totalDownloads}
          value={formatInteger(sourceView.metrics.totalDownloads)}
          note={
            privateMode
              ? coverageLabel(sourceView.coverage.total, locale)
              : c.publicDownloadsHint
          }
        />
        {privateMode && (
          <MetricCard
            label={c.todayDownloads}
            value={
              todayDownloads === undefined
                ? "—"
                : formatAddedInteger(todayDownloads)
            }
            note={todayDownloadsNote}
          />
        )}
        {privateMode && (
          <>
            <MetricCard
              label={c.last30}
              value={formatInteger(sourceView.metrics.last30Days)}
            />
            <MetricCard
              label={c.last7}
              value={formatInteger(sourceView.metrics.last7Days)}
            />
          </>
        )}
        {!privateMode && (
          <MetricCard
            label={c.selectedDatasets}
            value={formatInteger(sourceRepositories.length)}
          />
        )}
        {privateMode && (
          <>
            <MetricCard
              label={c.uniqueDownloaders}
              value={
                sourceView.metrics.externalUsers === null
                  ? "—"
                  : formatInteger(sourceView.metrics.externalUsers)
              }
              note={
                sourceView.metrics.externalUsers === null
                  ? c.advancedMissing
                  : `${coverageLabel(sourceView.coverage.advancedLog, locale)} · ${c.uniqueDownloaderHint}`
              }
            />
            <MetricCard
              label={c.externalSessions}
              value={
                sourceView.metrics.externalSessions === null
                  ? "—"
                  : formatInteger(sourceView.metrics.externalSessions)
              }
              note={exactNote}
            />
            <MetricCard
              label={c.repeatDownloaders}
              value={
                sourceView.metrics.repeatIdentifiers === null
                  ? "—"
                  : formatInteger(sourceView.metrics.repeatIdentifiers)
              }
            />
            <MetricCard
              label={c.countriesReached}
              value={
                advancedAvailable
                  ? formatInteger(sourceView.geography.length)
                  : "—"
              }
              note={
                advancedAvailable
                  ? coverageLabel(sourceView.coverage.advancedLog, locale)
                  : c.advancedMissing
              }
            />
          </>
        )}
      </section>
      {privateMode &&
        (!sourceView.daily.length ? (
          <section className="panel-raised p-8 text-center text-slate-300">
            {c.emptyTitle}
          </section>
        ) : (
          <section className="panel-raised p-5">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-slate-100">
                  {c.downloadTrend}
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  {c.downloadTrendHint}
                </p>
              </div>
              <div className="flex rounded-md border border-white/10 bg-black/10 p-0.5">
                {([7, 30, 90, "all"] as WindowSize[]).map((value) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => setWindowSize(value)}
                    className={`rounded px-2.5 py-1 text-[10px] ${windowSize === value ? "bg-cyan-400/15 text-cyan-200" : "text-slate-500"}`}
                  >
                    {value === "all" ? c.all : `${value}D`}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid
                    stroke="rgba(255,255,255,.05)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#64748b", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    tick={{ fill: "#64748b", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#11172a",
                      border: "1px solid rgba(255,255,255,.1)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    name={c.daily}
                    dataKey="totalDownloads"
                    fill="#22d3ee"
                    fillOpacity={0.55}
                    radius={[2, 2, 0, 0]}
                  />
                  <Line
                    name={c.rolling}
                    type="monotone"
                    dataKey="rolling7Average"
                    stroke="#a78bfa"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}

      {!privateMode && (
        <section className="panel-raised p-5">
          <div className="mb-5">
            <h2 className="text-base font-medium text-slate-100">
              {c.publicDownloadChart}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {c.publicDownloadChartHint}
            </p>
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={publicChartData}>
                <CartesianGrid
                  stroke="rgba(255,255,255,.05)"
                  vertical={false}
                />
                <XAxis
                  dataKey="repository"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                />
                <Tooltip
                  formatter={(value) => [
                    formatInteger(Number(value)),
                    c.cumulativeDownloads,
                  ]}
                  contentStyle={{
                    background: "#11172a",
                    border: "1px solid rgba(255,255,255,.1)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar
                  name={c.cumulativeDownloads}
                  dataKey="downloads"
                  fill="#22d3ee"
                  fillOpacity={0.55}
                  maxBarSize={96}
                  radius={[2, 2, 0, 0]}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <details className="panel-raised group px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-200 marker:text-cyan-400">
          {c.downloadsDefinition}
        </summary>
        <div className="mt-3 space-y-2 text-xs leading-5 text-slate-400">
          <p>{c.downloadsDefinitionIntro}</p>
          <p>{c.downloadsDefinitionRepeat}</p>
          <p>{c.downloadsDefinitionLimits}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
            <a
              href="https://huggingface.co/docs/hub/datasets-download-stats"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200"
            >
              {c.datasetDownloadRules} <FiExternalLink />
            </a>
            <a
              href="https://huggingface.co/docs/hub/publisher-analytics"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200"
            >
              {c.publisherAnalyticsRules} <FiExternalLink />
            </a>
          </div>
        </div>
      </details>

      {privateMode && data.sourceStatus.advancedLog === "not_configured" && (
        <details className="panel-raised group px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-slate-200 marker:text-cyan-400">
            {c.advancedSetupTitle}
          </summary>
          <div className="mt-3 text-xs leading-5 text-slate-400">
            <p>
              {c.advancedSetupBody}{" "}
              <a
                href="https://huggingface.co/docs/hub/publisher-analytics#unique-downloaders-and-more-granular-logs"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200"
              >
                {c.learnMore} <FiExternalLink />
              </a>
            </p>
          </div>
        </details>
      )}

      {advancedAvailable && usageChartData.length > 0 && (
        <section className="panel-raised p-5">
          <div className="mb-5">
            <h2 className="text-base font-medium text-slate-100">
              {c.downloaderTrend}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {c.downloaderTrendHint}
            </p>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={usageChartData}>
                <CartesianGrid
                  stroke="rgba(255,255,255,.05)"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    background: "#11172a",
                    border: "1px solid rgba(255,255,255,.1)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar
                  name={c.externalSessions}
                  dataKey="externalSessions"
                  fill="#22d3ee"
                  fillOpacity={0.45}
                  radius={[2, 2, 0, 0]}
                />
                <Line
                  name={c.dailyUniqueDownloaders}
                  type="monotone"
                  dataKey="anonymousIdentifiers"
                  stroke="#a78bfa"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="panel-raised p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-slate-100">
              {c.community}
            </h2>
            <p className="mt-1 text-xs text-slate-500">{c.communityHint}</p>
          </div>
          <StatusPill
            state={data.sourceStatus.community}
            label={statusText(data.sourceStatus.community)}
          />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label={c.likes}
            value={
              sourceView.community.likes === null
                ? "—"
                : formatInteger(sourceView.community.likes)
            }
          />
          <MetricCard
            label={c.discussions}
            value={
              sourceView.community.discussions === null
                ? "—"
                : formatInteger(sourceView.community.discussions)
            }
          />
          <MetricCard
            label={c.pullRequests}
            value={
              sourceView.community.pullRequests === null
                ? "—"
                : formatInteger(sourceView.community.pullRequests)
            }
          />
          <MetricCard
            label={c.comments}
            value={
              sourceView.community.comments === null
                ? "—"
                : formatInteger(sourceView.community.comments)
            }
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {c.repositoryCoverage}:{" "}
          {formatInteger(sourceView.community.repositoriesCovered)}/
          {formatInteger(sourceView.community.repositoriesTotal)}
          {sourceView.community.automatedThreads !== null &&
            ` · ${c.automatedThreads}: ${formatInteger(sourceView.community.automatedThreads)}`}
        </p>
      </section>

      <section className="panel-raised overflow-hidden">
        <div className="border-b border-white/5 p-5">
          <h2 className="text-base font-medium text-slate-100">{c.ranking}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {dataSource === "collection"
              ? c.collectionRankingHint
              : c.opendataRankingHint}
          </p>
        </div>
        <div className="max-h-[34rem] overflow-auto">
          <table
            className={`w-full text-left text-xs ${
              privateMode ? "min-w-[850px]" : "min-w-[560px]"
            }`}
          >
            <thead className="sticky top-0 z-10 bg-[var(--surface-1)] text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">{c.dataset}</th>
                <th className="px-4 py-3 font-medium">{c.scope}</th>
                <th className="px-4 py-3 text-right font-medium">
                  {c.downloads}
                </th>
                {privateMode && (
                  <>
                    <th className="px-4 py-3 text-right font-medium">
                      {c.last30}
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      {c.last7}
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      {c.sessions}
                    </th>
                    <th className="px-5 py-3 text-right font-medium">
                      {c.identifiers}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sourceRepositories.map((repository) => (
                <tr
                  key={repository.id}
                  className="border-t border-white/5 hover:bg-white/[0.02]"
                >
                  <td className="px-5 py-3">
                    <a
                      href={repository.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-cyan-300 hover:text-cyan-200"
                    >
                      {repository.id}
                      <FiExternalLink />
                    </a>
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-[9px] ${repository.private ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300"}`}
                    >
                      {repository.private ? c.private : c.public}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {repository.scope === "collection"
                      ? c.collectionScope
                      : c.standaloneScope}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-200 tabular">
                    {formatInteger(repository.downloads)}
                  </td>
                  {privateMode && (
                    <>
                      <td className="px-4 py-3 text-right text-slate-400 tabular">
                        {formatInteger(repository.last30Days)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400 tabular">
                        {formatInteger(repository.last7Days)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400 tabular">
                        {repository.externalSessions === null
                          ? "—"
                          : formatInteger(repository.externalSessions)}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-400 tabular">
                        {repository.anonymousIdentifiers === null
                          ? "—"
                          : formatInteger(repository.anonymousIdentifiers)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {advancedAvailable && (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="panel-raised grid grid-cols-2 gap-3 p-5">
            <MetricCard
              label={c.authenticatedIdentifiers}
              value={formatInteger(
                sourceView.metrics.authenticatedIdentifiers ?? 0,
              )}
            />
            <MetricCard
              label={c.anonymousIpIdentifiers}
              value={formatInteger(
                sourceView.metrics.anonymousIpIdentifiers ?? 0,
              )}
            />
            <MetricCard
              label={c.repeatDownloaders}
              value={formatInteger(sourceView.metrics.repeatIdentifiers ?? 0)}
            />
            <MetricCard
              label={c.crossRepository}
              value={formatInteger(
                sourceView.metrics.crossRepositoryIdentifiers ?? 0,
              )}
            />
          </div>
          <div className="panel-raised overflow-hidden">
            <div className="border-b border-white/5 p-5">
              <h2 className="text-base font-medium text-slate-100">
                {c.geography}
              </h2>
            </div>
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[var(--surface-1)] text-slate-500">
                  <tr>
                    <th className="px-5 py-3">{c.country}</th>
                    <th className="px-4 py-3 text-right">{c.sessions}</th>
                    <th className="px-5 py-3 text-right">{c.users}</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceView.geography.map((row) => (
                    <tr key={row.country} className="border-t border-white/5">
                      <td className="px-5 py-3 text-slate-300">
                        {row.country}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">
                        {formatInteger(row.sessions)}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-300">
                        {formatInteger(row.users)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {privateMode && (
        <section className="panel-raised overflow-hidden">
          <div className="border-b border-white/5 p-5">
            <h2 className="text-base font-medium text-slate-100">{c.table}</h2>
          </div>
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--surface-1)] text-slate-500">
                <tr>
                  <th className="px-5 py-3">{c.date}</th>
                  <th className="px-4 py-3 text-right">{c.total}</th>
                  <th className="px-5 py-3 text-right">{c.rolling}</th>
                </tr>
              </thead>
              <tbody>
                {[...sourceView.daily].reverse().map((row) => (
                  <tr key={row.date} className="border-t border-white/5">
                    <td className="px-5 py-3 font-mono text-slate-300">
                      {row.date}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-200">
                      {formatInteger(row.totalDownloads)}
                    </td>
                    <td className="px-5 py-3 text-right text-slate-400">
                      {row.rolling7Average.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {dataSource === "collection" ? (
          <div className="panel-raised p-5">
            <h2 className="text-base font-medium text-slate-100">
              {c.collection}
            </h2>
            <dl className="mt-5 space-y-3 text-xs">
              <div className="flex justify-between">
                <dt className="text-slate-500">{c.datasets}</dt>
                <dd>{data.collection.datasetCount}</dd>
              </div>
              {privateMode && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">{c.privateDatasets}</dt>
                  <dd>{data.collection.privateDatasetCount}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-slate-500">{c.publicDatasets}</dt>
                <dd>{data.collection.publicDatasetCount}</dd>
              </div>
              <a
                href={data.collection.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-cyan-300"
              >
                {c.open} <FiExternalLink />
              </a>
            </dl>
          </div>
        ) : (
          <div className="panel-raised p-5">
            <h2 className="text-base font-medium text-slate-100">
              {c.opendata}
            </h2>
            <dl className="mt-5 space-y-3 text-xs">
              <div className="flex justify-between">
                <dt className="text-slate-500">{c.subdatasets}</dt>
                <dd>{data.repository.subdatasetCount ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">{c.storage}</dt>
                <dd>
                  {data.repository.storageBytes === null
                    ? "—"
                    : formatBytes(data.repository.storageBytes)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">{c.modified}</dt>
                <dd>{formatDate(data.repository.lastModified, locale)}</dd>
              </div>
            </dl>
          </div>
        )}
        <div className="panel-raised p-5">
          <h2 className="text-base font-medium text-slate-100">{c.status}</h2>
          <dl className="mt-5 space-y-3 text-xs">
            {(privateMode
              ? [
                  [c.collectionSource, data.sourceStatus.collection],
                  [c.publisher, data.sourceStatus.publisherAnalytics],
                  [c.advanced, data.sourceStatus.advancedLog],
                  [c.communitySource, data.sourceStatus.community],
                ]
              : [
                  [
                    c.publicMetadataSource,
                    data.sourceStatus.publisherAnalytics,
                  ],
                  [c.communitySource, data.sourceStatus.community],
                ]
            ).map(([label, state]) => (
              <div
                key={String(label)}
                className="flex items-center justify-between gap-4"
              >
                <dt className="text-slate-500">{label}</dt>
                <dd>
                  <StatusPill
                    state={state as ImpactSourceState}
                    label={statusText(state as ImpactSourceState)}
                  />
                </dd>
              </div>
            ))}
            {privateMode && (
              <>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">{c.coverage}</dt>
                  <dd>{coverageLabel(sourceView.coverage.total, locale)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">{c.logCoverage}</dt>
                  <dd>
                    {coverageLabel(sourceView.coverage.advancedLog, locale)}
                  </dd>
                </div>
              </>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{c.cache}</dt>
              <dd>{c[`cache_${data.sourceStatus.cache}`]}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{c.refreshed}</dt>
              <dd>{formatDate(data.refreshedAt, locale)}</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}

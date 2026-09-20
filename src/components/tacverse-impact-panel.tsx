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
import { FiExternalLink, FiLock, FiRefreshCw } from "react-icons/fi";
import { useLocale } from "@/context/locale-context";
import { formatBytes } from "@/utils/byteSize";
import type {
  ImpactDataSource,
  ImpactSourceState,
  TacVerseImpactData,
} from "@/types/tacverse-impact.types";

type WindowSize = 7 | 30 | 90 | "all";
const ACCESS_KEY_STORAGE = "tacverse-impact-access-key";

const COPY = {
  en: {
    eyebrow: "PRIVATE COLLECTION ANALYTICS",
    title: "TacVerse Impact",
    subtitle:
      "Publisher Analytics for the private TacVerse Collection plus TacVerse/opendata.",
    dataSource: "Data source",
    collectionChoice: "TacVerse Collection",
    opendataChoice: "TacVerse/opendata",
    selectedDatasets: "Datasets in source",
    collectionRankingHint: "Datasets in the current private Collection.",
    opendataRankingHint: "The standalone TacVerse/opendata repository.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    downloads: "Downloads",
    collectionDownloads: "Collection downloads",
    opendataDownloads: "opendata downloads",
    last30: "Last 30 HF days",
    last7: "Last 7 HF days",
    average7: "7-day daily average",
    externalSessions: "Download sessions",
    uniqueDownloaders: "Unique downloaders",
    uniqueDownloaderHint:
      "Deduplicated anonymous account/IP hashes; this is an estimate of people, not identifiable users.",
    anonymousIdentifiers: "Anonymous identifiers",
    authenticatedIdentifiers: "Signed-in hashes",
    anonymousIpIdentifiers: "Anonymous IP hashes",
    crossRepository: "Cross-repository users",
    repeatDownloaders: "Repeat downloaders",
    countriesReached: "Countries / regions reached",
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
      "Publisher daily downloads. Each HF UTC day spans 08:00–08:00 China Standard Time.",
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
    unlockHint: "Enter the Impact credential configured for this project.",
    accessKey: "Impact access key",
    unlock: "Unlock",
    accessNotConfigured:
      "Configure TACVERSE_IMPACT_ACCESS_KEY or the project-local hidden credential file, then enter the same value here.",
    accessSetupCommand:
      "TACVERSE_IMPACT_ACCESS_KEY=<a separate random value> bun dev",
    hfTokenSetup:
      "Project-local fallback: .xense-viewer/secrets/tacverse-impact-key. It can also be used for authenticated Hugging Face requests.",
    accessDenied: "The Impact access key is invalid.",
    lock: "Lock",
    source_live: "Live",
    source_cache: "Cached",
    source_stale: "Stale cache",
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
    dataSource: "数据来源",
    collectionChoice: "TacVerse Collection",
    opendataChoice: "TacVerse/opendata",
    selectedDatasets: "当前来源数据集",
    collectionRankingHint: "当前私有 Collection 中的数据集。",
    opendataRankingHint: "独立的 TacVerse/opendata 仓库。",
    refresh: "刷新",
    refreshing: "刷新中…",
    downloads: "Downloads",
    collectionDownloads: "Collection 下载",
    opendataDownloads: "opendata 下载",
    last30: "最近 30 个 HF 统计日",
    last7: "最近 7 个 HF 统计日",
    average7: "7 日日均",
    externalSessions: "下载会话",
    uniqueDownloaders: "唯一使用者",
    uniqueDownloaderHint:
      "按匿名账号哈希或 IP 哈希去重，是使用人数估算值，不对应可识别的真实用户。",
    anonymousIdentifiers: "匿名标识",
    authenticatedIdentifiers: "已登录账号哈希",
    anonymousIpIdentifiers: "匿名 IP 哈希",
    crossRepository: "跨仓库使用者",
    repeatDownloaders: "重复使用者",
    countriesReached: "覆盖国家 / 地区",
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
      "Publisher 每日 downloads；每个 HF UTC 日对应北京时间 08:00 至次日 08:00。",
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
    loading: "正在加载私有统计…",
    emptyTitle: "暂无 Publisher Analytics 下载历史。",
    permission:
      "当前 Hugging Face 凭据无法读取完整私有 Collection 或 Publisher Analytics。",
    incomplete: "私有 Collection 完整性检查失败，不展示不完整的公开部分。",
    stale: "最新刷新失败，当前展示上一次完整缓存。",
    error: "无法加载 TacVerse Impact 数据。",
    unlockTitle: "解锁私有统计",
    unlockHint: "请输入本工程已经配置的 Impact 访问凭据。",
    accessKey: "Impact 访问密钥",
    unlock: "解锁",
    accessNotConfigured:
      "请配置 TACVERSE_IMPACT_ACCESS_KEY 或工程内隐藏凭据文件，再在这里输入相同的值。",
    accessSetupCommand: "TACVERSE_IMPACT_ACCESS_KEY=<另一条随机密钥> bun dev",
    hfTokenSetup:
      "工程级后备路径：.xense-viewer/secrets/tacverse-impact-key；其中的凭据也会用于 Hugging Face 鉴权请求。",
    accessDenied: "Impact 访问密钥不正确。",
    lock: "锁定",
    source_live: "实时",
    source_cache: "缓存",
    source_stale: "过期缓存",
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
    <div className="panel-raised min-h-32 p-4">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-100 tabular">
        {value}
      </p>
      {note && <p className="mt-2 text-xs leading-5 text-slate-500">{note}</p>}
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
        : state === "stale" || state === "unauthorized"
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
  const [accessKey, setAccessKey] = useState("");
  const [candidateKey, setCandidateKey] = useState("");
  const [locked, setLocked] = useState(true);
  const [accessNotConfigured, setAccessNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [windowSize, setWindowSize] = useState<WindowSize>(30);
  const [dataSource, setDataSource] = useState<ImpactDataSource>("collection");

  const load = useCallback(
    async (key: string, force = false) => {
      if (!key) {
        setLoading(false);
        setLocked(true);
        return;
      }
      if (force) setRefreshing(true);
      else setLoading(true);
      setError(null);
      setAccessNotConfigured(false);
      try {
        const response = await fetch("/api/tacverse-impact", {
          method: force ? "POST" : "GET",
          headers: {
            "x-tacverse-impact-key": key,
            ...(force ? { "content-type": "application/json" } : {}),
          },
          body: force ? "{}" : undefined,
        });
        const payload = (await response.json()) as
          | TacVerseImpactData
          | { error?: string; code?: string };
        if (response.status === 401 || response.status === 503) {
          sessionStorage.removeItem(ACCESS_KEY_STORAGE);
          setData(null);
          setLocked(true);
          setAccessNotConfigured(
            "code" in payload &&
              payload.code === "impact_access_not_configured",
          );
          throw new Error(
            response.status === 503 ? c.accessNotConfigured : c.accessDenied,
          );
        }
        if (
          !response.ok ||
          !("schemaVersion" in payload) ||
          payload.schemaVersion !== 4
        ) {
          throw new Error("error" in payload ? payload.error : c.error);
        }
        setAccessKey(key);
        setCandidateKey("");
        setLocked(false);
        setData(payload);
        sessionStorage.setItem(ACCESS_KEY_STORAGE, key);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : c.error);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [c.accessDenied, c.accessNotConfigured, c.error],
  );

  useEffect(() => {
    const saved = sessionStorage.getItem(ACCESS_KEY_STORAGE) ?? "";
    if (saved) void load(saved);
    else setLoading(false);
  }, [load]);

  const submitAccessKey = (event: FormEvent) => {
    event.preventDefault();
    void load(candidateKey.trim());
  };

  const lock = () => {
    sessionStorage.removeItem(ACCESS_KEY_STORAGE);
    setAccessKey("");
    setCandidateKey("");
    setData(null);
    setError(null);
    setLocked(true);
  };

  const chartData = useMemo(() => {
    const daily = data?.sourceViews[dataSource].daily ?? [];
    return windowSize === "all" ? daily : daily.slice(-windowSize);
  }, [data, dataSource, windowSize]);

  const usageChartData = useMemo(() => {
    const daily = data?.sourceViews[dataSource].advancedDaily ?? [];
    return windowSize === "all" ? daily : daily.slice(-windowSize);
  }, [data, dataSource, windowSize]);

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
          {error && (
            <div
              className={`mt-3 text-xs ${accessNotConfigured ? "text-amber-300" : "text-red-300"}`}
            >
              <p>{error}</p>
              {accessNotConfigured && (
                <div className="mt-3 space-y-2 rounded-md border border-amber-400/15 bg-amber-400/[0.04] p-3 leading-5 text-amber-200/80">
                  <code className="block overflow-x-auto whitespace-nowrap rounded bg-black/20 px-2 py-1.5 text-[11px] text-amber-100">
                    {c.accessSetupCommand}
                  </code>
                  <p>{c.hfTokenSetup}</p>
                </div>
              )}
            </div>
          )}
          <button
            type="submit"
            disabled={!candidateKey.trim()}
            className="mt-5 w-full rounded-md bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 disabled:opacity-40"
          >
            {c.unlock}
          </button>
        </form>
      </div>
    );
  }

  const statusText = (state: ImpactSourceState) => c[`source_${state}`];
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
            {c.eyebrow}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-100">
            {c.title}
          </h1>
          <p className="mt-2 text-sm text-slate-400">{c.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void load(accessKey, true)}
            className="inline-flex items-center gap-2 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-200 disabled:opacity-50"
          >
            <FiRefreshCw className={refreshing ? "animate-spin" : ""} />
            {refreshing ? c.refreshing : c.refresh}
          </button>
          <button
            type="button"
            onClick={lock}
            className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs text-slate-400"
          >
            <FiLock /> {c.lock}
          </button>
        </div>
      </header>

      {data.sourceStatus.cache === "stale" && (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {c.stale} {data.sourceStatus.message}
        </div>
      )}
      {dataSource === "collection" &&
        data.sourceStatus.collection === "unauthorized" && (
          <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            {c.incomplete} {data.sourceStatus.message}
          </div>
        )}
      {data.sourceStatus.publisherAnalytics === "unauthorized" && (
        <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {c.permission}
        </div>
      )}
      {error && <div className="text-xs text-red-300">{error}</div>}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        <MetricCard
          label={c.downloads}
          value={formatInteger(sourceView.metrics.totalDownloads)}
          note={coverageLabel(sourceView.coverage.total, locale)}
        />
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
              : `${exactNote} · ${c.uniqueDownloaderHint}`
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
            advancedAvailable ? formatInteger(sourceView.geography.length) : "—"
          }
        />
        <MetricCard
          label={c.last30}
          value={formatInteger(sourceView.metrics.last30Days)}
        />
        <MetricCard
          label={c.last7}
          value={formatInteger(sourceView.metrics.last7Days)}
        />
      </section>

      {data.sourceStatus.advancedLog === "not_configured" && (
        <section className="rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">{c.advancedSetupTitle}</p>
          <p className="mt-1 text-xs leading-5 text-amber-100/70">
            {c.advancedSetupBody}{" "}
            <a
              href="https://huggingface.co/docs/hub/publisher-analytics#unique-downloaders-and-more-granular-logs"
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 hover:text-cyan-200"
            >
              {c.learnMore} <FiExternalLink className="inline" />
            </a>
          </p>
        </section>
      )}

      {!sourceView.daily.length ? (
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
          <table className="w-full min-w-[850px] text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--surface-1)] text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">{c.dataset}</th>
                <th className="px-4 py-3 font-medium">{c.scope}</th>
                <th className="px-4 py-3 text-right font-medium">
                  {c.downloads}
                </th>
                <th className="px-4 py-3 text-right font-medium">{c.last30}</th>
                <th className="px-4 py-3 text-right font-medium">{c.last7}</th>
                <th className="px-4 py-3 text-right font-medium">
                  {c.sessions}
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  {c.identifiers}
                </th>
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
              <div className="flex justify-between">
                <dt className="text-slate-500">{c.privateDatasets}</dt>
                <dd>{data.collection.privateDatasetCount}</dd>
              </div>
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
            {[
              [c.collectionSource, data.sourceStatus.collection],
              [c.publisher, data.sourceStatus.publisherAnalytics],
              [c.advanced, data.sourceStatus.advancedLog],
            ].map(([label, state]) => (
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
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{c.coverage}</dt>
              <dd>{coverageLabel(sourceView.coverage.total, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{c.logCoverage}</dt>
              <dd>{coverageLabel(sourceView.coverage.advancedLog, locale)}</dd>
            </div>
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

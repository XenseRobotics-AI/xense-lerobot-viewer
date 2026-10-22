"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
import {
  FiChevronLeft,
  FiChevronRight,
  FiPause,
  FiPlay,
  FiX,
} from "react-icons/fi";
import { getWorkbenchOverviewActiveCardIndex } from "@/components/workbench-display-utils";
import { useLocale } from "@/context/locale-context";
import type {
  ImpactDataSource,
  TacVerseImpactData,
  TacVerseImpactRepository,
} from "@/types/tacverse-impact.types";

type SlideId =
  | "overview"
  | "downloads"
  | "repositories"
  | "community"
  | "geography"
  | "taccap-video";

type SlideConfig = Readonly<{
  id: SlideId;
  title: string;
  durationMs: number;
}>;

export type ImpactDisplayWindowSize = 7 | 30 | 90 | "all";

type DisplayCopy = (typeof COPY)[keyof typeof COPY];

type TacVerseImpactDisplayProps = {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  windowSize: ImpactDisplayWindowSize;
  onExit: () => void;
};

const TACCAP_SHOWCASE_VIDEO_DURATION_SECONDS = 44;
const TACCAP_SHOWCASE_VIDEO_SLIDE_DURATION_MS = 44_000;

const COPY = {
  en: {
    title: "TacVerse Impact",
    privateEyebrow: "Private analytics display",
    publicEyebrow: "Public analytics display",
    collection: "TacVerse Collection",
    opendata: "TacVerse/opendata",
    snapshot: "Snapshot",
    sourceSnapshot: "Source snapshot",
    overview: "Overview",
    downloads: "Downloads",
    repositories: "Datasets",
    community: "Community",
    geography: "Geography",
    totalDownloads: "Total downloads",
    latestDayDownloads: "Latest HF day",
    last7: "Last 7 days",
    last30: "Last 30 days",
    uniqueDownloaders: "Unique downloaders",
    externalSessions: "Download sessions",
    datasets: "Datasets",
    privateDatasets: "Private",
    publicDatasets: "Public",
    likes: "Likes",
    discussions: "Discussions",
    pullRequests: "Pull requests",
    comments: "Comments",
    automatedThreads: "Automated threads",
    repositoryCoverage: "Repository coverage",
    downloadsTrend: "Download trend",
    publicDownloads: "Public download totals",
    daily: "Daily",
    rolling: "7-day average",
    allTimeDownloads: "All-time Downloads",
    topDatasets: "Top datasets",
    scopeCollection: "Collection",
    scopeStandalone: "Standalone",
    country: "Country / region",
    sessions: "Sessions",
    users: "Identifiers",
    notAvailable: "Not available",
    noDaily: "No Publisher Analytics daily history.",
    noRepositories: "No repositories in this source.",
    noGeography: "Enterprise-log geography is not configured.",
    tacCapVideo: "TacCap Video",
    tacCapShowcaseVideo: "TacCap showcase video",
    tacCapShowcaseMeta: "First 44 seconds",
    autoplayMuted: "Autoplay was muted. Click to restore sound.",
    previous: "Previous slide",
    next: "Next slide",
    pause: "Pause display",
    resume: "Resume display",
    exit: "Exit display",
    paused: "Paused",
    progress: "Display progress",
  },
  zh: {
    title: "TacVerse Impact",
    privateEyebrow: "私有统计大屏",
    publicEyebrow: "公开统计大屏",
    collection: "TacVerse Collection",
    opendata: "TacVerse/opendata",
    snapshot: "快照",
    sourceSnapshot: "来源快照",
    overview: "总览",
    downloads: "Downloads",
    repositories: "数据集",
    community: "社区",
    geography: "地域",
    totalDownloads: "总下载量",
    latestDayDownloads: "最新 HF 统计日",
    last7: "最近 7 日",
    last30: "最近 30 日",
    uniqueDownloaders: "唯一使用者",
    externalSessions: "下载会话",
    datasets: "数据集",
    privateDatasets: "私有",
    publicDatasets: "公开",
    likes: "Likes",
    discussions: "Discussion",
    pullRequests: "PR",
    comments: "评论",
    automatedThreads: "自动化主题",
    repositoryCoverage: "仓库覆盖",
    downloadsTrend: "下载趋势",
    publicDownloads: "公开累计下载",
    daily: "每日",
    rolling: "7 日均线",
    allTimeDownloads: "累计 Downloads",
    topDatasets: "热门数据集",
    scopeCollection: "Collection",
    scopeStandalone: "独立仓库",
    country: "国家 / 地区",
    sessions: "会话",
    users: "匿名标识",
    notAvailable: "暂无数据",
    noDaily: "暂无 Publisher Analytics 逐日历史。",
    noRepositories: "当前来源没有数据集。",
    noGeography: "Enterprise 日志地域统计未配置。",
    tacCapVideo: "TacCap 视频",
    tacCapShowcaseVideo: "TacCap 展示视频",
    tacCapShowcaseMeta: "前 44 秒",
    autoplayMuted: "自动播放已静音，点击恢复声音。",
    previous: "上一页",
    next: "下一页",
    pause: "暂停大屏",
    resume: "继续大屏",
    exit: "退出大屏",
    paused: "已暂停",
    progress: "大屏进度",
  },
} as const;

function formatInteger(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(value: string, locale: "en" | "zh"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function sourceTitle(dataSource: ImpactDataSource, c: DisplayCopy): string {
  return dataSource === "collection" ? c.collection : c.opendata;
}

function repositoriesForSource(
  data: TacVerseImpactData,
  dataSource: ImpactDataSource,
): TacVerseImpactRepository[] {
  return data.repositories
    .filter((repository) =>
      dataSource === "collection"
        ? repository.scope === "collection"
        : repository.id === "TacVerse/opendata",
    )
    .sort(
      (left, right) =>
        right.downloads - left.downloads || left.id.localeCompare(right.id),
    );
}

function getSlides(
  c: DisplayCopy,
  hasGeography: boolean,
): readonly SlideConfig[] {
  return [
    { id: "overview", title: c.overview, durationMs: 10_000 },
    { id: "downloads", title: c.downloads, durationMs: 14_000 },
    { id: "repositories", title: c.repositories, durationMs: 12_000 },
    { id: "community", title: c.community, durationMs: 10_000 },
    ...(hasGeography
      ? [{ id: "geography" as const, title: c.geography, durationMs: 10_000 }]
      : []),
    {
      id: "taccap-video",
      title: c.tacCapVideo,
      durationMs: TACCAP_SHOWCASE_VIDEO_SLIDE_DURATION_MS,
    },
  ];
}

function nextSlideIndex(
  current: number,
  offset: number,
  slides: readonly SlideConfig[],
): number {
  return (current + offset + slides.length) % slides.length;
}

function MetricTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "cyan" | "emerald" | "amber" | "violet";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan-300/25 bg-cyan-300/[0.08]"
      : tone === "emerald"
        ? "border-emerald-300/25 bg-emerald-300/[0.08]"
        : tone === "amber"
          ? "border-amber-300/25 bg-amber-300/[0.08]"
          : tone === "violet"
            ? "border-violet-300/25 bg-violet-300/[0.08]"
            : "border-white/10 bg-white/[0.04]";
  return (
    <div className={`min-h-32 rounded-lg border p-5 ${toneClass}`}>
      <p className="text-xs font-medium uppercase text-slate-400">{label}</p>
      <p className="mt-5 text-5xl font-semibold text-slate-50 tabular-nums">
        {value}
      </p>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[24rem] place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-lg text-slate-400">
      {children}
    </div>
  );
}

function DisplayHeader({
  data,
  dataSource,
  c,
  locale,
}: {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  c: DisplayCopy;
  locale: "en" | "zh";
}) {
  return (
    <header className="grid grid-cols-[1fr_auto] gap-6 border-b border-white/10 px-8 py-4">
      <div>
        <p className="text-xs font-semibold uppercase text-cyan-300">
          {data.accessMode === "private" ? c.privateEyebrow : c.publicEyebrow}
        </p>
        <h1 className="mt-1 text-4xl font-semibold text-slate-50">{c.title}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {sourceTitle(dataSource, c)}
        </p>
      </div>
      <div className="self-end text-right">
        <p className="text-xs uppercase text-slate-500">{c.snapshot}</p>
        <p className="mt-2 text-lg font-medium text-slate-200">
          {formatDateTime(data.refreshedAt, locale)}
        </p>
      </div>
    </header>
  );
}

function OverviewSlide({
  data,
  dataSource,
  c,
  elapsedMs,
  reducedMotion,
  total,
}: {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  c: DisplayCopy;
  elapsedMs: number;
  reducedMotion: boolean;
  total: number;
}) {
  const sourceView = data.sourceViews[dataSource];
  const repositories = repositoriesForSource(data, dataSource);
  const latestPublishedDay = sourceView.coverage.total?.end ?? null;
  const latestPublishedDownloads = sourceView.daily.find(
    (row) => row.date === latestPublishedDay,
  )?.totalDownloads;
  const metrics = [
    [c.totalDownloads, formatInteger(sourceView.metrics.totalDownloads), null],
    [c.last30, formatInteger(sourceView.metrics.last30Days), null],
    [c.last7, formatInteger(sourceView.metrics.last7Days), null],
    [
      c.latestDayDownloads,
      latestPublishedDay ?? "—",
      `Downloads: ${
        latestPublishedDownloads === undefined
          ? "—"
          : `+${formatInteger(latestPublishedDownloads)}`
      }`,
    ],
    [c.datasets, formatInteger(repositories.length), null],
    [
      c.repositoryCoverage,
      `${formatInteger(sourceView.community.repositoriesCovered)} / ${formatInteger(
        sourceView.community.repositoriesTotal,
      )}`,
      null,
    ],
    [
      c.uniqueDownloaders,
      formatInteger(sourceView.metrics.externalUsers),
      null,
    ],
    [
      c.externalSessions,
      formatInteger(sourceView.metrics.externalSessions),
      null,
    ],
    [c.likes, formatInteger(sourceView.community.likes), null],
  ] as const;
  const activeCardIndex = getWorkbenchOverviewActiveCardIndex(
    elapsedMs,
    reducedMotion,
  );

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <span className="font-mono text-xs text-cyan-300/80">
            01 / {String(total).padStart(2, "0")}
          </span>
          <h2 className="mt-2 text-3xl font-semibold text-slate-50">
            {c.overview}
          </h2>
        </div>
        <div className="pt-1 text-right text-sm text-slate-400">
          {c.sourceSnapshot}
        </div>
      </div>
      <div className="grid min-h-0 content-center rounded-lg border border-white/10 bg-white/[0.04] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
        <div className="grid grid-cols-3 gap-5">
          {metrics.map(([label, value, note], index) => {
            const activeClass =
              activeCardIndex === null
                ? ""
                : index === activeCardIndex
                  ? "z-10 -translate-y-1 scale-[1.025] border-cyan-300/70 bg-cyan-300/[0.11] opacity-100 shadow-[0_14px_30px_rgba(0,0,0,0.2),0_0_28px_rgba(34,211,238,0.14)]"
                  : "scale-[0.975] opacity-40 saturate-[0.72]";
            const featuredClass =
              index < 2
                ? "border-cyan-300/30 bg-cyan-300/[0.075]"
                : "border-white/10 bg-white/[0.035]";
            return (
              <div
                key={label}
                className={`min-w-0 rounded-lg border p-6 transition-all duration-300 ${featuredClass} ${activeClass}`}
                data-focused={index === activeCardIndex || undefined}
              >
                <span className="block truncate text-xs font-semibold uppercase text-slate-400">
                  {label}
                </span>
                <strong
                  className={`mt-4 block truncate font-semibold tabular-nums ${
                    index < 2
                      ? "text-[clamp(2.6rem,5vw,5.5rem)] text-cyan-50"
                      : "text-[clamp(2rem,3.2vw,3.5rem)] text-slate-50"
                  }`}
                >
                  {value}
                </strong>
                {note && (
                  <p className="mt-3 truncate text-sm text-slate-500">{note}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function DownloadsSlide({
  data,
  dataSource,
  c,
  windowSize,
}: {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  c: DisplayCopy;
  windowSize: ImpactDisplayWindowSize;
}) {
  const sourceView = data.sourceViews[dataSource];
  const repositories = repositoriesForSource(data, dataSource).slice(0, 12);

  if (data.accessMode === "private") {
    const rows =
      windowSize === "all"
        ? sourceView.daily
        : sourceView.daily.slice(-windowSize);
    if (!rows.length) return <EmptyState>{c.noDaily}</EmptyState>;
    return (
      <section className="grid h-full grid-rows-[auto_1fr] gap-5">
        <h2 className="text-2xl font-semibold text-slate-100">
          {c.downloadsTrend}
        </h2>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows}>
            <CartesianGrid stroke="rgba(255,255,255,.08)" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#94a3b8", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: "#94a3b8", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip
              contentStyle={{
                background: "#111827",
                border: "1px solid rgba(255,255,255,.14)",
                borderRadius: 8,
                color: "#e5e7eb",
              }}
            />
            <Bar
              name={c.daily}
              dataKey="totalDownloads"
              fill="#22d3ee"
              fillOpacity={0.65}
              radius={[3, 3, 0, 0]}
            />
            <Line
              name={c.rolling}
              type="monotone"
              dataKey="rolling7Average"
              stroke="#a78bfa"
              strokeWidth={3}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
    );
  }

  if (!repositories.length) return <EmptyState>{c.noRepositories}</EmptyState>;
  return (
    <section className="grid h-full grid-rows-[auto_1fr] gap-5">
      <h2 className="text-2xl font-semibold text-slate-100">
        {c.publicDownloads}
      </h2>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={repositories.map((repository) => ({
            repository: repository.id.replace(/^TacVerse\//, ""),
            downloads: repository.downloads,
          }))}
          layout="vertical"
        >
          <CartesianGrid stroke="rgba(255,255,255,.08)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="repository"
            width={260}
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "#111827",
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 8,
              color: "#e5e7eb",
            }}
          />
          <Bar
            name={c.allTimeDownloads}
            dataKey="downloads"
            fill="#34d399"
            fillOpacity={0.72}
            radius={[0, 4, 4, 0]}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
}

function RepositoriesSlide({
  data,
  dataSource,
  c,
}: {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  c: DisplayCopy;
}) {
  const allRepositories = repositoriesForSource(data, dataSource);
  const repositories = allRepositories.slice(0, 10);
  const maxDownloads = Math.max(
    1,
    ...repositories.map((repository) => repository.downloads),
  );

  if (!allRepositories.length)
    return <EmptyState>{c.noRepositories}</EmptyState>;
  return (
    <section className="grid h-full grid-rows-[auto_1fr] gap-5">
      <div className="flex items-start justify-between gap-6">
        <h2 className="text-2xl font-semibold text-slate-100">
          {c.topDatasets}
        </h2>
        <div className="pt-1 text-right text-sm text-slate-400">
          {formatInteger(repositories.length)} /{" "}
          {formatInteger(allRepositories.length)} {c.datasets}
        </div>
      </div>
      <div className="grid content-start gap-3">
        {repositories.map((repository, index) => (
          <div
            key={repository.id}
            className="grid grid-cols-[3rem_1fr_8rem_8rem_8rem_auto] items-center gap-4 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3"
          >
            <div className="font-mono text-xl text-cyan-200">
              {String(index + 1).padStart(2, "0")}
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-medium text-slate-100">
                {repository.id}
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <span
                  className="block h-full rounded-full bg-cyan-300"
                  style={{
                    width: `${Math.max(
                      4,
                      (repository.downloads / maxDownloads) * 100,
                    )}%`,
                  }}
                />
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase text-slate-500">{c.last30}</div>
              <div className="mt-1 text-lg font-semibold text-slate-200 tabular-nums">
                {formatInteger(repository.last30Days)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase text-slate-500">{c.last7}</div>
              <div className="mt-1 text-lg font-semibold text-slate-200 tabular-nums">
                {formatInteger(repository.last7Days)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase text-slate-500">{c.likes}</div>
              <div className="mt-1 text-lg font-semibold text-slate-200 tabular-nums">
                {formatInteger(repository.likes)}
              </div>
            </div>
            <div className="min-w-44 text-right">
              <div className="text-2xl font-semibold text-slate-50 tabular-nums">
                {formatInteger(repository.downloads)}
              </div>
              <div className="mt-1 text-xs uppercase text-slate-500">
                {repository.scope === "collection"
                  ? c.scopeCollection
                  : c.scopeStandalone}
                {repository.private ? ` · ${c.privateDatasets}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CommunitySlide({
  data,
  dataSource,
  c,
}: {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  c: DisplayCopy;
}) {
  const community = data.sourceViews[dataSource].community;
  return (
    <section className="grid h-full content-center gap-6">
      <div className="grid grid-cols-5 gap-5">
        <MetricTile label={c.likes} value={formatInteger(community.likes)} />
        <MetricTile
          label={c.discussions}
          value={formatInteger(community.discussions)}
          tone="cyan"
        />
        <MetricTile
          label={c.pullRequests}
          value={formatInteger(community.pullRequests)}
          tone="violet"
        />
        <MetricTile
          label={c.comments}
          value={formatInteger(community.comments)}
          tone="emerald"
        />
        <MetricTile
          label={c.automatedThreads}
          value={formatInteger(community.automatedThreads)}
          tone="amber"
        />
      </div>
      <MetricTile
        label={c.repositoryCoverage}
        value={`${formatInteger(community.repositoriesCovered)} / ${formatInteger(
          community.repositoriesTotal,
        )}`}
      />
    </section>
  );
}

function GeographySlide({
  data,
  dataSource,
  c,
}: {
  data: TacVerseImpactData;
  dataSource: ImpactDataSource;
  c: DisplayCopy;
}) {
  const rows = data.sourceViews[dataSource].geography.slice(0, 12);
  const maxSessions = Math.max(1, ...rows.map((row) => row.sessions));

  if (!rows.length) return <EmptyState>{c.noGeography}</EmptyState>;
  return (
    <section className="grid h-full grid-rows-[auto_1fr] gap-5">
      <h2 className="text-2xl font-semibold text-slate-100">{c.geography}</h2>
      <div className="grid content-start gap-3">
        {rows.map((row) => (
          <div
            key={row.country}
            className="grid grid-cols-[1fr_12rem_12rem] items-center gap-4 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-lg font-medium text-slate-100">
                {row.country}
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <span
                  className="block h-full rounded-full bg-emerald-300"
                  style={{
                    width: `${Math.max(4, (row.sessions / maxSessions) * 100)}%`,
                  }}
                />
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase text-slate-500">{c.sessions}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-50 tabular-nums">
                {formatInteger(row.sessions)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase text-slate-500">{c.users}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-50 tabular-nums">
                {formatInteger(row.users)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TacCapVideoSlide({
  c,
  elapsedMs,
  paused,
}: {
  c: DisplayCopy;
  elapsedMs: number;
  paused: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [showSoundPrompt, setShowSoundPrompt] = useState(false);

  const playVideo = useCallback((allowMutedFallback: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => {
      if (!allowMutedFallback) return;
      video.muted = true;
      setMuted(true);
      setShowSoundPrompt(true);
      void video.play().catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.muted = false;
    setMuted(false);
    setShowSoundPrompt(false);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) {
      video.pause();
      return;
    }
    playVideo(true);
  }, [paused, playVideo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const targetSeconds = Math.min(
      TACCAP_SHOWCASE_VIDEO_DURATION_SECONDS,
      Math.max(0, elapsedMs / 1_000),
    );
    if (Math.abs(video.currentTime - targetSeconds) > 0.75) {
      video.currentTime = targetSeconds;
    }
  }, [elapsedMs]);

  const restoreSound = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
    setShowSoundPrompt(false);
    if (!paused) playVideo(false);
  };

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5">
      <div className="flex items-start justify-between gap-6">
        <h2 className="text-2xl font-semibold text-slate-100">
          {c.tacCapVideo}
        </h2>
        <div className="pt-1 text-right text-sm text-slate-400">
          {c.tacCapShowcaseMeta}
        </div>
      </div>
      <div className="relative min-h-0 overflow-hidden rounded-lg border border-white/10 bg-black shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
        <video
          aria-label={c.tacCapShowcaseVideo}
          autoPlay
          className="h-full w-full object-contain"
          muted={muted}
          playsInline
          preload="auto"
          ref={videoRef}
          src="/media/xense-taccap.mp4"
        />
        {showSoundPrompt && (
          <button
            className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full border border-cyan-300/30 bg-black/70 px-4 py-2 text-xs font-medium text-cyan-100 backdrop-blur hover:border-cyan-200/60"
            onClick={restoreSound}
            type="button"
          >
            {c.autoplayMuted}
          </button>
        )}
      </div>
    </section>
  );
}

export default function TacVerseImpactDisplay({
  data,
  dataSource,
  windowSize,
  onExit,
}: TacVerseImpactDisplayProps) {
  const { locale } = useLocale();
  const c = COPY[locale];
  const reducedMotion = useReducedMotion();
  const hasGeography = data.sourceViews[dataSource].geography.length > 0;
  const slides = useMemo(() => getSlides(c, hasGeography), [c, hasGeography]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const startedAtRef = useRef(performance.now());
  const controlsTimerRef = useRef<number | null>(null);
  const exitingRef = useRef(false);
  const pausedRef = useRef(false);

  const resetClock = useCallback((index: number) => {
    const now = performance.now();
    startedAtRef.current = now;
    setElapsedMs(0);
  }, []);

  const moveSlide = useCallback(
    (offset: number) => {
      setSlideIndex((current) => {
        const next = nextSlideIndex(current, offset, slides);
        resetClock(next);
        return next;
      });
    },
    [resetClock, slides],
  );

  const togglePlayback = useCallback(() => {
    const now = performance.now();
    setPaused((current) => {
      if (current) {
        startedAtRef.current =
          now - (slides[slideIndex].durationMs - elapsedMs);
        pausedRef.current = false;
        return false;
      }
      pausedRef.current = true;
      return true;
    });
  }, [elapsedMs, slideIndex, slides]);

  const exitDisplay = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onExit();
  }, [onExit]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
    }
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      controlsTimerRef.current = null;
    }, 3_000);
  }, []);

  useEffect(() => {
    resetClock(slideIndex);
  }, [resetClock, slideIndex]);

  useEffect(() => {
    if (paused) return;
    const update = () => {
      const slide = slides[slideIndex];
      const elapsed = Math.min(
        slide.durationMs,
        performance.now() - startedAtRef.current,
      );
      setElapsedMs(elapsed);
      if (elapsed >= slide.durationMs) moveSlide(1);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [moveSlide, paused, slideIndex, slides]);

  useEffect(() => {
    showControls();
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    return () => {
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, [showControls]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSlide(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSlide(1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        exitDisplay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exitDisplay, moveSlide, togglePlayback]);

  useEffect(() => {
    let ownedFullscreen = Boolean(document.fullscreenElement);
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) {
        ownedFullscreen = true;
      } else if (ownedFullscreen && !exitingRef.current) {
        exitingRef.current = true;
        onExit();
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [onExit]);

  const slide = slides[slideIndex];
  const progress =
    slide.durationMs > 0 ? Math.min(1, elapsedMs / slide.durationMs) : 1;
  const slideContent = useMemo(() => {
    switch (slide.id) {
      case "overview":
        return (
          <OverviewSlide
            data={data}
            dataSource={dataSource}
            c={c}
            elapsedMs={elapsedMs}
            reducedMotion={reducedMotion}
            total={slides.length}
          />
        );
      case "downloads":
        return (
          <DownloadsSlide
            data={data}
            dataSource={dataSource}
            c={c}
            windowSize={windowSize}
          />
        );
      case "repositories":
        return <RepositoriesSlide data={data} dataSource={dataSource} c={c} />;
      case "community":
        return <CommunitySlide data={data} dataSource={dataSource} c={c} />;
      case "geography":
        return <GeographySlide data={data} dataSource={dataSource} c={c} />;
      case "taccap-video":
        return <TacCapVideoSlide c={c} elapsedMs={elapsedMs} paused={paused} />;
    }
  }, [
    c,
    data,
    dataSource,
    elapsedMs,
    paused,
    reducedMotion,
    slide.id,
    slides.length,
    windowSize,
  ]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={c.title}
      onMouseMove={showControls}
      className="fixed inset-0 z-[1000] overflow-hidden bg-[#0d1117] text-slate-100"
    >
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_18%,rgba(34,211,238,0.18),transparent_30%),radial-gradient(circle_at_82%_20%,rgba(167,139,250,0.16),transparent_32%),linear-gradient(135deg,rgba(52,211,153,0.08),transparent_45%)]"
        aria-hidden="true"
      />
      <div className="relative z-10 grid h-full min-h-0 grid-rows-[auto_1fr_auto]">
        <DisplayHeader
          data={data}
          dataSource={dataSource}
          c={c}
          locale={locale}
        />
        <main className="min-h-0 px-8 py-5">
          <div key={slide.id} className="h-full">
            {slideContent}
          </div>
        </main>
        <footer
          aria-label={c.progress}
          className="grid gap-2 border-t border-white/10 px-8 py-4"
          style={{
            gridTemplateColumns: `repeat(${slides.length}, minmax(0, 1fr))`,
          }}
        >
          {slides.map((item, index) => {
            const value =
              index < slideIndex ? 1 : index === slideIndex ? progress : 0;
            return (
              <div key={item.id} className="min-w-0">
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full origin-left rounded-full bg-cyan-300 transition-transform duration-100"
                    style={{ transform: `scaleX(${value})` }}
                  />
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-2 text-xs">
                  <span className="font-mono text-slate-500">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <strong className="truncate text-slate-300">
                    {item.title}
                  </strong>
                  <span className="ml-auto text-slate-600">
                    {item.durationMs / 1_000}s
                  </span>
                </div>
              </div>
            );
          })}
        </footer>
      </div>
      <div
        className={`fixed right-6 top-6 z-[1001] flex gap-2 rounded-full border border-white/10 bg-black/45 p-2 shadow-2xl backdrop-blur transition-opacity ${
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!controlsVisible}
      >
        <button
          type="button"
          onClick={() => moveSlide(-1)}
          aria-label={c.previous}
          title={c.previous}
          tabIndex={controlsVisible ? 0 : -1}
          className="grid h-10 w-10 place-items-center rounded-full text-slate-200 hover:bg-white/10"
        >
          <FiChevronLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={togglePlayback}
          aria-label={paused ? c.resume : c.pause}
          title={paused ? c.resume : c.pause}
          tabIndex={controlsVisible ? 0 : -1}
          className="grid h-10 w-10 place-items-center rounded-full text-slate-200 hover:bg-white/10"
        >
          {paused ? (
            <FiPlay aria-hidden="true" />
          ) : (
            <FiPause aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => moveSlide(1)}
          aria-label={c.next}
          title={c.next}
          tabIndex={controlsVisible ? 0 : -1}
          className="grid h-10 w-10 place-items-center rounded-full text-slate-200 hover:bg-white/10"
        >
          <FiChevronRight aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={exitDisplay}
          aria-label={c.exit}
          title={c.exit}
          tabIndex={controlsVisible ? 0 : -1}
          className="grid h-10 w-10 place-items-center rounded-full text-slate-200 hover:bg-white/10"
        >
          <FiX aria-hidden="true" />
        </button>
      </div>
      {paused && (
        <div className="fixed bottom-24 left-1/2 z-[1001] -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-4 py-2 text-xs font-medium uppercase text-slate-300 backdrop-blur">
          {c.paused}
        </div>
      )}
    </div>,
    document.body,
  );
}

"use client";

import Link from "next/link";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
  useLayoutEffect,
  useTransition,
} from "react";
import { useSearchParams } from "next/navigation";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import PlaybackBar from "@/components/playback-bar";
import {
  TimeProvider,
  useTimeControls,
  useTimeState,
} from "@/context/time-context";
import { FlaggedEpisodesProvider } from "@/context/flagged-episodes-context";
import {
  AnnotationsProvider,
  useAnnotations,
} from "@/context/annotations-context";
import { AnnotationsPanel } from "@/components/annotations-panel";
import { AnnotationsTimeline } from "@/components/annotations-timeline";
import { SubtaskPanel } from "@/components/subtask-panel";
import Sidebar from "@/components/side-nav";
import LanguageSwitcher from "@/components/language-switcher";
import { useLocale, useT } from "@/context/locale-context";
import StatsPanel from "@/components/stats-panel";
import OverviewPanel from "@/components/overview-panel";
import Loading from "@/components/loading-component";
import { hasURDFSupport } from "@/lib/so101-robot";
import {
  computeColumnMinMax,
  getEpisodeDataSafe,
  loadAllEpisodeLengthsV3,
  loadAllEpisodeFrameInfo,
  loadCrossEpisodeActionVariance,
  type EpisodeData,
  type ColumnMinMax,
  type EpisodeLengthStats,
  type EpisodeFramesData,
  type CrossEpisodeVarianceData,
} from "./fetch-data";
import { getDatasetVersionAndInfo } from "@/utils/versionUtils";
import type { DatasetMetadata } from "@/utils/parquetUtils";
import {
  encodeLocalDatasetPath,
  getDisplayNameForRepoId,
  getLocalDatasetPath,
  repoIdFromRouteParams,
  routePathFromRepoId,
} from "@/utils/datasetRoute";
import { type DatasetTags, EMPTY_TAGS } from "@/lib/dataset-tags";
import DatasetTagsEditor from "@/components/dataset-tags-editor";

const URDFViewer = lazy(() => import("@/components/urdf-viewer"));
const ActionInsightsPanel = lazy(
  () => import("@/components/action-insights-panel"),
);
const FilteringPanel = lazy(() => import("@/components/filtering-panel"));
const DoctorPanel = lazy(() => import("@/components/doctor-panel"));
const ParquetTablePanel = lazy(
  () => import("@/components/parquet-table-panel"),
);
// Recharts is ~150KB gz and not above-the-fold (videos render first on the
// Episodes tab). Lazy-load it so the initial chunk can ship faster and
// videos start downloading in parallel with the chart bundle.
const DataRecharts = lazy(() => import("@/components/data-recharts"));

/** Skip every global shortcut while typing in a field. */
function isKeyboardFocusInsideTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  const tag = target.tagName;
  // The playback slider is an <input>, but it is *the* thing the shortcuts
  // drive — keep them global while it has focus so clicking the scrubber
  // doesn't disable Space/arrows.
  if (tag === "INPUT") {
    return (target as HTMLInputElement).type !== "range";
  }
  return tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Space *activates* a focused button or link. Stealing it for play/pause
 * would leave every button in the viewer un-activatable by keyboard, so the
 * Space shortcut yields here — the arrow shortcuts, which these elements
 * don't consume, deliberately do not.
 */
function isKeyboardFocusOnActivatable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "BUTTON" || (tag === "A" && target.hasAttribute("href"));
}

type ActiveTab =
  | "episodes"
  | "annotations"
  | "statistics"
  | "frames"
  | "insights"
  | "doctor"
  | "filtering"
  | "urdf"
  | "parquet";

// Subscribes to `currentTime` so its parent doesn't have to. Keeping this
// in a leaf component means the throttled time ticks (~12.5/s during
// playback) only re-render this no-op sub-tree, not the entire 700-line
// EpisodeViewerInner. Vercel rule: rerender-defer-reads.
function UrlTimeSync({
  episodeKey,
  suspendedRef,
  transitioning,
}: {
  episodeKey: number;
  suspendedRef: { current: boolean };
  transitioning: boolean;
}) {
  const { currentTime, isPlaying } = useTimeState();
  const searchParams = useSearchParams();
  const lastUrlSecondRef = useRef<number>(-1);

  useEffect(() => {
    lastUrlSecondRef.current = -1;
  }, [episodeKey]);

  // Only update the URL ?t= param when the integer second changes, and
  // only while paused — replacing state every frame during playback would
  // spam the browser's history.
  useEffect(() => {
    if (isPlaying || transitioning || suspendedRef.current) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(searchParams.toString());
      newParams.set("t", currentSec.toString());
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
    }
  }, [isPlaying, currentTime, searchParams, suspendedRef, transitioning]);

  return null;
}

// Hoisted to module scope. Defining inside EpisodeViewerInner created a new
// component type on every parent render — and the parent re-renders ~12.5×/s
// during playback because it consumes `currentTime` from useTime. React
// would unmount and remount every tab on every tick.
function TabButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`relative shrink-0 px-5 py-3 text-xs font-medium tracking-wide uppercase transition-colors ${
        active ? "text-cyan-300" : "text-slate-400 hover:text-slate-100"
      }`}
    >
      {label}
      <span
        className={`pointer-events-none absolute bottom-0 left-3 right-3 h-px transition-all ${
          active
            ? "bg-cyan-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]"
            : "bg-transparent"
        }`}
      />
    </button>
  );
}

export default function EpisodeViewer({
  org,
  dataset,
  episodeId,
}: {
  org: string;
  dataset: string;
  episodeId: number;
}) {
  const t = useT();
  const [data, setData] = useState<EpisodeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(episodeId);
  const requestIdRef = useRef(0);
  const loadedDatasetRef = useRef<string | null>(null);
  const datasetKey = `${org}/${dataset}`;

  useEffect(() => {
    setSelectedEpisodeId(episodeId);
  }, [datasetKey, episodeId]);

  useEffect(() => {
    const handlePopState = () => {
      const match = window.location.pathname.match(/\/episode_(\d+)\/?$/);
      if (!match) return;
      const nextEpisode = Number(match[1]);
      if (Number.isSafeInteger(nextEpisode)) {
        setSelectedEpisodeId(nextEpisode);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [datasetKey]);

  const selectEpisode = useCallback(
    (nextEpisode: number) => {
      if (nextEpisode === selectedEpisodeId) return;
      // Mark the transition in the same event as the selection. This pauses
      // the currently mounted player before React gets a chance to paint one
      // more frame of the previous episode underneath the loading overlay.
      setEpisodeLoading(true);
      setSelectedEpisodeId(nextEpisode);
      const repoId = repoIdFromRouteParams(org, dataset);
      window.history.pushState(
        { episodeId: nextEpisode },
        "",
        routePathFromRepoId(repoId, nextEpisode),
      );
    },
    [dataset, org, selectedEpisodeId],
  );

  useEffect(() => {
    if (Number.isNaN(selectedEpisodeId)) {
      setError(t("err.invalidEpisode"));
      setData(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    setError(null);
    const changingDataset = loadedDatasetRef.current !== datasetKey;
    if (changingDataset) {
      setData(null);
    }
    setEpisodeLoading(!changingDataset && loadedDatasetRef.current !== null);

    // Let the transition render once before starting parquet decoding. A
    // cache hit can still enter a CPU-heavy parquet parse synchronously in a
    // promise continuation; starting it directly from this effect can block
    // the browser's next paint, making the user see the old episode first and
    // the Loading overlay only afterwards. A macrotask gives the urgent
    // loading state a paint opportunity without adding meaningful latency.
    const timerId = window.setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      getEpisodeDataSafe(org, dataset, selectedEpisodeId)
        .then(({ data: loaded, error: loadError }) => {
          if (requestIdRef.current !== requestId) return;
          if (loadError) {
            setError(loadError);
            if (changingDataset) setData(null);
            return;
          }
          loadedDatasetRef.current = datasetKey;
          setData(loaded ?? null);
        })
        .catch((err) => {
          if (requestIdRef.current !== requestId) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message || t("err.unknown"));
          if (changingDataset) setData(null);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setEpisodeLoading(false);
        });
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [datasetKey, org, dataset, selectedEpisodeId, t]);

  if (error && !data) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-red-300">
        <div className="panel-raised max-w-xl p-6 border-red-500/40">
          <h2 className="text-xl font-medium mb-3">{t("err.title")}</h2>
          <p className="text-sm font-mono whitespace-pre-wrap text-red-200/90">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="relative h-screen bg-[var(--bg)]">
        <Loading />
      </div>
    );
  }

  return (
    <TimeProvider duration={data!.duration} resetKey={data!.episodeId}>
      <FlaggedEpisodesProvider>
        <AnnotationsProvider>
          <EpisodeBootstrap data={data!} />
          <EpisodeViewerInner
            data={data!}
            org={org}
            dataset={dataset}
            episodeLoading={episodeLoading}
            episodeError={error}
            selectedEpisodeId={selectedEpisodeId}
            onEpisodeSelect={selectEpisode}
          />
        </AnnotationsProvider>
      </FlaggedEpisodesProvider>
    </TimeProvider>
  );
}

/** Wires the loaded episode into the AnnotationsProvider. */
function EpisodeBootstrap({ data }: { data: EpisodeData }) {
  const { setEpisode } = useAnnotations();
  useEffect(() => {
    setEpisode(
      data.episodeId,
      { repoId: data.datasetInfo.repoId },
      data.languageAtoms,
      data.frameTimestamps,
    );
  }, [
    data.episodeId,
    data.datasetInfo.repoId,
    data.languageAtoms,
    data.frameTimestamps,
    setEpisode,
  ]);
  return null;
}

function EpisodeViewerInner({
  data,
  org,
  dataset,
  episodeLoading,
  episodeError,
  selectedEpisodeId,
  onEpisodeSelect,
}: {
  data: EpisodeData;
  org?: string;
  dataset?: string;
  episodeLoading: boolean;
  episodeError: string | null;
  selectedEpisodeId: number;
  onEpisodeSelect: (episodeId: number) => void;
}) {
  const { t, tRich } = useLocale();
  const {
    datasetInfo,
    episodeId,
    videosInfo,
    chartDataGroups,
    velocityChartDataGroups,
    episodes,
    task,
  } = data;

  const [videosReady, setVideosReady] = useState(!videosInfo.length);
  const [chartsReady, setChartsReady] = useState(false);
  const [chartEpisodeId, setChartEpisodeId] = useState<number | null>(null);
  const repoId = org && dataset ? repoIdFromRouteParams(org, dataset) : null;
  const datasetDisplayName = getDisplayNameForRepoId(datasetInfo.repoId);
  // Compute the encoded URL segment from the in-memory repoId so the viewer can
  // reach the per-dataset routes (tags, parquet, …) without it being threaded
  // down from the page.
  const localDatasetPath = getLocalDatasetPath(datasetInfo.repoId);
  const encodedDatasetPath = localDatasetPath
    ? encodeLocalDatasetPath(localDatasetPath)
    : null;
  const [tags, setTags] = useState<DatasetTags>(EMPTY_TAGS);
  const [tagsEditorOpen, setTagsEditorOpen] = useState(false);

  useEffect(() => {
    if (!encodedDatasetPath) return;
    let cancelled = false;
    fetch(`/api/local-datasets/${encodedDatasetPath}/tags`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setTags(data as DatasetTags);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [encodedDatasetPath]);

  const searchParams = useSearchParams();

  // Tab state & lazy stats — read sessionStorage in the initializer so the
  // correct tab renders on the very first frame (no post-mount flash).
  // Safe because EpisodeViewerInner only mounts client-side (behind a loading gate).
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("activeTab");
      if (
        stored &&
        [
          "episodes",
          "annotations",
          "statistics",
          "frames",
          "insights",
          "doctor",
          "filtering",
          "urdf",
          "parquet",
        ].includes(stored)
      ) {
        return stored as ActiveTab;
      }
    }
    return "episodes";
  });
  // A ref lets the URL synchronizer and imperative media pause react to a
  // click immediately, without forcing the heavyweight viewer to render an
  // urgent state update before the transition starts.
  const episodeSwitchRef = useRef(false);
  const switchTimingRef = useRef<{
    targetEpisode: number;
    startedAt: number | null;
    shellLogged: boolean;
    videosLogged: boolean;
    chartsLogged: boolean;
  }>({
    targetEpisode: episodeId,
    // Initial page loading is timed by Next/server tooling. This clock is
    // deliberately armed only by an in-viewer episode switch.
    startedAt: null,
    shellLogged: false,
    videosLogged: false,
    chartsLogged: false,
  });
  const chartReadyFrameRef = useRef<number | null>(null);
  // Keep one loading layer mounted in the DOM. During an episode click the
  // heavy viewer subtree can take a noticeable synchronous render; an
  // imperative visibility flip lets the browser paint feedback before that
  // transition render starts.
  const instantLoadingRef = useRef<HTMLDivElement>(null);
  const showInstantLoading = useCallback(() => {
    const element = instantLoadingRef.current;
    if (!element) return;
    element.style.opacity = "1";
    element.style.pointerEvents = "auto";
    element.setAttribute("aria-hidden", "false");
  }, []);
  const syncInstantLoading = useCallback((visible: boolean) => {
    const element = instantLoadingRef.current;
    if (!element) return;
    element.style.opacity = visible ? "1" : "0";
    element.style.pointerEvents = visible ? "auto" : "none";
    element.setAttribute("aria-hidden", String(!visible));
  }, []);
  const [, startEpisodeTransition] = useTransition();
  const episodeTransitioning =
    episodeLoading || selectedEpisodeId !== episodeId;
  // The full-page layer only guards the data transition. Media decoding and
  // Recharts rendering have their own local placeholders, so they no longer
  // hold the entire episode shell behind LOADING.
  const isLoading = episodeTransitioning;
  const playerLoading = episodeTransitioning || Boolean(episodeError);

  // Browser back/forward does not pass through handleEpisodeSelect. Start a
  // timing window and suspend URL time writes as soon as that transition is
  // observed as well.
  useLayoutEffect(() => {
    const timing = switchTimingRef.current;
    if (!episodeTransitioning || timing.targetEpisode === selectedEpisodeId) {
      return;
    }
    episodeSwitchRef.current = true;
    switchTimingRef.current = {
      targetEpisode: selectedEpisodeId,
      startedAt: performance.now(),
      shellLogged: false,
      videosLogged: false,
      chartsLogged: false,
    };
  }, [episodeTransitioning, selectedEpisodeId]);

  useEffect(() => {
    if (chartReadyFrameRef.current !== null) {
      window.cancelAnimationFrame(chartReadyFrameRef.current);
      chartReadyFrameRef.current = null;
    }
    setVideosReady(!videosInfo.length);
    setChartsReady(false);
    setChartEpisodeId(null);
  }, [episodeId, videosInfo.length]);

  useEffect(
    () => () => {
      if (chartReadyFrameRef.current !== null) {
        window.cancelAnimationFrame(chartReadyFrameRef.current);
      }
    },
    [],
  );

  // Render the expensive SVG charts only after the new media frame is ready.
  // Doing this in an idle callback keeps the data commit / first-frame paint
  // on the same short path as 3D Replay instead of making them wait for every
  // Recharts node to be reconciled.
  useEffect(() => {
    if (
      activeTab !== "episodes" ||
      episodeTransitioning ||
      !videosReady ||
      chartEpisodeId === episodeId
    ) {
      return;
    }

    let idleId: number | null = null;
    let timerId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      const mountCharts = () => setChartEpisodeId(episodeId);
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(mountCharts, { timeout: 300 });
      } else {
        timerId = window.setTimeout(mountCharts, 50);
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [activeTab, chartEpisodeId, episodeId, episodeTransitioning, videosReady]);

  // Keep stale time from the previous episode out of the new route. The
  // synchronizer is suspended for the click, and we release it on the next
  // frame after TimeProvider has reset the clock to zero.
  useEffect(() => {
    if (!episodeSwitchRef.current) return;
    if (episodeError || (!episodeTransitioning && !episodeLoading)) {
      const frameId = window.requestAnimationFrame(() => {
        episodeSwitchRef.current = false;
      });
      return () => window.cancelAnimationFrame(frameId);
    }
  }, [episodeError, episodeLoading, episodeTransitioning, episodeId]);

  useLayoutEffect(() => {
    syncInstantLoading(isLoading);
  }, [isLoading, syncInstantLoading]);

  useEffect(() => {
    const timing = switchTimingRef.current;
    if (
      isLoading ||
      timing.startedAt === null ||
      timing.targetEpisode !== episodeId ||
      timing.shellLogged
    ) {
      return;
    }
    timing.shellLogged = true;
    console.log(
      `[perf] episode ${episodeId}: shell switched in ${(performance.now() - timing.startedAt).toFixed(0)}ms`,
    );
  }, [episodeId, isLoading]);
  const [, setColumnMinMax] = useState<ColumnMinMax[] | null>(null);
  const [episodeLengthStats, setEpisodeLengthStats] =
    useState<EpisodeLengthStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsLoadedRef = useRef(false);
  const [episodeFramesData, setEpisodeFramesData] =
    useState<EpisodeFramesData | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const framesLoadedRef = useRef(false);
  const [framesFlaggedOnly, setFramesFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("framesFlaggedOnly") === "true"
      : false,
  );
  const [sidebarFlaggedOnly, setSidebarFlaggedOnly] = useState(() =>
    typeof window !== "undefined"
      ? sessionStorage.getItem("sidebarFlaggedOnly") === "true"
      : false,
  );
  const [crossEpData, setCrossEpData] =
    useState<CrossEpisodeVarianceData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsLoadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    statsLoadedRef.current = false;
    framesLoadedRef.current = false;
    insightsLoadedRef.current = false;
    setEpisodeLengthStats(null);
    setEpisodeFramesData(null);
    setCrossEpData(null);
  }, [datasetInfo.repoId]);

  // Eagerly load the URDFViewer bundle + warm the STL geometry cache while
  // the user is on the Episodes tab, so the 3D Replay tab opens faster.
  useEffect(() => {
    if (
      hasURDFSupport(datasetInfo.robot_type) &&
      datasetInfo.codebase_version >= "v3.0"
    ) {
      void import("@/components/urdf-viewer");
    }
  }, [datasetInfo.robot_type, datasetInfo.codebase_version]);

  // Persist UI state across episode navigations. One effect instead of
  // three near-identical writes — fewer commit hooks per render and the
  // intent (mirror three primitives to sessionStorage) reads as one unit.
  useEffect(() => {
    sessionStorage.setItem("activeTab", activeTab);
    sessionStorage.setItem("sidebarFlaggedOnly", String(sidebarFlaggedOnly));
    sessionStorage.setItem("framesFlaggedOnly", String(framesFlaggedOnly));
  }, [activeTab, sidebarFlaggedOnly, framesFlaggedOnly]);

  const loadStats = () => {
    if (statsLoadedRef.current) return;
    statsLoadedRef.current = true;
    setStatsLoading(true);
    setColumnMinMax(computeColumnMinMax(data.chartDataGroups));
    if (repoId) {
      getDatasetVersionAndInfo(repoId)
        .then(({ version, info }) => {
          if (version !== "v3.0") return null;
          return loadAllEpisodeLengthsV3(repoId, version, info.fps);
        })
        .then((result) => {
          if (!mountedRef.current) return;
          setEpisodeLengthStats(result);
        })
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setStatsLoading(false);
        });
    } else {
      setStatsLoading(false);
    }
  };

  const loadFrames = () => {
    if (framesLoadedRef.current || !repoId) return;
    framesLoadedRef.current = true;
    setFramesLoading(true);
    getDatasetVersionAndInfo(repoId)
      .then(({ version, info }) =>
        loadAllEpisodeFrameInfo(
          repoId,
          version,
          info as unknown as DatasetMetadata,
        ),
      )
      .then((result) => {
        if (!mountedRef.current) return;
        setEpisodeFramesData(result);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setEpisodeFramesData({ cameras: [], framesByCamera: {} });
      })
      .finally(() => {
        if (mountedRef.current) setFramesLoading(false);
      });
  };

  const loadInsights = () => {
    if (insightsLoadedRef.current || !repoId) return;
    insightsLoadedRef.current = true;
    setInsightsLoading(true);
    getDatasetVersionAndInfo(repoId)
      .then(({ version, info }) =>
        loadCrossEpisodeActionVariance(
          repoId,
          version,
          info as unknown as DatasetMetadata,
          info.fps,
        ),
      )
      .then((result) => {
        if (!mountedRef.current) return;
        setCrossEpData(result);
      })
      .catch((err) => console.error("[cross-ep] Failed:", err))
      .finally(() => {
        if (mountedRef.current) setInsightsLoading(false);
      });
  };

  // Re-trigger data loading for the restored tab on mount
  useEffect(() => {
    if (activeTab === "statistics") loadStats();
    if (activeTab === "doctor") loadStats();
    if (activeTab === "frames") loadFrames();
    if (activeTab === "insights") loadInsights();
    if (activeTab === "filtering") {
      loadStats();
      loadInsights();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabChange = (tab: ActiveTab) => {
    setActiveTab(tab);
    if (tab === "statistics") loadStats();
    if (tab === "doctor") loadStats();
    if (tab === "frames") loadFrames();
    if (tab === "insights") loadInsights();
    if (tab === "filtering") {
      loadStats();
      loadInsights();
    }
  };

  // `currentTime` is intentionally NOT read here. Subscribing to it would
  // re-render this 700-line component every ~80ms during playback. The
  // <UrlTimeSync /> child handles its only consumer (the ?t= URL writer).
  // `seek` and `setIsPlaying` are stable references from useCallback /
  // useState — they don't drive renders.
  const { seek, setIsPlaying } = useTimeControls();
  const handleVideosReady = useCallback(() => {
    setVideosReady(true);
    const timing = switchTimingRef.current;
    if (
      timing.startedAt !== null &&
      timing.targetEpisode === episodeId &&
      !timing.videosLogged
    ) {
      timing.videosLogged = true;
      console.log(
        `[perf] episode ${episodeId}: videos decoded in ${(performance.now() - timing.startedAt).toFixed(0)}ms`,
      );
    }
  }, [episodeId]);
  const handleChartsReady = useCallback(() => {
    if (chartReadyFrameRef.current !== null) {
      window.cancelAnimationFrame(chartReadyFrameRef.current);
    }
    // ResponsiveContainer measures itself after its parent commits and then
    // performs the expensive SVG render. Two frames include that second
    // commit, so this timing reflects pixels painted rather than the wrapper
    // component's earlier effect.
    chartReadyFrameRef.current = window.requestAnimationFrame(() => {
      chartReadyFrameRef.current = window.requestAnimationFrame(() => {
        chartReadyFrameRef.current = null;
        const timing = switchTimingRef.current;
        setChartsReady(true);
        if (
          timing.startedAt !== null &&
          timing.targetEpisode === episodeId &&
          !timing.chartsLogged
        ) {
          timing.chartsLogged = true;
          console.log(
            `[perf] episode ${episodeId}: charts painted in ${(performance.now() - timing.startedAt).toFixed(0)}ms`,
          );
        }
      });
    });
  }, [episodeId]);
  const handleEpisodeSelect = useCallback(
    (nextEpisode: number) => {
      if (nextEpisode === selectedEpisodeId) return;
      // Do not seek the old episode here. seek(0) synchronously notified every
      // time subscriber (and could trigger several media seeks) before React
      // had a chance to paint the loading state. The TimeProvider resets the
      // clock when the new EpisodeData arrives, while the player pauses from
      // its loading prop.
      episodeSwitchRef.current = true;
      switchTimingRef.current = {
        targetEpisode: nextEpisode,
        startedAt: performance.now(),
        shellLogged: false,
        videosLogged: false,
        chartsLogged: false,
      };
      showInstantLoading();
      // Pause is urgent: leaving it inside the transition lets another
      // playback tick (and the chart subscribers) run while the data load is
      // being scheduled.
      setIsPlaying(false);
      // Keep the click task paintable. The old implementation updated the
      // whole viewer synchronously, so the spinner was inserted only after a
      // long render. A transition lets the imperative overlay get one frame
      // on screen before the episode/data subtree is reconciled.
      startEpisodeTransition(() => {
        onEpisodeSelect(nextEpisode);
      });
    },
    [
      onEpisodeSelect,
      episodeSwitchRef,
      selectedEpisodeId,
      setIsPlaying,
      showInstantLoading,
      startEpisodeTransition,
    ],
  );

  // URDF playback toggle — populated by URDFViewer after its first mount.
  const urdfPlayToggleRef = useRef<(() => void) | undefined>(undefined);
  const urdfSeekByRef = useRef<((seconds: number) => void) | undefined>(
    undefined,
  );
  // Which annotation system the Annotations tab's right pane is showing.
  const [annotationEditor, setAnnotationEditor] = useState<
    "atoms" | "subtasks"
  >("atoms");

  const [urdfMounted, setUrdfMounted] = useState(activeTab === "urdf");

  useEffect(() => {
    if (activeTab === "urdf") setUrdfMounted(true);
  }, [activeTab]);

  // Pagination state
  const pageSize = 100;
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(episodes.length / pageSize);
  const paginatedEpisodes = episodes.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Apply a URL time only after the route and loaded episode agree. Without
  // this guard, a paused `?t=` from the previous episode can issue a second
  // seek while the new media is already decoding its first frame.
  const appliedUrlTimeRef = useRef<string | null>(null);
  useEffect(() => {
    if (episodeLoading || selectedEpisodeId !== episodeId) return;
    const timeParam = searchParams.get("t");
    if (!timeParam) {
      appliedUrlTimeRef.current = null;
      return;
    }
    const applyKey = `${episodeId}:${timeParam}`;
    if (appliedUrlTimeRef.current === applyKey) return;
    const timeValue = parseFloat(timeParam);
    if (!isNaN(timeValue)) {
      appliedUrlTimeRef.current = applyKey;
      seek(timeValue);
    }
  }, [episodeId, episodeLoading, searchParams, seek, selectedEpisodeId]);

  // Initialize page based on the current episode. Splitting this out from
  // the keyboard listener effect lets the listener attach exactly once.
  useEffect(() => {
    const episodeIndex = episodes.indexOf(selectedEpisodeId);
    if (episodeIndex !== -1) {
      setCurrentPage(Math.floor(episodeIndex / pageSize) + 1);
    }
  }, [episodes, pageSize, selectedEpisodeId]);

  // Mirror the values the keydown handler needs into a ref. Without this,
  // `useCallback` would produce a new handler whenever `activeTab` /
  // `episodeId` changed, and the keydown effect would
  // detach + reattach the listener each time. Now the listener attaches
  // once and reads the latest state via the ref.
  // Vercel rule: advanced-event-handler-refs.
  const keyStateRef = useRef({
    activeTab,
    episodeId: selectedEpisodeId,
    episodes,
    onEpisodeSelect: handleEpisodeSelect,
  });
  keyStateRef.current = {
    activeTab,
    episodeId: selectedEpisodeId,
    episodes,
    onEpisodeSelect: handleEpisodeSelect,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { key } = e;
      const s = keyStateRef.current;
      const inTextEntry = isKeyboardFocusInsideTextEntry(e.target);

      if (key === " ") {
        if (inTextEntry || isKeyboardFocusOnActivatable(e.target)) return;
        e.preventDefault();
        if (s.activeTab === "urdf") {
          urdfPlayToggleRef.current?.();
        } else {
          setIsPlaying((prev: boolean) => !prev);
        }
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        if (inTextEntry) return;
        e.preventDefault();
        const nextEpisodeId =
          key === "ArrowDown" ? s.episodeId + 1 : s.episodeId - 1;
        const lowestEpisodeId = s.episodes[0];
        const highestEpisodeId = s.episodes[s.episodes.length - 1];
        if (
          nextEpisodeId >= lowestEpisodeId &&
          nextEpisodeId <= highestEpisodeId
        ) {
          s.onEpisodeSelect(nextEpisodeId);
        }
      } else if (
        s.activeTab === "urdf" &&
        (key === "ArrowLeft" || key === "ArrowRight")
      ) {
        if (inTextEntry) return;
        e.preventDefault();
        urdfSeekByRef.current?.(key === "ArrowLeft" ? -5 : 5);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // setIsPlaying is stable; the rest is read via keyStateRef.
  }, [setIsPlaying]);

  // Pagination functions
  const nextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  const prevPage = () => {
    if (currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const renderTab = (tab: ActiveTab, label: string, title?: string) => (
    <TabButton
      active={activeTab === tab}
      onClick={() => handleTabChange(tab)}
      label={label}
      title={title}
    />
  );

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[var(--bg)] text-[var(--text-primary)]">
      <UrlTimeSync
        episodeKey={episodeId}
        suspendedRef={episodeSwitchRef}
        transitioning={episodeTransitioning}
      />
      {/* Top tab bar */}
      <div className="flex items-center overflow-x-auto border-b border-white/5 bg-[var(--surface-0)] shrink-0">
        <Link
          href="/"
          className="flex shrink-0 items-center border-r border-white/5 px-5 py-3 text-base font-bold tracking-tight transition-opacity hover:opacity-80"
          title={t("viewer.brandTitle")}
        >
          <span className="bg-gradient-to-r from-cyan-300 to-sky-300 bg-clip-text text-transparent">
            {t("brand.part1")}
          </span>
          <span className="text-emerald-400">{t("brand.part2")}</span>
        </Link>
        {renderTab("episodes", t("viewer.tab.episodes"))}
        {renderTab(
          "annotations",
          t("viewer.tab.annotations"),
          t("viewer.tab.annotationsTitle"),
        )}
        {hasURDFSupport(datasetInfo.robot_type) &&
          datasetInfo.codebase_version >= "v3.0" &&
          renderTab("urdf", t("viewer.tab.urdf"))}
        {renderTab("statistics", t("viewer.tab.statistics"))}
        {renderTab("filtering", t("viewer.tab.filtering"))}
        {renderTab("frames", t("viewer.tab.frames"))}
        {renderTab("insights", t("viewer.tab.insights"))}
        {renderTab(
          "doctor",
          t("viewer.tab.doctor"),
          t("viewer.tab.doctorTitle"),
        )}
        {renderTab(
          "parquet",
          t("viewer.tab.parquet"),
          t("viewer.tab.parquetTitle"),
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 pr-3">
          <Link
            href="/"
            className="inline-flex items-center px-2 py-3 text-xs font-medium tracking-wide uppercase text-slate-400 transition-colors hover:text-slate-100"
          >
            {t("viewer.home")}
          </Link>
          <LanguageSwitcher size="bar" />
        </div>
      </div>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — on Episodes, Annotations and 3D Replay tabs */}
        {(activeTab === "episodes" ||
          activeTab === "annotations" ||
          activeTab === "urdf") && (
          <Sidebar
            datasetInfo={datasetInfo}
            paginatedEpisodes={paginatedEpisodes}
            episodeId={selectedEpisodeId}
            totalPages={totalPages}
            currentPage={currentPage}
            prevPage={prevPage}
            nextPage={nextPage}
            showFlaggedOnly={sidebarFlaggedOnly}
            onShowFlaggedOnlyChange={setSidebarFlaggedOnly}
            onEpisodeSelect={
              activeTab === "episodes" ||
              activeTab === "urdf" ||
              activeTab === "annotations"
                ? handleEpisodeSelect
                : undefined
            }
          />
        )}

        {/* Main content */}
        <div
          className={`flex flex-col gap-4 p-4 flex-1 relative ${
            isLoading || activeTab === "annotations"
              ? "overflow-hidden"
              : "overflow-y-auto"
          }`}
        >
          <div
            ref={instantLoadingRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-30 opacity-0"
          >
            <Loading />
          </div>
          {episodeError && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--bg)]/80 p-6 backdrop-blur-sm">
              <div className="panel-raised max-w-xl border-red-500/40 p-6">
                <h2 className="mb-3 text-xl font-medium text-red-300">
                  {t("err.title")}
                </h2>
                <p className="whitespace-pre-wrap font-mono text-sm text-red-200/90">
                  {episodeError}
                </p>
              </div>
            </div>
          )}

          {activeTab === "episodes" && (
            <>
              <div className="flex items-center gap-4 mb-2">
                <div className="min-w-0 flex-1">
                  <p
                    className="text-base font-medium truncate text-slate-200"
                    title={datasetDisplayName}
                  >
                    {datasetDisplayName}
                  </p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-0.5 tabular">
                    {t("ep.episodeLabel", { id: episodeId })}
                  </p>
                  {encodedDatasetPath &&
                    (tags.task || tags.scene || tags.objects.length > 0) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
                        {tags.task && (
                          <span
                            className="rounded bg-violet-500/25 px-1.5 py-0.5 font-medium text-violet-100"
                            title={t("grid.wordTask")}
                          >
                            {tags.task}
                          </span>
                        )}
                        {tags.scene && (
                          <span
                            className="rounded bg-sky-500/20 px-1.5 py-0.5 text-sky-200"
                            title={t("grid.wordScene")}
                          >
                            @{tags.scene}
                          </span>
                        )}
                        {tags.objects.map((o) => (
                          <span
                            key={o}
                            className="rounded bg-white/10 px-1.5 py-0.5 text-slate-300"
                            title={t("grid.wordObject")}
                          >
                            {o}
                          </span>
                        ))}
                      </div>
                    )}
                </div>
                {encodedDatasetPath && (
                  <button
                    type="button"
                    onClick={() => setTagsEditorOpen(true)}
                    title={t("grid.editTagsTitle")}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-400/50 hover:text-cyan-100"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 4 13.172V16h2.828l7.379-7.379-2.828-2.828z" />
                    </svg>
                    {t("ep.editTags")}
                  </button>
                )}
              </div>

              {/* Videos */}
              {videosInfo.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={videosInfo}
                  episodeId={episodeId}
                  loading={playerLoading}
                  onVideosReady={handleVideosReady}
                />
              )}

              {/* Language Instruction */}
              {task && (
                <div className="mb-6 panel p-4">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">
                    {t("ep.languageInstruction")}
                  </p>
                  <div className="mt-1.5 space-y-0.5 text-sm text-slate-200">
                    {task
                      .split("\n")
                      .map((instruction: string, index: number) => (
                        <p key={index}>{instruction}</p>
                      ))}
                  </div>
                </div>
              )}

              {/* Graph */}
              <div
                className="mb-4"
                aria-busy={chartEpisodeId !== episodeId || !chartsReady}
              >
                {chartEpisodeId === episodeId ? (
                  <Suspense fallback={null}>
                    <DataRecharts
                      data={chartDataGroups}
                      velocityData={velocityChartDataGroups}
                      flatData={data.flatChartData}
                      fps={datasetInfo.fps}
                      onChartsReady={handleChartsReady}
                    />
                  </Suspense>
                ) : (
                  <div
                    className="grid grid-cols-1 gap-4 md:grid-cols-2"
                    aria-hidden="true"
                  >
                    {chartDataGroups.map((_, index) => (
                      <div
                        key={index}
                        className="h-72 animate-pulse rounded-lg border border-white/5 bg-[var(--surface-1)]/25"
                      />
                    ))}
                  </div>
                )}
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "annotations" && (
            <div className="annotations-skin flex flex-1 min-h-0 flex-col gap-4">
              <div className="flex shrink-0 items-center gap-3">
                <p className="text-base font-medium text-slate-200 truncate">
                  {datasetInfo.repoId}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 tabular">
                  {t("ep.episodeLabel", { id: episodeId })}
                </p>
              </div>

              {/* Footage and editor on screen together — annotating while the
                  video is scrolled out of view is the whole problem this layout
                  exists to fix.

                  A grid, not nested flex columns, because the video has to be a
                  direct child of the scroller: `position: sticky` is confined to
                  its own parent's box, so a video nested inside the left column
                  unsticks the moment that column scrolls past — which at narrow
                  widths is exactly when the editor below it comes into view.
                  Grid placement lets the DOM stay [video][rest][editor] while
                  `lg` puts the first two in column 1 and the editor alongside. */}
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_27rem] lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_30rem]">
                {videosInfo.length > 0 && (
                  <div className="sticky top-0 z-20 bg-[var(--bg)] pb-3 lg:static lg:col-start-1 lg:row-start-1 lg:max-h-[55vh] lg:overflow-y-auto lg:bg-transparent lg:pb-0">
                    <SimpleVideosPlayer
                      videosInfo={videosInfo}
                      episodeId={episodeId}
                      loading={playerLoading}
                      onVideosReady={handleVideosReady}
                      annotationOverlay
                    />
                  </div>
                )}

                <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-2 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
                  <div className="grounding-intro">
                    <span className="section-kicker">
                      {t("ep.groundedVqa")}
                    </span>
                    <ul>
                      <li>{t("ep.vqaHint1")}</li>
                      <li>
                        {tRich("ep.vqaHint2", {
                          enter: <kbd>↵</kbd>,
                          esc: <kbd>Esc</kbd>,
                        })}
                      </li>
                    </ul>
                  </div>
                  <PlaybackBar />
                  <AnnotationsTimeline duration={data.duration} />
                </div>

                {/* Both annotation systems live here, one at a time: stacking
                    them would put the lower one back off screen. */}
                <div className="flex min-h-0 flex-col lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:overflow-hidden">
                  <div
                    role="tablist"
                    aria-label={t("ann.editorTablistAria")}
                    className="flex shrink-0 gap-1 border-b border-white/5"
                  >
                    {(
                      [
                        { id: "atoms", label: t("ann.title") },
                        { id: "subtasks", label: t("subtask.title") },
                      ] as const
                    ).map((entry) => (
                      <button
                        key={entry.id}
                        role="tab"
                        type="button"
                        aria-selected={annotationEditor === entry.id}
                        onClick={() => setAnnotationEditor(entry.id)}
                        className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] ${
                          annotationEditor === entry.id
                            ? "border-[var(--accent)] text-[var(--accent)]"
                            : "border-transparent text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                  <div className="min-h-0 flex-1 pt-3 lg:overflow-y-auto lg:pr-1">
                    {annotationEditor === "atoms" ? (
                      <AnnotationsPanel
                        cameraKeys={videosInfo.map((v) => v.filename)}
                      />
                    ) : (
                      <SubtaskPanel
                        encodedPath={encodedDatasetPath}
                        episodeId={episodeId}
                        fps={datasetInfo.fps}
                        task={task}
                        frameTimestamps={data.frameTimestamps}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "statistics" && (
            <StatsPanel
              datasetInfo={datasetInfo}
              episodeLengthStats={episodeLengthStats}
              loading={statsLoading}
            />
          )}

          {activeTab === "frames" && (
            <OverviewPanel
              data={episodeFramesData}
              loading={framesLoading}
              flaggedOnly={framesFlaggedOnly}
              onFlaggedOnlyChange={setFramesFlaggedOnly}
            />
          )}

          {activeTab === "insights" && (
            <Suspense fallback={<Loading />}>
              <ActionInsightsPanel
                flatChartData={data.flatChartData}
                fps={datasetInfo.fps}
                totalEpisodes={datasetInfo.total_episodes}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
              />
            </Suspense>
          )}

          {activeTab === "doctor" && encodedDatasetPath && (
            <Suspense fallback={<Loading />}>
              <DoctorPanel
                encodedPath={encodedDatasetPath}
                datasetName={datasetDisplayName}
                episodeLengthStats={episodeLengthStats}
                episodeLengthStatsLoading={statsLoading}
              />
            </Suspense>
          )}

          {activeTab === "filtering" && (
            <Suspense fallback={<Loading />}>
              <FilteringPanel
                repoId={datasetInfo.repoId}
                crossEpisodeData={crossEpData}
                crossEpisodeLoading={insightsLoading}
                episodeLengthStats={episodeLengthStats}
                flatChartData={data.flatChartData}
                onViewFlaggedEpisodes={() => {
                  setSidebarFlaggedOnly(true);
                  handleTabChange("episodes");
                }}
              />
            </Suspense>
          )}

          {urdfMounted && (
            <div
              className={activeTab === "urdf" ? "contents" : "hidden"}
              aria-hidden={activeTab !== "urdf"}
            >
              <Suspense fallback={<Loading />}>
                <URDFViewer
                  key={datasetInfo.repoId}
                  data={data}
                  active={
                    activeTab === "urdf" && !episodeLoading && !episodeError
                  }
                  playToggleRef={urdfPlayToggleRef}
                  seekByRef={urdfSeekByRef}
                />
              </Suspense>
            </div>
          )}

          {activeTab === "parquet" && (
            <Suspense fallback={<Loading />}>
              <ParquetTablePanel
                encodedPath={encodedDatasetPath}
                episodeId={episodeId}
              />
            </Suspense>
          )}
        </div>
      </div>

      {tagsEditorOpen && encodedDatasetPath && (
        <DatasetTagsEditor
          datasetRelativePath={datasetDisplayName}
          encodedPath={encodedDatasetPath}
          initialTags={tags}
          onClose={() => setTagsEditorOpen(false)}
          onSaved={(updated) => {
            setTags(updated);
            setTagsEditorOpen(false);
          }}
        />
      )}
    </div>
  );
}

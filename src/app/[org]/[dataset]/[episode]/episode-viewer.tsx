"use client";

import Link from "next/link";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import { SimpleVideosPlayer } from "@/components/simple-videos-player";
import PlaybackBar from "@/components/playback-bar";
import { TimeProvider, useTime } from "@/context/time-context";
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
import DatasetReviewErrorBoundary from "@/components/dataset-review-error-boundary";

const URDFViewer = lazy(() => import("@/components/urdf-viewer"));
const ActionInsightsPanel = lazy(
  () => import("@/components/action-insights-panel"),
);
const FilteringPanel = lazy(() => import("@/components/filtering-panel"));
const DoctorPanel = lazy(() => import("@/components/doctor-panel"));
const ParquetTablePanel = lazy(
  () => import("@/components/parquet-table-panel"),
);
const DatasetReviewPanel = lazy(
  () => import("@/components/dataset-review-panel"),
);
// Recharts is ~150KB gz and not above-the-fold (videos render first on the
// Episodes tab). Lazy-load it so the initial chunk can ship faster and
// videos start downloading in parallel with the chart bundle.
const DataRecharts = lazy(() => import("@/components/data-recharts"));

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/** Skip global playback / navigation shortcuts while typing in a field. */
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
  | "parquet"
  | "workbench";

function normalizeActiveTab(value: string | null): ActiveTab | null {
  if (!value) return null;
  const tab = value === "dataset-review" ? "workbench" : value;
  if (tab === "workbench") return null;
  return [
    "episodes",
    "annotations",
    "statistics",
    "frames",
    "insights",
    "doctor",
    "filtering",
    "urdf",
    "parquet",
  ].includes(tab)
    ? (tab as ActiveTab)
    : null;
}

function removeWorkbenchTabParam() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab !== "workbench" && tab !== "dataset-review") return;
  params.delete("tab");
  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

// Subscribes to `currentTime` so its parent doesn't have to. Keeping this
// in a leaf component means the throttled time ticks (~12.5/s during
// playback) only re-render this no-op sub-tree, not the entire 700-line
// EpisodeViewerInner. Vercel rule: rerender-defer-reads.
function UrlTimeSync() {
  const { currentTime, isPlaying } = useTime();
  const lastUrlSecondRef = useRef<number>(-1);

  // Only update the URL ?t= param when the integer second changes, and
  // only while paused — replacing state every frame during playback would
  // spam the browser's history.
  useEffect(() => {
    if (isPlaying) return;
    const currentSec = Math.floor(currentTime);
    if (currentTime > 0 && lastUrlSecondRef.current !== currentSec) {
      lastUrlSecondRef.current = currentSec;
      const newParams = new URLSearchParams(window.location.search);
      newParams.set("t", currentSec.toString());
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}?${newParams.toString()}`,
      );
    }
  }, [isPlaying, currentTime]);

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

  const loadStartRef = useRef(performance.now());

  const searchParams = useSearchParams();

  // Tab state & lazy stats — read sessionStorage in the initializer so the
  // correct tab renders on the very first frame (no post-mount flash).
  // Safe because EpisodeViewerInner only mounts client-side (behind a loading gate).
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    const urlTab = normalizeActiveTab(searchParams.get("tab"));
    if (urlTab) return urlTab;
    if (typeof window !== "undefined") {
      const stored = normalizeActiveTab(sessionStorage.getItem("activeTab"));
      if (stored) {
        return stored;
      }
    }
    return "episodes";
  });
  const isLoading =
    episodeLoading ||
    (activeTab === "episodes" && (!videosReady || !chartsReady));

  useEffect(() => {
    setVideosReady(!videosInfo.length);
    setChartsReady(false);
  }, [episodeId, videosInfo.length]);

  useEffect(() => {
    if (!isLoading) {
      console.log(
        `[perf] Loading complete in ${(performance.now() - loadStartRef.current).toFixed(0)}ms (videos: ${videosReady ? "✓" : "…"}, charts: ${chartsReady ? "✓" : "…"})`,
      );
    }
  }, [isLoading, videosReady, chartsReady]);
  const [, setColumnMinMax] = useState<ColumnMinMax[] | null>(null);
  const [episodeLengthStats, setEpisodeLengthStats] =
    useState<EpisodeLengthStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const statsLoadedRef = useRef(false);
  const statsRequestIdRef = useRef(0);
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
    statsRequestIdRef.current += 1;
    framesLoadedRef.current = false;
    insightsLoadedRef.current = false;
    setEpisodeLengthStats(null);
    setStatsError(null);
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
    if (activeTab === "workbench") {
      sessionStorage.removeItem("activeTab");
    } else {
      sessionStorage.setItem("activeTab", activeTab);
    }
    sessionStorage.setItem("sidebarFlaggedOnly", String(sidebarFlaggedOnly));
    sessionStorage.setItem("framesFlaggedOnly", String(framesFlaggedOnly));
  }, [activeTab, sidebarFlaggedOnly, framesFlaggedOnly]);

  useEffect(() => {
    removeWorkbenchTabParam();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const nextTab = normalizeActiveTab(
        new URLSearchParams(window.location.search).get("tab"),
      );
      setActiveTab(nextTab ?? "episodes");
      removeWorkbenchTabParam();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadStats = () => {
    if (statsLoadedRef.current) return;
    statsLoadedRef.current = true;
    const requestId = ++statsRequestIdRef.current;
    setStatsLoading(true);
    setStatsError(null);

    try {
      setColumnMinMax(computeColumnMinMax(data.chartDataGroups));
    } catch (error) {
      if (mountedRef.current && statsRequestIdRef.current === requestId) {
        statsLoadedRef.current = false;
        setStatsError(
          describeError(error, "Unable to prepare dataset statistics."),
        );
        setStatsLoading(false);
      }
      return;
    }

    if (repoId) {
      getDatasetVersionAndInfo(repoId)
        .then(({ version, info }) => {
          if (version !== "v3.0") return null;
          return loadAllEpisodeLengthsV3(repoId, version, info.fps);
        })
        .then((result) => {
          if (!mountedRef.current || statsRequestIdRef.current !== requestId)
            return;
          setEpisodeLengthStats(result);
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || statsRequestIdRef.current !== requestId)
            return;
          statsLoadedRef.current = false;
          setStatsError(
            describeError(error, "Unable to load episode duration metadata."),
          );
        })
        .finally(() => {
          if (mountedRef.current && statsRequestIdRef.current === requestId)
            setStatsLoading(false);
        });
    } else {
      if (mountedRef.current && statsRequestIdRef.current === requestId) {
        setStatsLoading(false);
      }
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
    if (activeTab === "workbench") loadStats();
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
    const params = new URLSearchParams(window.location.search);
    if (tab === "episodes" || tab === "workbench") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const query = params.toString();
    window.history.pushState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    if (tab === "statistics") loadStats();
    if (tab === "doctor") loadStats();
    if (tab === "workbench") loadStats();
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
  const { seek, setIsPlaying } = useTime();
  const handleEpisodeSelect = useCallback(
    (nextEpisode: number) => {
      if (nextEpisode === selectedEpisodeId) return;
      setIsPlaying(false);
      seek(0);
      onEpisodeSelect(nextEpisode);
    },
    [onEpisodeSelect, seek, selectedEpisodeId, setIsPlaying],
  );

  // URDF playback toggle — populated by URDFViewer after its first mount.
  const urdfPlayToggleRef = useRef<(() => void) | undefined>(undefined);
  const urdfSeekByRef = useRef<((seconds: number) => void) | undefined>(
    undefined,
  );
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

  // Initialize based on URL time parameter
  useEffect(() => {
    const timeParam = searchParams.get("t");
    if (timeParam) {
      const timeValue = parseFloat(timeParam);
      if (!isNaN(timeValue)) {
        seek(timeValue);
      }
    }
  }, [searchParams, seek]);

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
      <UrlTimeSync />
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
        {renderTab(
          "workbench",
          "Workbench",
          "Workbench-style dataset statistics and custom quality checks",
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
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
          className={`flex flex-col gap-4 p-4 flex-1 relative ${isLoading ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {isLoading && <Loading />}
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
                  onVideosReady={() => setVideosReady(true)}
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

              {/* Subtasks — Pi-style segmentation → lerobot subtask_index */}
              <SubtaskPanel
                encodedPath={encodedDatasetPath}
                episodeId={episodeId}
                fps={datasetInfo.fps}
                task={task}
                frameTimestamps={data.frameTimestamps}
              />

              {/* Graph */}
              <div className="mb-4">
                <Suspense fallback={null}>
                  <DataRecharts
                    data={chartDataGroups}
                    velocityData={velocityChartDataGroups}
                    flatData={data.flatChartData}
                    fps={datasetInfo.fps}
                    onChartsReady={() => setChartsReady(true)}
                  />
                </Suspense>
              </div>

              <PlaybackBar />
            </>
          )}

          {activeTab === "annotations" && (
            <div className="annotations-skin flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <p className="text-base font-medium text-slate-200 truncate">
                  {datasetInfo.repoId}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 tabular">
                  {t("ep.episodeLabel", { id: episodeId })}
                </p>
              </div>
              {videosInfo.length > 0 && (
                <SimpleVideosPlayer
                  videosInfo={videosInfo}
                  onVideosReady={() => setVideosReady(true)}
                />
              )}
              <div className="grounding-intro">
                <span className="section-kicker">{t("ep.groundedVqa")}</span>
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
              <AnnotationsPanel
                cameraKeys={videosInfo.map((v) => v.filename)}
              />
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

          {activeTab === "workbench" && (
            <DatasetReviewErrorBoundary>
              <Suspense fallback={<Loading />}>
                <DatasetReviewPanel
                  datasetInfo={datasetInfo}
                  episodeLengthStats={episodeLengthStats}
                  episodeLengthStatsLoading={statsLoading}
                  episodeLengthStatsError={statsError}
                  onRetryEpisodeStats={loadStats}
                  encodedPath={encodedDatasetPath}
                  datasetName={datasetDisplayName}
                />
              </Suspense>
            </DatasetReviewErrorBoundary>
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

import type { HistogramBinning } from "@/utils/episodeLengthHistogram";
import type { SpatialTrajectoryData } from "@/utils/spatialTrajectories";
import type { LanguageAtom } from "./language.types";
import type { VideoInfo } from "./video.types";

export type { SpatialTrajectoryData } from "@/utils/spatialTrajectories";

export type CameraInfo = { name: string; width: number; height: number };

export type DatasetDisplayInfo = {
  repoId: string;
  total_frames: number;
  total_episodes: number;
  fps: number;
  robot_type: string | null;
  codebase_version: string;
  total_tasks: number;
  dataset_size_mb: number;
  cameras: CameraInfo[];
};

export type ChartRow = Record<string, number | Record<string, number>>;

export type ColumnMinMax = {
  column: string;
  min: number;
  max: number;
};

export type EpisodeLengthInfo = {
  episodeIndex: number;
  lengthSeconds: number;
  frames: number;
};

export type EpisodeLengthHistogramBin = {
  binLabel: string;
  count: number;
};

export type EpisodeLengthStats = {
  shortestEpisodes: EpisodeLengthInfo[];
  longestEpisodes: EpisodeLengthInfo[];
  allEpisodeLengths: EpisodeLengthInfo[];
  meanEpisodeLength: number;
  medianEpisodeLength: number;
  stdEpisodeLength: number;
  episodeLengthHistogram: EpisodeLengthHistogramBin[];
  /**
   * Bin geometry for `episodeLengthHistogram`. Lets the client recover which
   * episodes fall in each bin from `allEpisodeLengths` via `assignEpisodesToBins`,
   * instead of the server shipping every episode index a second time.
   */
  episodeLengthHistogramBinning: HistogramBinning;
};

export type EpisodeFrameInfo = {
  episodeIndex: number;
  videoUrl: string;
  firstFrameTime: number;
  lastFrameTime: number | null; // null = seek to video.duration on client
};

export type EpisodeFramesData = {
  cameras: string[];
  framesByCamera: Record<string, EpisodeFrameInfo[]>;
};

export type EpisodeData = {
  datasetInfo: DatasetDisplayInfo;
  episodeId: number;
  videosInfo: VideoInfo[];
  chartDataGroups: ChartRow[][];
  velocityChartDataGroups: ChartRow[][];
  flatChartData: Record<string, number>[];
  episodes: number[];
  ignoredColumns: string[];
  duration: number;
  task?: string;
  /**
   * v3.1 language atoms read from `language_persistent` and `language_events`
   * (lerobot#3467). Empty when the dataset hasn't been annotated yet.
   * The annotations panel uses this to seed its editor state when no
   * annotation backend is running.
   */
  languageAtoms?: LanguageAtom[];
  /**
   * Sorted source-frame timestamps from the data parquet, in seconds. Used by
   * the annotations editor to snap atom timestamps to exact frame times,
   * avoiding sub-frame drift from a throttled `currentTime` and keeping
   * events compatible with the writer in lerobot#3471.
   */
  frameTimestamps?: number[];
};

export type LowMovementEpisode = {
  episodeIndex: number;
  totalMovement: number;
};

export type AggVelocityStat = {
  name: string;
  std: number; // normalized by motor range
  maxAbs: number; // normalized by motor range
  bins: number[];
  lo: number; // normalized by motor range
  hi: number; // normalized by motor range
  motorRange: number;
  inactive?: boolean; // true if p95(|Δa|) < 1% of motor range
  discrete?: boolean; // true if motor has very few unique values
};

export type AggAutocorrelation = {
  chartData: Record<string, number>[];
  suggestedChunk: number | null;
  shortKeys: string[];
};

export type SpeedDistEntry = {
  episodeIndex: number;
  speed: number;
};

export type AggAlignment = {
  ccData: { lag: number; max: number; mean: number; min: number }[];
  meanPeakLag: number;
  meanPeakCorr: number;
  maxPeakLag: number;
  maxPeakCorr: number;
  minPeakLag: number;
  minPeakCorr: number;
  lagRangeMin: number;
  lagRangeMax: number;
  numPairs: number;
};

export type JerkyEpisode = {
  episodeIndex: number;
  meanAbsDelta: number;
};

export type CrossEpisodeVarianceData = {
  actionNames: string[];
  timeBins: number[];
  variance: number[][];
  /** Episodes successfully loaded for the bounded statistical sample. */
  numEpisodes: number;
  /** Actual episode metadata entries in the dataset. */
  totalEpisodes: number;
  lowMovementEpisodes: LowMovementEpisode[];
  aggVelocity: AggVelocityStat[];
  aggAutocorrelation: AggAutocorrelation | null;
  speedDistribution: SpeedDistEntry[];
  jerkyEpisodes: JerkyEpisode[];
  aggAlignment: AggAlignment | null;
  spatialTrajectories: SpatialTrajectoryData | null;
};

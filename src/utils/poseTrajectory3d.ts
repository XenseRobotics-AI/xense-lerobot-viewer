import { CHART_CONFIG } from "@/utils/constants";

const SERIES_NAME_DELIMITER = CHART_CONFIG.SERIES_NAME_DELIMITER;

type PoseAxis = "x" | "y" | "z";
type RotationAxis = `r${1 | 2 | 3 | 4 | 5 | 6}`;
const ROTATION_AXES = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;

type PoseComponent = PoseAxis | RotationAxis;

type PoseComponentKey = {
  component: PoseComponent;
  base: string;
  source: string;
  key: string;
};

type PoseAxisGroup = {
  source: string;
  base: string;
  components: Partial<Record<PoseComponent, PoseComponentKey>>;
};

export type RotationMatrix3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type EpisodePoseTrajectory = {
  id: string;
  /** Original feature source, e.g. `action` or `observation.state`. */
  source: string;
  /** Pose name, e.g. `left_tcp` or `right_tcp`. */
  label: string;
  axisNames: [string, string, string];
  /** Flat xyz triples: [x0, y0, z0, x1, y1, z1, ...]. */
  points: number[];
  /** Source timestamps corresponding to each xyz triple when available. */
  timestamps: number[];
  /** Names of the six 6D rotation components when present. */
  rotationAxisNames?: [string, string, string, string, string, string];
  /** Per-point 6D rotations; null means that row had incomplete rotation data. */
  rotationValues?: Array<
    [number, number, number, number, number, number] | null
  >;
};

export type EpisodePoseTrajectoryPlayback = {
  /** Interpolated xyz position at the requested episode time. */
  point: [number, number, number];
  /** The portion of the trajectory reached at the requested time. */
  trailPoints: number[];
};

export type EpisodePoseTrajectoryLocation = {
  /** Interpolated xyz position at the requested episode time. */
  point: [number, number, number];
  /** Sample immediately before the requested time (or the exact sample). */
  lowerIndex: number;
  /** Sample immediately after the requested time (or the exact sample). */
  upperIndex: number;
  /** Interpolation factor between lowerIndex and upperIndex. */
  alpha: number;
  /** Number of complete source samples that belong to the played trail. */
  completedPointCount: number;
};

/** Shared with the TacCap replay helpers, which parse the same chart rows. */
export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePoseComponentKey(key: string): PoseComponentKey | null {
  const parts = key.split(SERIES_NAME_DELIMITER);
  if (parts.length < 2) return null;

  const source = parts.shift()?.trim() ?? "";
  const feature = parts.join(SERIES_NAME_DELIMITER).trim();
  if (!source || !feature) return null;

  const match = /^(.*)\.(x|y|z|r[1-6])$/i.exec(feature);
  if (!match) return null;

  const base = match[1].trim();
  if (!base) return null;

  return {
    source,
    base,
    component: match[2].toLowerCase() as PoseComponent,
    key,
  };
}

/** `action` first, then `observation.state`, then anything else. */
export function sourceOrder(source: string): number {
  const lower = source.toLowerCase();
  if (lower === "action") return 0;
  if (lower === "observation.state") return 1;
  return 2;
}

/**
 * Memoised per rows array. One episode load asks for these trajectories five
 * times over — the gripper tracks, the head track, the source list, the
 * Episodes-tab 3D view and the "is there anything to show" probe — and each
 * pass is O(rows × keys) plus a full copy of every point and rotation array.
 * The chart rows are a stable memoised array, so keying on identity collapses
 * those into one. Entries die with the rows array.
 *
 * Callers must treat the result as read-only: it is shared.
 */
const trajectoryCache = new WeakMap<object, EpisodePoseTrajectory[]>();

/**
 * Extract complete Cartesian pose trajectories from the flat chart rows used
 * by the Episodes tab. Keys are expected in the same form as the dataset
 * chart data, for example `action | left_tcp.x`.
 */
export function extractEpisodePoseTrajectories(
  rows: Record<string, number>[],
): EpisodePoseTrajectory[] {
  const cached = trajectoryCache.get(rows);
  if (cached) return cached;

  const groups = new Map<string, PoseAxisGroup>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === "timestamp") continue;
      const parsed = parsePoseComponentKey(key);
      if (!parsed) continue;

      const id = `${parsed.source}\u0000${parsed.base}`;
      const group = groups.get(id) ?? {
        source: parsed.source,
        base: parsed.base,
        components: {},
      };
      group.components[parsed.component] = parsed;
      groups.set(id, group);
    }
  }

  const trajectories = [...groups.values()]
    .filter(
      (group) =>
        group.components.x !== undefined &&
        group.components.y !== undefined &&
        group.components.z !== undefined,
    )
    .map((group) => {
      const xKey = group.components.x!;
      const yKey = group.components.y!;
      const zKey = group.components.z!;
      const rotationKeys = ROTATION_AXES.map((axis) => group.components[axis]);
      const hasRotation = rotationKeys.every(
        (key): key is PoseComponentKey => key !== undefined,
      );
      const points: number[] = [];
      const timestamps: number[] = [];
      const rotationValues: Array<
        [number, number, number, number, number, number] | null
      > = [];

      for (const row of rows) {
        const x = finiteNumber(row[xKey.key]);
        const y = finiteNumber(row[yKey.key]);
        const z = finiteNumber(row[zKey.key]);
        if (x === null || y === null || z === null) continue;

        points.push(x, y, z);
        const timestamp = finiteNumber(row.timestamp);
        timestamps.push(timestamp ?? timestamps.length);

        if (hasRotation) {
          const values = rotationKeys.map((key) => finiteNumber(row[key.key]));
          rotationValues.push(
            values.every((value): value is number => value !== null)
              ? (values as [number, number, number, number, number, number])
              : null,
          );
        }
      }

      const trajectory: EpisodePoseTrajectory = {
        id: `${group.source}:${group.base}`,
        source: group.source,
        label: group.base,
        axisNames: [xKey.key, yKey.key, zKey.key],
        points,
        timestamps,
      };
      if (hasRotation) {
        trajectory.rotationAxisNames = rotationKeys.map((key) => key.key) as [
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        trajectory.rotationValues = rotationValues;
      }
      return trajectory;
    })
    .filter((trajectory) => trajectory.points.length >= 6)
    .sort(
      (a, b) =>
        sourceOrder(a.source) - sourceOrder(b.source) ||
        a.source.localeCompare(b.source) ||
        a.label.localeCompare(b.label),
    );

  trajectoryCache.set(rows, trajectories);
  return trajectories;
}

export function hasEpisodePoseTrajectories(
  rows: Record<string, number>[],
): boolean {
  return extractEpisodePoseTrajectories(rows).length > 0;
}

function vectorNorm(vector: readonly number[]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizeVector(
  vector: readonly number[],
): [number, number, number] | null {
  const norm = vectorNorm(vector);
  if (!Number.isFinite(norm) || norm <= 1e-12) return null;
  return [vector[0] / norm, vector[1] / norm, vector[2] / norm];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(
  left: readonly number[],
  right: readonly number[],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

/** Reconstruct an orthonormal row-major rotation matrix from r1-r6. */
export function rotation6dToMatrix(
  values: readonly number[],
): RotationMatrix3 | null {
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const first = normalizeVector([values[0], values[1], values[2]]);
  if (!first) return null;
  const secondInput = [values[3], values[4], values[5]];
  const projection = dot(first, secondInput);
  const second = normalizeVector([
    secondInput[0] - projection * first[0],
    secondInput[1] - projection * first[1],
    secondInput[2] - projection * first[2],
  ]);
  if (!second) return null;
  const third = cross(first, second);

  // The six-dimensional representation stores the first two columns.
  return [
    first[0],
    second[0],
    third[0],
    first[1],
    second[1],
    third[1],
    first[2],
    second[2],
    third[2],
  ];
}

function interpolateRotationValues(
  lower: readonly number[],
  upper: readonly number[],
  alpha: number,
): [number, number, number, number, number, number] {
  return lower.map(
    (value, index) => value + (upper[index] - value) * alpha,
  ) as [number, number, number, number, number, number];
}

/** Return the SO(3) orientation at an episode-local playback time. */
export function sampleEpisodePoseRotation(
  trajectory: EpisodePoseTrajectory,
  timeSeconds: number,
): RotationMatrix3 | null {
  const rotations = trajectory.rotationValues;
  if (!rotations) return null;

  const location = locateEpisodePoseTrajectory(trajectory, timeSeconds);
  if (!location) return null;

  let lowerIndex = Math.min(location.lowerIndex, rotations.length - 1);
  while (lowerIndex >= 0 && !rotations[lowerIndex]) lowerIndex -= 1;

  let upperIndex = Math.min(location.upperIndex, rotations.length - 1);
  while (upperIndex < rotations.length && !rotations[upperIndex]) {
    upperIndex += 1;
  }

  if (lowerIndex < 0 && upperIndex >= rotations.length) return null;
  if (lowerIndex < 0) return rotation6dToMatrix(rotations[upperIndex]!);
  if (upperIndex >= rotations.length) {
    return rotation6dToMatrix(rotations[lowerIndex]!);
  }

  const lower = rotations[lowerIndex]!;
  const upper = rotations[upperIndex]!;
  if (lowerIndex === upperIndex) return rotation6dToMatrix(lower);
  const requestedTime = Number.isFinite(timeSeconds)
    ? timeSeconds
    : trajectory.timestamps[lowerIndex];
  const lowerTime = trajectory.timestamps[lowerIndex];
  const upperTime = trajectory.timestamps[upperIndex];
  const alpha =
    upperTime > lowerTime
      ? Math.max(
          0,
          Math.min(1, (requestedTime - lowerTime) / (upperTime - lowerTime)),
        )
      : 1;
  return rotation6dToMatrix(interpolateRotationValues(lower, upper, alpha));
}

/**
 * Locate a playback position without allocating a growing copy of the trail.
 * Timestamps produced by the episode loader are monotonic, so binary search
 * keeps the per-frame lookup logarithmic even for long episodes.
 */
export function locateEpisodePoseTrajectory(
  trajectory: EpisodePoseTrajectory,
  timeSeconds: number,
): EpisodePoseTrajectoryLocation | null {
  const pointCount = Math.min(
    Math.floor(trajectory.points.length / 3),
    trajectory.timestamps.length,
  );
  if (pointCount === 0) return null;

  const pointAt = (index: number): [number, number, number] => {
    const offset = index * 3;
    return [
      trajectory.points[offset],
      trajectory.points[offset + 1],
      trajectory.points[offset + 2],
    ];
  };
  const firstTime = trajectory.timestamps[0];
  const requestedTime = Number.isFinite(timeSeconds) ? timeSeconds : firstTime;

  if (pointCount === 1 || requestedTime <= firstTime) {
    return {
      point: pointAt(0),
      lowerIndex: 0,
      upperIndex: 0,
      alpha: 0,
      completedPointCount: 1,
    };
  }

  const lastIndex = pointCount - 1;
  if (requestedTime >= trajectory.timestamps[lastIndex]) {
    return {
      point: pointAt(lastIndex),
      lowerIndex: lastIndex,
      upperIndex: lastIndex,
      alpha: 0,
      completedPointCount: pointCount,
    };
  }

  let low = 1;
  let high = lastIndex;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (trajectory.timestamps[middle] < requestedTime) low = middle + 1;
    else high = middle;
  }

  const upperIndex = low;
  const upperTime = trajectory.timestamps[upperIndex];
  if (upperTime === requestedTime) {
    return {
      point: pointAt(upperIndex),
      lowerIndex: upperIndex,
      upperIndex,
      alpha: 0,
      completedPointCount: upperIndex + 1,
    };
  }

  const lowerIndex = upperIndex - 1;
  const lowerTime = trajectory.timestamps[lowerIndex];
  const denominator = upperTime - lowerTime;
  const alpha =
    denominator > 0
      ? Math.max(0, Math.min(1, (requestedTime - lowerTime) / denominator))
      : 1;
  const lowerOffset = lowerIndex * 3;
  const upperOffset = upperIndex * 3;

  return {
    point: [
      trajectory.points[lowerOffset] +
        (trajectory.points[upperOffset] - trajectory.points[lowerOffset]) *
          alpha,
      trajectory.points[lowerOffset + 1] +
        (trajectory.points[upperOffset + 1] -
          trajectory.points[lowerOffset + 1]) *
          alpha,
      trajectory.points[lowerOffset + 2] +
        (trajectory.points[upperOffset + 2] -
          trajectory.points[lowerOffset + 2]) *
          alpha,
    ],
    lowerIndex,
    upperIndex,
    alpha,
    completedPointCount: lowerIndex + 1,
  };
}

/**
 * Interpolate a sampled trajectory at an episode-local playback time. The
 * chart rows are sampled for rendering, so interpolation keeps the playback
 * marker smooth without loading the original parquet rows again.
 */
export function sampleEpisodePoseTrajectory(
  trajectory: EpisodePoseTrajectory,
  timeSeconds: number,
): EpisodePoseTrajectoryPlayback | null {
  const location = locateEpisodePoseTrajectory(trajectory, timeSeconds);
  if (!location) return null;

  const trailPoints = trajectory.points.slice(
    0,
    location.completedPointCount * 3,
  );
  if (location.lowerIndex !== location.upperIndex) {
    trailPoints.push(...location.point);
  }
  return { point: location.point, trailPoints };
}

/**
 * How far back a trail should start, given where its head is.
 *
 * A trail drawn over a fixed *time* window is unreadable on real data: the
 * distance a gripper covers in three seconds varies by more than an order of
 * magnitude within one episode, so the same window is a legible arc during a
 * reach and a dot during a pause. A fixed *length* window fixes that but
 * destroys the age semantics the colour ramp encodes.
 *
 * So this returns the earliest index that satisfies both: at least
 * `baseDuration` of history, extended until the trail is at least `minSpan`
 * across, and never reaching further back than `maxDuration` — otherwise a
 * stationary gripper would drag in the entire episode.
 *
 * "Across" is the diagonal of the window's bounding box, **not** accumulated
 * path length. Path length is inflated by jitter: on a real folding episode a
 * gripper holding position still racks up 5 cm of arc in 3 s while occupying
 * under 3 cm of screen, which is exactly the case this floor exists to catch,
 * and an arc-length test would declare it satisfied and stop.
 *
 * `positions` is a flat xyz array in the same space `minSpan` is measured in.
 * Pure and bounded: the walk visits at most the points inside `maxDuration`.
 */
export function selectTrailStartIndex({
  timestamps,
  positions,
  endIndex,
  timeSeconds,
  baseDuration,
  maxDuration,
  minSpan,
}: {
  timestamps: number[];
  positions: ArrayLike<number>;
  endIndex: number;
  timeSeconds: number;
  baseDuration: number;
  maxDuration: number;
  minSpan: number;
}): number {
  let startIndex = Math.max(0, endIndex);
  const head = startIndex * 3;
  let minX = positions[head];
  let maxX = positions[head];
  let minY = positions[head + 1];
  let maxY = positions[head + 1];
  let minZ = positions[head + 2];
  let maxZ = positions[head + 2];

  while (startIndex > 0) {
    const age = timeSeconds - timestamps[startIndex];
    if (age >= maxDuration) break;
    const span = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    if (age >= baseDuration && span >= minSpan) break;
    startIndex -= 1;
    const offset = startIndex * 3;
    minX = Math.min(minX, positions[offset]);
    maxX = Math.max(maxX, positions[offset]);
    minY = Math.min(minY, positions[offset + 1]);
    maxY = Math.max(maxY, positions[offset + 1]);
    minZ = Math.min(minZ, positions[offset + 2]);
    maxZ = Math.max(maxZ, positions[offset + 2]);
  }
  return startIndex;
}

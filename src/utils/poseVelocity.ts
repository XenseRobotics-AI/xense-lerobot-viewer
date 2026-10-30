import { CHART_CONFIG, THRESHOLDS } from "@/utils/constants";

export type FlatPoseChartRow = Record<string, number>;
export type PoseVelocityChartRow = Record<
  string,
  number | Record<string, number>
>;

type Vector3 = [number, number, number];
type Matrix3 = [
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
type PoseComponent = "x" | "y" | "z" | `r${1 | 2 | 3 | 4 | 5 | 6}`;

interface PoseSeries {
  source: string;
  pose: string;
  keys: Partial<Record<PoseComponent, string>>;
}

interface GripperSeries {
  source: string;
  gripper: string;
  key: string;
}

const LINEAR_COMPONENTS = ["x", "y", "z"] as const;
const ROTATION_COMPONENTS = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;
const LINEAR_VELOCITY_LABELS = ["vx", "vy", "vz"] as const;
const ANGULAR_VELOCITY_LABELS = ["ωx", "ωy", "ωz"] as const;
const RADIANS_TO_DEGREES = 180 / Math.PI;

function finiteValue(row: FlatPoseChartRow, key: string): number | null {
  const value = row[key];
  return Number.isFinite(value) ? value : null;
}

function vectorNorm(vector: Vector3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizeVector(vector: Vector3): Vector3 | null {
  const norm = vectorNorm(vector);
  if (!Number.isFinite(norm) || norm <= THRESHOLDS.EPSILON) return null;
  return [vector[0] / norm, vector[1] / norm, vector[2] / norm];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

/**
 * Reconstruct a rotation matrix from the continuous 6D representation. The
 * first two 3D vectors are projected onto SO(3) with Gram-Schmidt so normal
 * float32 drift does not leak into the derived angular velocity.
 */
function rotation6dToMatrix(values: readonly number[]): Matrix3 | null {
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const first = normalizeVector([values[0], values[1], values[2]]);
  if (!first) return null;

  const secondInput: Vector3 = [values[3], values[4], values[5]];
  const projection = dot(first, secondInput);
  const second = normalizeVector([
    secondInput[0] - projection * first[0],
    secondInput[1] - projection * first[1],
    secondInput[2] - projection * first[2],
  ]);
  if (!second) return null;

  const third = cross(first, second);

  // Row-major matrix whose columns are the reconstructed basis vectors.
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

/** Current rotation multiplied by the transpose of the previous rotation. */
function worldRelativeRotation(previous: Matrix3, current: Matrix3): Matrix3 {
  const result = new Array<number>(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let index = 0; index < 3; index += 1) {
        value += current[row * 3 + index] * previous[column * 3 + index];
      }
      result[row * 3 + column] = value;
    }
  }
  return result as Matrix3;
}

/** Logarithm map from SO(3) to a world-frame axis-angle vector in radians. */
function rotationVector(matrix: Matrix3): Vector3 | null {
  const cosine = Math.max(
    -1,
    Math.min(1, (matrix[0] + matrix[4] + matrix[8] - 1) / 2),
  );
  const angle = Math.acos(cosine);
  const skew: Vector3 = [
    matrix[7] - matrix[5],
    matrix[2] - matrix[6],
    matrix[3] - matrix[1],
  ];

  if (angle < 1e-7) {
    return [skew[0] / 2, skew[1] / 2, skew[2] / 2];
  }

  if (Math.PI - angle < 1e-5) {
    const diagonal: Vector3 = [
      Math.max(0, (matrix[0] + 1) / 2),
      Math.max(0, (matrix[4] + 1) / 2),
      Math.max(0, (matrix[8] + 1) / 2),
    ];
    let axis: Vector3;
    if (diagonal[0] >= diagonal[1] && diagonal[0] >= diagonal[2]) {
      const x = Math.sqrt(diagonal[0]);
      if (x <= THRESHOLDS.EPSILON) return null;
      axis = [
        x,
        (matrix[1] + matrix[3]) / (4 * x),
        (matrix[2] + matrix[6]) / (4 * x),
      ];
    } else if (diagonal[1] >= diagonal[2]) {
      const y = Math.sqrt(diagonal[1]);
      if (y <= THRESHOLDS.EPSILON) return null;
      axis = [
        (matrix[1] + matrix[3]) / (4 * y),
        y,
        (matrix[5] + matrix[7]) / (4 * y),
      ];
    } else {
      const z = Math.sqrt(diagonal[2]);
      if (z <= THRESHOLDS.EPSILON) return null;
      axis = [
        (matrix[2] + matrix[6]) / (4 * z),
        (matrix[5] + matrix[7]) / (4 * z),
        z,
      ];
    }
    const normalized = normalizeVector(axis);
    if (!normalized) return null;
    if (dot(normalized, skew) < 0) {
      normalized[0] *= -1;
      normalized[1] *= -1;
      normalized[2] *= -1;
    }
    return [
      normalized[0] * angle,
      normalized[1] * angle,
      normalized[2] * angle,
    ];
  }

  const scale = angle / (2 * Math.sin(angle));
  return [skew[0] * scale, skew[1] * scale, skew[2] * scale];
}

export function worldAngularVelocityDegreesPerSecond(
  previous: readonly number[],
  current: readonly number[],
  deltaSeconds: number,
): Vector3 | null {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return null;
  const previousRotation = rotation6dToMatrix(previous);
  const currentRotation = rotation6dToMatrix(current);
  if (!previousRotation || !currentRotation) return null;
  const vector = rotationVector(
    worldRelativeRotation(previousRotation, currentRotation),
  );
  if (!vector) return null;
  const scale = RADIANS_TO_DEGREES / deltaSeconds;
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function isPoseSource(source: string): boolean {
  return source === "action" || source.includes("state");
}

function discoverPoseSeries(rows: FlatPoseChartRow[]): PoseSeries[] {
  const firstRow = rows[0];
  if (!firstRow) return [];

  const series = new Map<string, PoseSeries>();
  for (const key of Object.keys(firstRow)) {
    const delimiterIndex = key.indexOf(CHART_CONFIG.SERIES_NAME_DELIMITER);
    if (delimiterIndex < 0) continue;
    const source = key.slice(0, delimiterIndex);
    if (!isPoseSource(source)) continue;
    const featureName = key.slice(
      delimiterIndex + CHART_CONFIG.SERIES_NAME_DELIMITER.length,
    );
    const match = /^(.+)\.(x|y|z|r[1-6])$/.exec(featureName);
    if (!match) continue;
    const pose = match[1];
    const component = match[2] as PoseComponent;
    const id = `${pose}\u0000${source}`;
    const existing = series.get(id) ?? { source, pose, keys: {} };
    existing.keys[component] = key;
    series.set(id, existing);
  }
  return [...series.values()];
}

function discoverGripperSeries(rows: FlatPoseChartRow[]): GripperSeries[] {
  const firstRow = rows[0];
  if (!firstRow) return [];

  const series: GripperSeries[] = [];
  for (const key of Object.keys(firstRow)) {
    const delimiterIndex = key.indexOf(CHART_CONFIG.SERIES_NAME_DELIMITER);
    if (delimiterIndex < 0) continue;
    const source = key.slice(0, delimiterIndex);
    if (!isPoseSource(source)) continue;
    const featureName = key.slice(
      delimiterIndex + CHART_CONFIG.SERIES_NAME_DELIMITER.length,
    );
    const match = /^(.+gripper)\.(?:pos|position)$/.exec(featureName);
    if (!match) continue;
    series.push({ source, gripper: match[1], key });
  }
  return series;
}

function hasComponents(
  series: PoseSeries,
  components: readonly PoseComponent[],
): boolean {
  return components.every((component) => Boolean(series.keys[component]));
}

/** Whether a full-rate flattened source is needed before display sampling. */
export function hasPoseVelocitySeries(firstRow: FlatPoseChartRow): boolean {
  return (
    discoverPoseSeries([firstRow]).some(
      (series) =>
        hasComponents(series, LINEAR_COMPONENTS) ||
        hasComponents(series, ROTATION_COMPONENTS),
    ) || discoverGripperSeries([firstRow]).length > 0
  );
}

function displayTimestamp(
  row: FlatPoseChartRow,
  index: number,
  fps: number,
): number {
  return Number.isFinite(row.timestamp) ? row.timestamp : index / fps;
}

function deltaSeconds(
  rows: FlatPoseChartRow[],
  sourceTimestamps: readonly number[] | undefined,
  index: number,
  fps: number,
): number {
  const currentSource = sourceTimestamps?.[index];
  const previousSource = sourceTimestamps?.[index - 1];
  if (
    typeof currentSource === "number" &&
    Number.isFinite(currentSource) &&
    typeof previousSource === "number" &&
    Number.isFinite(previousSource) &&
    currentSource > previousSource
  ) {
    return currentSource - previousSource;
  }

  const currentDisplay = rows[index]?.timestamp;
  const previousDisplay = rows[index - 1]?.timestamp;
  if (
    Number.isFinite(currentDisplay) &&
    Number.isFinite(previousDisplay) &&
    currentDisplay > previousDisplay
  ) {
    return currentDisplay - previousDisplay;
  }

  return 1 / fps;
}

function readComponents(
  row: FlatPoseChartRow,
  series: PoseSeries,
  components: readonly PoseComponent[],
): number[] | null {
  const values: number[] = [];
  for (const component of components) {
    const key = series.keys[component];
    if (!key) return null;
    const value = finiteValue(row, key);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

/**
 * Build chart-ready TCP and gripper velocity groups from the fully sampled
 * rows. TCP linear velocity is expressed in m/s. Angular velocity is the
 * world-frame SO(3) logarithm in degrees/s, never an RPY derivative. Gripper
 * position has no universal physical unit, so its derivative uses unit/s.
 */
export function buildPoseVelocityChartGroups(
  rows: FlatPoseChartRow[],
  options: {
    sourceTimestamps?: readonly number[];
    fps?: number;
  } = {},
): PoseVelocityChartRow[][] {
  if (rows.length === 0) return [];
  const fps =
    Number.isFinite(options.fps) && (options.fps ?? 0) > 0
      ? (options.fps as number)
      : 30;
  const discovered = discoverPoseSeries(rows);
  const poses = new Map<string, PoseSeries[]>();
  for (const series of discovered) {
    const existing = poses.get(series.pose) ?? [];
    existing.push(series);
    poses.set(series.pose, existing);
  }

  const groups: PoseVelocityChartRow[][] = [];
  for (const [pose, poseSeries] of [...poses.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const linearSeries = poseSeries.filter((series) =>
      hasComponents(series, LINEAR_COMPONENTS),
    );
    if (linearSeries.length > 0) {
      groups.push(
        rows.map((row, index) => {
          const values = Object.fromEntries(
            LINEAR_VELOCITY_LABELS.map((label) => [
              `${pose}.${label} (m/s)`,
              {} as Record<string, number>,
            ]),
          ) as Record<string, Record<string, number>>;
          const dt =
            index > 0
              ? deltaSeconds(rows, options.sourceTimestamps, index, fps)
              : 0;
          for (const series of linearSeries) {
            const current = readComponents(row, series, LINEAR_COMPONENTS);
            const previous =
              index > 0
                ? readComponents(rows[index - 1], series, LINEAR_COMPONENTS)
                : current;
            for (const [
              componentIndex,
              label,
            ] of LINEAR_VELOCITY_LABELS.entries()) {
              values[`${pose}.${label} (m/s)`][series.source] =
                current && previous && dt > 0
                  ? (current[componentIndex] - previous[componentIndex]) / dt
                  : 0;
            }
          }
          return {
            timestamp: displayTimestamp(row, index, fps),
            ...values,
          };
        }),
      );
    }

    const rotationSeries = poseSeries.filter((series) =>
      hasComponents(series, ROTATION_COMPONENTS),
    );
    if (rotationSeries.length > 0) {
      groups.push(
        rows.map((row, index) => {
          const values = Object.fromEntries(
            ANGULAR_VELOCITY_LABELS.map((label) => [
              `${pose}.${label} (deg/s, world frame)`,
              {} as Record<string, number>,
            ]),
          ) as Record<string, Record<string, number>>;
          const dt =
            index > 0
              ? deltaSeconds(rows, options.sourceTimestamps, index, fps)
              : 0;
          for (const series of rotationSeries) {
            const current = readComponents(row, series, ROTATION_COMPONENTS);
            const previous =
              index > 0
                ? readComponents(rows[index - 1], series, ROTATION_COMPONENTS)
                : current;
            const velocity =
              current && previous && dt > 0
                ? worldAngularVelocityDegreesPerSecond(previous, current, dt)
                : ([0, 0, 0] as Vector3);
            for (const [
              componentIndex,
              label,
            ] of ANGULAR_VELOCITY_LABELS.entries()) {
              values[`${pose}.${label} (deg/s, world frame)`][series.source] =
                velocity?.[componentIndex] ?? Number.NaN;
            }
          }
          return {
            timestamp: displayTimestamp(row, index, fps),
            ...values,
          };
        }),
      );
    }
  }

  const grippers = new Map<string, GripperSeries[]>();
  for (const series of discoverGripperSeries(rows)) {
    const existing = grippers.get(series.gripper) ?? [];
    existing.push(series);
    grippers.set(series.gripper, existing);
  }
  for (const [gripper, gripperSeries] of [...grippers.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const groupName = `${gripper}.velocity (unit/s)`;
    groups.push(
      rows.map((row, index) => {
        const values: Record<string, number> = {};
        const dt =
          index > 0
            ? deltaSeconds(rows, options.sourceTimestamps, index, fps)
            : 0;
        for (const series of gripperSeries) {
          const current = finiteValue(row, series.key);
          const previous =
            index > 0 ? finiteValue(rows[index - 1], series.key) : current;
          values[series.source] =
            current !== null && previous !== null && dt > 0
              ? (current - previous) / dt
              : 0;
        }
        return {
          timestamp: displayTimestamp(row, index, fps),
          [groupName]: values,
        };
      }),
    );
  }

  return groups;
}

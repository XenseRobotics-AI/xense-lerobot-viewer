import { CHART_CONFIG } from "@/utils/constants";
import {
  extractEpisodePoseTrajectories,
  finiteNumber,
  locateEpisodePoseTrajectory,
  rotation6dToMatrix,
  sampleEpisodePoseRotation,
  sourceOrder,
  type EpisodePoseTrajectory,
  type RotationMatrix3,
} from "@/utils/poseTrajectory3d";
import {
  rotationMatrixTo6d,
  transformTacCapTrackerPose,
  type TacCapPoseProfile,
  type TacCapRigidTransform,
  type TacCapSide,
} from "@/utils/taccapPoseSemantics";

export type { TacCapSide } from "@/utils/taccapPoseSemantics";

const SERIES_NAME_DELIMITER = CHART_CONFIG.SERIES_NAME_DELIMITER;

export type TacCapGripperTrack = {
  side: TacCapSide;
  source: string;
  pose: EpisodePoseTrajectory;
  gripperKey: string | null;
  gripperValues: Array<number | null>;
  gripperRange: { min: number; max: number } | null;
};

export type TacCapHeadTrack = {
  source: string;
  pose: EpisodePoseTrajectory;
};

export type TacCapHeadFrame = {
  source: string;
  position: [number, number, number];
  rotation: RotationMatrix3;
};

function nearestRotationMatrices(
  values: NonNullable<EpisodePoseTrajectory["rotationValues"]>,
): Array<RotationMatrix3 | null> {
  const matrices = values.map((rotation) =>
    rotation ? rotation6dToMatrix(rotation) : null,
  );
  const previous = new Array<RotationMatrix3 | null>(matrices.length).fill(
    null,
  );
  const next = new Array<RotationMatrix3 | null>(matrices.length).fill(null);

  let nearest: RotationMatrix3 | null = null;
  for (let index = 0; index < matrices.length; index += 1) {
    nearest = matrices[index] ?? nearest;
    previous[index] = nearest;
  }
  nearest = null;
  for (let index = matrices.length - 1; index >= 0; index -= 1) {
    nearest = matrices[index] ?? nearest;
    next[index] = nearest;
  }
  return matrices.map(
    (matrix, index) => matrix ?? previous[index] ?? next[index] ?? null,
  );
}

/** Apply a body-fixed tracker → TCP transform to a complete trajectory. */
function transformPoseTrajectory(
  pose: EpisodePoseTrajectory,
  correction: TacCapRigidTransform | null,
): EpisodePoseTrajectory {
  if (!correction || !pose.rotationValues) return pose;

  const pointCount = Math.min(
    Math.floor(pose.points.length / 3),
    pose.rotationValues.length,
  );
  const matrices = nearestRotationMatrices(pose.rotationValues);
  const points = [...pose.points];
  const rotationValues = [...pose.rotationValues];

  for (let index = 0; index < pointCount; index += 1) {
    const rawRotation = matrices[index];
    if (!rawRotation) continue;
    const offset = index * 3;
    const transformed = transformTacCapTrackerPose(
      [points[offset], points[offset + 1], points[offset + 2]],
      rawRotation,
      correction,
    );
    points[offset] = transformed.position[0];
    points[offset + 1] = transformed.position[1];
    points[offset + 2] = transformed.position[2];
    // Preserve missing rotation samples. The sampler already searches for the
    // nearest valid orientation, while the corrected position above prevents
    // a missing sample from creating a 19.5 cm trajectory discontinuity.
    if (pose.rotationValues[index]) {
      rotationValues[index] = rotationMatrixTo6d(transformed.rotation);
    }
  }

  return { ...pose, points, rotationValues };
}

export type TacCapGripperFrame = {
  side: TacCapSide;
  source: string;
  position: [number, number, number];
  rotation: RotationMatrix3;
  /** Opening command normalized to the URDF joint range [0, 1]. */
  opening: number;
};

function findGripperKey(
  rows: Record<string, number>[],
  source: string,
  side: TacCapSide,
): string | null {
  const expected = `${side}_gripper`;
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === "timestamp") continue;
      const [keySource, ...featureParts] = key.split(SERIES_NAME_DELIMITER);
      if (keySource?.trim() !== source) continue;
      const feature = featureParts.join(SERIES_NAME_DELIMITER).trim();
      if (
        feature === expected ||
        feature === `${expected}.pos` ||
        feature === `${expected}.position` ||
        feature === `${expected}.q`
      ) {
        return key;
      }
    }
  }
  return null;
}

function valueRange(
  values: Array<number | null>,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value === null) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/**
 * Pick one complete pose per physical gripper. Action is preferred because it
 * is the commanded trajectory used for training; observation.state is the
 * fallback for datasets that do not carry action poses.
 */
export function extractTacCapGripperTracks(
  rows: Record<string, number>[],
  preferredSource?: string,
  poseProfile?: TacCapPoseProfile,
): TacCapGripperTrack[] {
  const poses = extractEpisodePoseTrajectories(rows).filter(
    (trajectory) =>
      trajectory.rotationValues?.some((rotation) => rotation !== null) &&
      (trajectory.label.toLowerCase() === "left_tcp" ||
        trajectory.label.toLowerCase() === "right_tcp"),
  );

  return (["left", "right"] as const).flatMap((side) => {
    const pose = poses
      .filter((trajectory) => trajectory.label.toLowerCase() === `${side}_tcp`)
      .sort((a, b) => {
        const preferredDifference =
          Number(b.source === preferredSource) -
          Number(a.source === preferredSource);
        return (
          preferredDifference || sourceOrder(a.source) - sourceOrder(b.source)
        );
      })[0];
    if (!pose) return [];

    const correctedPose = transformPoseTrajectory(
      pose,
      poseProfile?.corrections[side] ?? null,
    );
    const gripperKey = findGripperKey(rows, pose.source, side);
    const gripperValues = gripperKey
      ? rows.flatMap((row) => {
          const hasPose = pose.axisNames.every(
            (axisName) => finiteNumber(row[axisName]) !== null,
          );
          return hasPose ? [finiteNumber(row[gripperKey])] : [];
        })
      : correctedPose.timestamps.map(() => null);
    return [
      {
        side,
        source: pose.source,
        pose: correctedPose,
        gripperKey,
        gripperValues,
        gripperRange: valueRange(gripperValues),
      },
    ];
  });
}

/**
 * Pick the complete `head.xyz+r1-r6` trajectory that belongs to the selected
 * source. Video keys containing "head" do not imply that a head pose exists.
 */
export function extractTacCapHeadTrack(
  rows: Record<string, number>[],
  preferredSource?: string,
): TacCapHeadTrack | null {
  const pose = extractEpisodePoseTrajectories(rows)
    .filter(
      (trajectory) =>
        trajectory.label.toLowerCase() === "head" &&
        trajectory.rotationValues?.some((rotation) => rotation !== null),
    )
    .sort((a, b) => {
      const preferredDifference =
        Number(b.source === preferredSource) -
        Number(a.source === preferredSource);
      return (
        preferredDifference || sourceOrder(a.source) - sourceOrder(b.source)
      );
    })[0];

  return pose ? { source: pose.source, pose } : null;
}

export function tacCapGripperSources(rows: Record<string, number>[]): string[] {
  return [
    ...new Set(
      extractEpisodePoseTrajectories(rows)
        .filter(
          (trajectory) =>
            trajectory.rotationValues?.some((rotation) => rotation !== null) &&
            (trajectory.label.toLowerCase() === "left_tcp" ||
              trajectory.label.toLowerCase() === "right_tcp"),
        )
        .map((trajectory) => trajectory.source),
    ),
  ].sort((a, b) => sourceOrder(a) - sourceOrder(b));
}

export function hasTacCapGripperTracks(
  rows: Record<string, number>[],
): boolean {
  return extractTacCapGripperTracks(rows).length > 0;
}

/** Map a gripper sample to the URDF's unit opening range. */
export function normalizeTacCapGripperOpening(
  value: number | null,
  range: { min: number; max: number } | null,
): number {
  if (value === null || !Number.isFinite(value)) return 0;

  // TacCap recordings conventionally store gripper position in [0, 1]. Keep
  // that physical convention even if an individual episode only exercises a
  // small portion of the range; per-episode min/max scaling would exaggerate
  // tiny finger motion into a fully open/closed animation.
  if (range && range.min >= -1e-6 && range.max <= 1 + 1e-6) {
    return Math.max(0, Math.min(1, value));
  }
  if (range && range.max > range.min) {
    return Math.max(
      0,
      Math.min(1, (value - range.min) / (range.max - range.min)),
    );
  }
  return Math.max(0, Math.min(1, value));
}

function nearestValue(
  values: Array<number | null>,
  preferredIndex: number,
): number | null {
  if (values[preferredIndex] !== null && values[preferredIndex] !== undefined) {
    return values[preferredIndex];
  }
  for (let distance = 1; distance < values.length; distance += 1) {
    const before = values[preferredIndex - distance];
    if (before !== null && before !== undefined) return before;
    const after = values[preferredIndex + distance];
    if (after !== null && after !== undefined) return after;
  }
  return null;
}

export function sampleTacCapGripperFrame(
  track: TacCapGripperTrack,
  timeSeconds: number,
): TacCapGripperFrame | null {
  const location = locateEpisodePoseTrajectory(track.pose, timeSeconds);
  const rotation = sampleEpisodePoseRotation(track.pose, timeSeconds);
  if (!location || !rotation) return null;

  const lowerValue = nearestValue(track.gripperValues, location.lowerIndex);
  const upperValue = nearestValue(track.gripperValues, location.upperIndex);
  const rawOpening =
    lowerValue !== null && upperValue !== null
      ? lowerValue + (upperValue - lowerValue) * location.alpha
      : (lowerValue ?? upperValue);

  return {
    side: track.side,
    source: track.source,
    position: location.point,
    rotation,
    opening: normalizeTacCapGripperOpening(rawOpening, track.gripperRange),
  };
}

export function sampleTacCapHeadFrame(
  track: TacCapHeadTrack,
  timeSeconds: number,
): TacCapHeadFrame | null {
  const location = locateEpisodePoseTrajectory(track.pose, timeSeconds);
  const rotation = sampleEpisodePoseRotation(track.pose, timeSeconds);
  if (!location || !rotation) return null;

  return {
    source: track.source,
    position: location.point,
    rotation,
  };
}

import type { RotationMatrix3 } from "@/utils/poseTrajectory3d";
import { buildVersionedUrl } from "@/utils/versionUtils";

export type TacCapSide = "left" | "right";

export type TacCapPoseSelection = "canonical-tcp" | "tracker-to-tcp";

export type TacCapRigidTransform = {
  /** Child-frame origin expressed in the parent frame, in metres. */
  translation: readonly [number, number, number];
  /** Child-frame orientation expressed in the parent frame, row-major. */
  rotation: RotationMatrix3;
};

export type TacCapPoseProfile = {
  /**
   * `canonical-tcp` means the parquet pose already describes the gripper TCP.
   * `tracker-to-tcp` means at least one side needs a body-fixed correction.
   */
  mode: "canonical-tcp" | "tracker-to-tcp";
  correctionSource: "none" | "measured-default" | "dataset-metadata" | "mixed";
  reason: "selected-tcp" | "selected-tracker";
  /** Null means that side is already expressed in the canonical TCP frame. */
  corrections: Record<TacCapSide, TacCapRigidTransform | null>;
};

type TacCapExtrinsic = {
  position_m?: unknown;
  quaternion_wxyz?: unknown;
};

type TacCapExtrinsicsEpisode = {
  episode_index?: unknown;
  poses_are_ee?: unknown;
  tracker_to_ee?: {
    left?: TacCapExtrinsic;
    right?: TacCapExtrinsic;
  };
};

export type TacCapExtrinsicsMetadata = {
  version?: unknown;
  episodes?: TacCapExtrinsicsEpisode[];
};

const SIDES = ["left", "right"] as const;
const IDENTITY_ROTATION: RotationMatrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Measured leader-gripper transforms copied from the TacCap acquisition
 * source (`robots/taccap_gripper/ee_transform.py`). The Pico tracker is not
 * mounted with axes aligned to the gripper TCP, so an identity transform in a
 * Collector export leaves the parquet pose in the physical tracker frame.
 */
export const TACCAP_MEASURED_TRACKER_TO_TCP: Record<
  TacCapSide,
  TacCapRigidTransform
> = {
  left: {
    translation: [-0.160768654, -0.105859381, 0.02489732],
    rotation: quaternionWxyzToRotationMatrix([
      0.136862131, -0.378705573, 0.91358808, -0.056636271,
    ]),
  },
  right: {
    translation: [-0.161933698, 0.106110099, 0.025322636],
    rotation: quaternionWxyzToRotationMatrix([
      0.136839046, 0.378463784, 0.913688271, 0.056692009,
    ]),
  },
};

function finiteTuple3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const tuple = value.map(Number);
  return tuple.every(Number.isFinite)
    ? (tuple as [number, number, number])
    : null;
}

function finiteTuple4(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const tuple = value.map(Number);
  return tuple.every(Number.isFinite)
    ? (tuple as [number, number, number, number])
    : null;
}

export function quaternionWxyzToRotationMatrix(
  quaternion: readonly [number, number, number, number],
): RotationMatrix3 {
  const norm = Math.hypot(...quaternion);
  if (!Number.isFinite(norm) || norm <= 1e-12) return [...IDENTITY_ROTATION];
  const [w, x, y, z] = quaternion.map((value) => value / norm) as [
    number,
    number,
    number,
    number,
  ];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

function parseRigidTransform(value: TacCapExtrinsic | undefined) {
  const translation = finiteTuple3(value?.position_m);
  const quaternion = finiteTuple4(value?.quaternion_wxyz);
  if (!translation || !quaternion) return null;
  return {
    translation,
    rotation: quaternionWxyzToRotationMatrix(quaternion),
  } satisfies TacCapRigidTransform;
}

function isIdentityTransform(transform: TacCapRigidTransform): boolean {
  const epsilon = 1e-6;
  return (
    transform.translation.every((value) => Math.abs(value) <= epsilon) &&
    transform.rotation.every(
      (value, index) => Math.abs(value - IDENTITY_ROTATION[index]) <= epsilon,
    )
  );
}

function canonicalProfile(
  reason: TacCapPoseProfile["reason"],
): TacCapPoseProfile {
  return {
    mode: "canonical-tcp",
    correctionSource: "none",
    reason,
    corrections: { left: null, right: null },
  };
}

function trackerProfile(
  parsed: Record<TacCapSide, TacCapRigidTransform | null>,
  reason: TacCapPoseProfile["reason"],
): TacCapPoseProfile {
  const corrections = Object.fromEntries(
    SIDES.map((side) => {
      const explicit = parsed[side];
      return [
        side,
        explicit && !isIdentityTransform(explicit)
          ? explicit
          : TACCAP_MEASURED_TRACKER_TO_TCP[side],
      ];
    }),
  ) as Record<TacCapSide, TacCapRigidTransform | null>;

  const sources = SIDES.map((side) => {
    const explicit = parsed[side];
    return explicit && !isIdentityTransform(explicit)
      ? "dataset-metadata"
      : "measured-default";
  });
  const uniqueSources = new Set(sources);
  const correctionSource =
    uniqueSources.size === 1
      ? (sources[0] as TacCapPoseProfile["correctionSource"])
      : "mixed";

  return {
    mode: "tracker-to-tcp",
    correctionSource,
    reason,
    corrections,
  };
}

/**
 * Resolve how one exported episode's xyz+r1-r6 values should be interpreted.
 *
 * The viewer deliberately does not guess the recorded frame from trajectory
 * values. TCP is the safe default. When the user declares the values to be
 * Tracker poses, prefer the episode's recorded non-identity extrinsic and
 * otherwise use the measured TacCap hardware transform above.
 */
export function resolveTacCapPoseProfile(
  metadata: TacCapExtrinsicsMetadata | null,
  episodeIndex: number,
  selection: TacCapPoseSelection = "canonical-tcp",
): TacCapPoseProfile {
  const episode = Array.isArray(metadata?.episodes)
    ? metadata.episodes.find(
        (candidate) => Number(candidate.episode_index) === episodeIndex,
      )
    : undefined;
  const parsed = {
    left: parseRigidTransform(episode?.tracker_to_ee?.left),
    right: parseRigidTransform(episode?.tracker_to_ee?.right),
  };

  if (selection === "canonical-tcp") {
    return canonicalProfile("selected-tcp");
  }

  return trackerProfile(parsed, "selected-tracker");
}

const extrinsicsMetadataCache = new Map<
  string,
  Promise<TacCapExtrinsicsMetadata | null>
>();

/** Load optional Collector pose metadata once per dataset. */
export function loadTacCapExtrinsicsMetadata(
  repoId: string,
): Promise<TacCapExtrinsicsMetadata | null> {
  const cached = extrinsicsMetadataCache.get(repoId);
  if (cached) return cached;

  const loading = fetch(
    buildVersionedUrl(repoId, "v3.0", "meta/taccap_extrinsics.json"),
    { cache: "no-store" },
  )
    .then(async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const value = (await response.json()) as TacCapExtrinsicsMetadata;
      if (!value || !Array.isArray(value.episodes)) {
        throw new Error("invalid taccap_extrinsics.json");
      }
      return value;
    })
    .catch((error) => {
      extrinsicsMetadataCache.delete(repoId);
      throw error;
    });
  extrinsicsMetadataCache.set(repoId, loading);
  return loading;
}

export function multiplyRotationMatrices(
  left: RotationMatrix3,
  right: RotationMatrix3,
): RotationMatrix3 {
  const output = new Array<number>(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      output[row * 3 + column] =
        left[row * 3] * right[column] +
        left[row * 3 + 1] * right[3 + column] +
        left[row * 3 + 2] * right[6 + column];
    }
  }
  return output as RotationMatrix3;
}

export function transformTacCapTrackerPose(
  position: readonly [number, number, number],
  rotation: RotationMatrix3,
  trackerToTcp: TacCapRigidTransform,
): { position: [number, number, number]; rotation: RotationMatrix3 } {
  const [x, y, z] = trackerToTcp.translation;
  return {
    position: [
      position[0] + rotation[0] * x + rotation[1] * y + rotation[2] * z,
      position[1] + rotation[3] * x + rotation[4] * y + rotation[5] * z,
      position[2] + rotation[6] * x + rotation[7] * y + rotation[8] * z,
    ],
    rotation: multiplyRotationMatrices(rotation, trackerToTcp.rotation),
  };
}

export function rotationMatrixTo6d(
  rotation: RotationMatrix3,
): [number, number, number, number, number, number] {
  return [
    rotation[0],
    rotation[3],
    rotation[6],
    rotation[1],
    rotation[4],
    rotation[7],
  ];
}

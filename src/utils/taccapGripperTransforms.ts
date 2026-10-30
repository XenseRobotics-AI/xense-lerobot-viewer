import type { TacCapSide } from "@/utils/taccapGripperReplay";

export type Matrix4Elements = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
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

/**
 * Fixed root → URDF link4 translations measured by the supplied SolidWorks
 * models. The bundled left/right URDFs give link4 the same canonical TCP
 * orientation, so this transform contains translation only.
 */
export const TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION: Record<
  TacCapSide,
  readonly [number, number, number]
> = {
  left: [0.164636788170065, 0, -0.0158499715519367],
  right: [0.164643038155223, 0, -0.01599997155194],
};

/** Dataset (Z-up) to Three.js scene (Y-up) position mapping. */
export function tacCapDatasetPointToScene(
  point: readonly [number, number, number],
): [number, number, number] {
  return [point[0], point[2], -point[1]];
}

/**
 * Recorded canonical TCP → model root transform. Its rotation is identity for
 * both sides because both bundled link4 frames share the canonical heading.
 */
export function tacCapRecordedTcpToRootMatrix(
  side: TacCapSide,
): Matrix4Elements {
  const [x, y, z] = TACCAP_ROOT_TO_RECORDED_TCP_TRANSLATION[side];
  return [1, 0, 0, -x, 0, 1, 0, -y, 0, 0, 1, -z, 0, 0, 0, 1];
}

/**
 * Row-major Three.js transform for the recorded canonical TCP frame.
 * Dataset axes map as +X → scene +X, +Y → scene -Z, +Z → scene +Y.
 */
export function tacCapRecordedTcpSceneMatrix(
  position: readonly [number, number, number],
  rotation: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
): Matrix4Elements {
  const negate = (value: number) => (value === 0 ? 0 : -value);
  return [
    rotation[0],
    rotation[1],
    rotation[2],
    position[0],
    rotation[6],
    rotation[7],
    rotation[8],
    position[2],
    negate(rotation[3]),
    negate(rotation[4]),
    negate(rotation[5]),
    negate(position[1]),
    0,
    0,
    0,
    1,
  ];
}

/**
 * How a dataset orients its left and right TCP frames, declared in
 * `meta/info.json` → `tcp_frame_convention` (TacVerse data standard v0.4,
 * §3.4.2 / appendix D).
 *
 * - `same-axes-v0` — both hands share one axis set: X forward, Y left, Z up in
 *   the standard grip. This is what the bundled models are built against, and
 *   what a dataset that omits the field means.
 * - `mirrored-v1` — the hands are mirror-symmetric: +X runs along the tool
 *   toward the fingertips and +Y from the back of the hand to the palm on both.
 *   The right hand is unchanged; the left is the right-hand frame turned 180°
 *   about its own +X, `R_v1 = R_v0 · diag(1,-1,-1)`, so it reads X forward,
 *   Y right, Z down in the standard grip. In 6D terms only `left_tcp.r4..r6`
 *   flip sign.
 */
export type TcpFrameConvention = "same-axes-v0" | "mirrored-v1";

/**
 * Read the declared convention. Anything that is not exactly `mirrored-v1` —
 * missing, null, an unknown spelling — is the legacy `same-axes-v0`, which is
 * what every dataset written before the field existed means.
 */
export function parseTcpFrameConvention(value: unknown): TcpFrameConvention {
  return value === "mirrored-v1" ? "mirrored-v1" : "same-axes-v0";
}

/**
 * The declared value when it is present but names neither convention, else
 * null. A missing key is the legacy default and not reported; a typo is,
 * because `"mirrored"` read as `same-axes-v0` renders the left gripper flipped
 * with nothing on screen to say why. TacFlow-Engine refuses such a value
 * outright; the viewer still renders, and says what it fell back to.
 */
export function unrecognizedTcpFrameConvention(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value === "same-axes-v0" || value === "mirrored-v1") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Declared data TCP frame → the `same-axes-v0` frame the bundled models are
 * posed against, row-major. Identity except for the left hand of a
 * `mirrored-v1` dataset, where it is `diag(1,-1,-1)`: right-multiplying the
 * recorded rotation by it undoes the 180° turn about +X. Without it the left
 * gripper renders rolled over its own tool axis, camera underneath.
 *
 * Only model placement needs this. Trails use position alone, and angular
 * velocity is unchanged because a constant right factor cancels in `Ṙ·Rᵀ`.
 */
export function tcpConventionToModelMatrix(
  side: TacCapSide,
  convention: TcpFrameConvention,
): Matrix4Elements {
  const flip = side === "left" && convention === "mirrored-v1" ? -1 : 1;
  return [1, 0, 0, 0, 0, flip, 0, 0, 0, 0, flip, 0, 0, 0, 0, 1];
}

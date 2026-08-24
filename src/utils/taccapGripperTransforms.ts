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

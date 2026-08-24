import * as THREE from "three";

export type SceneBounds = {
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  extent: number;
};

/**
 * Dataset coordinates are x/y/z with **z up**; Three.js is **y up**. Map one
 * into the other while keeping the frame right-handed: (x, y, z) -> (x, z, -y).
 */
export function toScenePoint(
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [x, z, -y];
}

/**
 * Bounds over any number of flat xyz triple arrays, in scene coordinates.
 * Falls back to a unit box when nothing finite was supplied, so the camera fit
 * has something to aim at.
 */
export function sceneBoundsFromPointArrays(
  pointArrays: Iterable<ArrayLike<number>>,
): SceneBounds {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (const points of pointArrays) {
    for (let index = 0; index + 2 < points.length; index += 3) {
      const point = new THREE.Vector3(
        ...toScenePoint(points[index], points[index + 1], points[index + 2]),
      );
      min.min(point);
      max.max(point);
    }
  }

  if (!Number.isFinite(min.x)) {
    min.set(-0.5, -0.5, -0.5);
    max.set(0.5, 0.5, 0.5);
  }

  const center = min.clone().add(max).multiplyScalar(0.5);
  const size = max.clone().sub(min);
  return { min, max, center, extent: Math.max(size.x, size.y, size.z, 0.1) };
}

/** Round a ~1/10-of-extent grid spacing to the nearest 1/2/5 × power of ten. */
export function niceGridStep(extent: number): number {
  const rough = extent / 10;
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const normalized = rough / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : 5;
  return multiplier * power;
}

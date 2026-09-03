import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

export const stlGeometryCache = new Map<string, THREE.BufferGeometry>();
// In-flight promise cache — prevents duplicate simultaneous fetches
export const stlGeometryLoading = new Map<
  string,
  Promise<THREE.BufferGeometry>
>();

export function loadCachedStlGeometry(
  url: string,
  manager: THREE.LoadingManager,
): Promise<THREE.BufferGeometry> {
  // A cache hit still has to be announced to the LoadingManager. Without it,
  // a remount with a warm cache leaves the manager tracking only the .urdf
  // file, so `manager.onLoad` fires — and the caller clears its loading
  // overlay — while these meshes are still pending callbacks. itemEnd is
  // deferred a macrotask so the caller's `then` attaches the mesh first; same
  // ordering hazard STLLoader itself has (see CLAUDE.md).
  const releaseManagerAfterAttach = () => {
    setTimeout(() => manager.itemEnd(url), 0);
  };

  const cached = stlGeometryCache.get(url);
  if (cached) {
    manager.itemStart(url);
    releaseManagerAfterAttach();
    return Promise.resolve(cached);
  }

  const inFlight = stlGeometryLoading.get(url);
  if (inFlight) {
    manager.itemStart(url);
    return inFlight.then(
      (geometry) => {
        releaseManagerAfterAttach();
        return geometry;
      },
      (error) => {
        releaseManagerAfterAttach();
        throw error;
      },
    );
  }

  const loading = new Promise<THREE.BufferGeometry>((resolve, reject) => {
    new STLLoader(manager).load(url, resolve, undefined, reject);
  }).then(
    (geometry) => {
      stlGeometryCache.set(url, geometry);
      stlGeometryLoading.delete(url);
      return geometry;
    },
    (error) => {
      stlGeometryLoading.delete(url);
      throw error;
    },
  );
  stlGeometryLoading.set(url, loading);
  return loading;
}

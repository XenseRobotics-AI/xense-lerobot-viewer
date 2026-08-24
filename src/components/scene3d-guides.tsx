"use client";

import React, { useEffect } from "react";
import * as THREE from "three";
import { Html, Line, OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { SceneBounds } from "@/utils/scene3d";

export type ControlsHandle = React.ElementRef<typeof OrbitControls>;

/** Corner gnomon labelling the dataset axes, not the scene ones. */
export function AxisGuide({ bounds }: { bounds: SceneBounds }) {
  const length = bounds.extent * 0.18;
  const origin = new THREE.Vector3(
    bounds.min.x,
    bounds.min.y - bounds.extent * 0.04,
    bounds.max.z,
  );
  const labelClass =
    "pointer-events-none rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-semibold";

  return (
    <group>
      <Line
        points={[origin, origin.clone().add(new THREE.Vector3(length, 0, 0))]}
        color="#f87171"
        lineWidth={1.5}
      />
      <Line
        points={[origin, origin.clone().add(new THREE.Vector3(0, 0, -length))]}
        color="#4ade80"
        lineWidth={1.5}
      />
      <Line
        points={[origin, origin.clone().add(new THREE.Vector3(0, length, 0))]}
        color="#60a5fa"
        lineWidth={1.5}
      />
      <Html position={[origin.x + length, origin.y, origin.z]} center>
        <span className={`${labelClass} text-red-300`}>X</span>
      </Html>
      <Html position={[origin.x, origin.y, origin.z - length]} center>
        <span className={`${labelClass} text-green-300`}>Y</span>
      </Html>
      <Html position={[origin.x, origin.y + length, origin.z]} center>
        <span className={`${labelClass} text-blue-300`}>Z</span>
      </Html>
    </group>
  );
}

/**
 * Frame `bounds` and point the controls at its center.
 *
 * `offset` is a multiple of the fitted distance, in scene coordinates. The
 * two callers deliberately differ: the single-episode pose view sits behind
 * -X (robot convention: +X forward, +Z up, so you look along the direction of
 * travel), while the cross-episode view sits in front on +X to read the
 * spread of trajectories side-on.
 */
export function CameraFit({
  bounds,
  controlsRef,
  offset = [0.75, 0.55, 0.75],
}: {
  bounds: SceneBounds;
  controlsRef: React.RefObject<ControlsHandle | null>;
  offset?: [number, number, number];
}) {
  const { camera } = useThree();
  const [offsetX, offsetY, offsetZ] = offset;

  useEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const distance =
      (bounds.extent / (2 * Math.tan((perspective.fov * Math.PI) / 360))) *
      1.45;

    perspective.up.set(0, 1, 0);
    perspective.position.set(
      bounds.center.x + distance * offsetX,
      bounds.center.y + distance * offsetY,
      bounds.center.z + distance * offsetZ,
    );
    perspective.near = Math.max(distance / 1000, 0.001);
    perspective.far = Math.max(distance * 20, 100);
    perspective.updateProjectionMatrix();

    controlsRef.current?.target.copy(bounds.center);
    controlsRef.current?.update();
  }, [bounds, camera, controlsRef, offsetX, offsetY, offsetZ]);

  return null;
}

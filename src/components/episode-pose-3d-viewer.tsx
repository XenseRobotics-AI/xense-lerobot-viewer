"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useT } from "@/context/locale-context";
import {
  AxisGuide,
  CameraFit,
  type ControlsHandle,
} from "@/components/scene3d-guides";
import {
  niceGridStep,
  sceneBoundsFromPointArrays,
  toScenePoint,
  type SceneBounds,
} from "@/utils/scene3d";
import { useTime } from "@/context/time-context";
import {
  extractEpisodePoseTrajectories,
  locateEpisodePoseTrajectory,
  sampleEpisodePoseRotation,
  type EpisodePoseTrajectory,
  type EpisodePoseTrajectoryLocation,
  type RotationMatrix3,
} from "@/utils/poseTrajectory3d";

function trajectoryColor(trajectory: EpisodePoseTrajectory): string {
  const source = trajectory.source.toLowerCase();
  const label = trajectory.label.toLowerCase();
  if (source === "action" && label.includes("left")) return "#22d3ee";
  if (source === "action" && label.includes("right")) return "#f472b6";
  if (source === "observation.state" && label.includes("left")) {
    return "#34d399";
  }
  if (source === "observation.state" && label.includes("right")) {
    return "#fbbf24";
  }

  let hash = 0;
  for (const character of trajectory.id) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  const fallback = ["#60a5fa", "#c084fc", "#fb7185", "#a3e635"];
  return fallback[Math.abs(hash) % fallback.length];
}

function sourceLabel(source: string): string {
  return source;
}

function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

/**
 * The global time context throttles React renders for the rest of the UI.
 * Keep a local frame clock for this visualizer so playback advances at the
 * dataset FPS between sparse video `timeupdate` events.
 */
function useFramePlaybackTime(fps: number | undefined): number {
  const { currentTime, duration, isPlaying, subscribe } = useTime();
  const frameRate =
    Number.isFinite(fps) && (fps ?? 0) > 0 ? (fps as number) : 30;
  const snapToFrame = useCallback(
    (time: number) => {
      const bounded = Math.max(
        0,
        duration > 0 ? Math.min(time, duration) : time,
      );
      // A video frame owns the interval until the next frame boundary, so
      // floor rather than round; this keeps the marker from appearing one
      // frame ahead of the video.
      const snapped =
        Math.floor((bounded + Number.EPSILON) * frameRate) / frameRate;
      return duration > 0 ? Math.min(snapped, duration) : snapped;
    },
    [duration, frameRate],
  );
  const sourceRef = useRef({
    time: Number.isFinite(currentTime) ? currentTime : 0,
    wallTime: performance.now(),
  });
  const currentTimeRef = useRef(sourceRef.current.time);
  const [frameTime, setFrameTime] = useState(() =>
    snapToFrame(sourceRef.current.time),
  );

  useEffect(() => {
    currentTimeRef.current = Number.isFinite(currentTime) ? currentTime : 0;
  }, [currentTime]);

  useEffect(() => {
    const updateAnchor = (time: number) => {
      const finiteTime = Number.isFinite(time) ? time : 0;
      currentTimeRef.current = finiteTime;
      sourceRef.current = {
        time: finiteTime,
        wallTime: performance.now(),
      };
      const next = snapToFrame(finiteTime);
      setFrameTime((previous) => (previous === next ? previous : next));
    };

    updateAnchor(currentTimeRef.current);
    return subscribe(updateAnchor);
  }, [snapToFrame, subscribe]);

  useEffect(() => {
    if (!isPlaying) {
      const next = snapToFrame(currentTimeRef.current);
      setFrameTime((previous) => (previous === next ? previous : next));
      return;
    }

    // Re-anchor on resume: while paused the video emits no `timeupdate`, so
    // `sourceRef.wallTime` is still the moment playback stopped. Extrapolating
    // from it would count the whole pause as elapsed playback and jump the
    // marker to the end of the episode until the next tick re-anchors it.
    sourceRef.current = {
      time: currentTimeRef.current,
      wallTime: performance.now(),
    };

    let animationFrame = 0;
    const tick = (now: number) => {
      const elapsedSeconds = Math.max(
        0,
        (now - sourceRef.current.wallTime) / 1000,
      );
      const next = snapToFrame(sourceRef.current.time + elapsedSeconds);
      setFrameTime((previous) => (previous === next ? previous : next));
      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, snapToFrame]);

  return frameTime;
}

function rotationColumn(
  matrix: RotationMatrix3,
  column: 0 | 1 | 2,
): [number, number, number] {
  return [matrix[column], matrix[3 + column], matrix[6 + column]];
}

function PoseOrientationFrame({
  origin,
  rotation,
  size,
  highlighted,
}: {
  /** Origin in dataset coordinates, before the Z-up to Y-up conversion. */
  origin: [number, number, number];
  rotation: RotationMatrix3;
  size: number;
  highlighted: boolean;
}) {
  const resources = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(18), 3),
    );
    const colors = new Float32Array(18);
    ["#f87171", "#4ade80", "#60a5fa"].forEach((color, axisIndex) => {
      const parsed = new THREE.Color(color);
      for (let vertex = 0; vertex < 2; vertex += 1) {
        const offset = (axisIndex * 2 + vertex) * 3;
        colors[offset] = parsed.r;
        colors[offset + 1] = parsed.g;
        colors[offset + 2] = parsed.b;
      }
    });
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const segments = new THREE.LineSegments(geometry, material);
    // Native Three.js line raycasts use a one-world-unit threshold by
    // default. TCP trajectories are often smaller than that, so an axis can
    // otherwise register as hovered from almost anywhere in the canvas.
    // The trajectory and playback marker provide the intended hover targets.
    segments.raycast = () => undefined;
    segments.frustumCulled = false;
    segments.renderOrder = 3;
    return { geometry, material, segments };
  }, []);
  const axes = useMemo(
    () =>
      [
        {
          label: "X",
          color: "#f87171",
          direction: rotationColumn(rotation, 0),
        },
        {
          label: "Y",
          color: "#4ade80",
          direction: rotationColumn(rotation, 1),
        },
        {
          label: "Z",
          color: "#60a5fa",
          direction: rotationColumn(rotation, 2),
        },
      ] as const,
    [rotation],
  );
  const sceneOrigin = useMemo(
    () => new THREE.Vector3(...toScenePoint(...origin)),
    [origin],
  );
  const endpoints = useMemo(
    () =>
      axes.map(
        (axis) =>
          new THREE.Vector3(
            ...toScenePoint(
              origin[0] + axis.direction[0] * size,
              origin[1] + axis.direction[1] * size,
              origin[2] + axis.direction[2] * size,
            ),
          ),
      ),
    [axes, origin, size],
  );

  useLayoutEffect(() => {
    const positions = resources.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    endpoints.forEach((endpoint, axisIndex) => {
      positions.setXYZ(
        axisIndex * 2,
        sceneOrigin.x,
        sceneOrigin.y,
        sceneOrigin.z,
      );
      positions.setXYZ(axisIndex * 2 + 1, endpoint.x, endpoint.y, endpoint.z);
    });
    positions.needsUpdate = true;
    resources.material.opacity = highlighted ? 1 : 0.8;
  }, [endpoints, highlighted, resources, sceneOrigin]);

  useEffect(
    () => () => {
      resources.geometry.dispose();
      resources.material.dispose();
    },
    [resources],
  );

  return (
    <group>
      <primitive object={resources.segments} />
      {highlighted &&
        axes.map((axis, index) => (
          <React.Fragment key={axis.label}>
            {highlighted && (
              <Html position={endpoints[index]} center>
                <span
                  className="pointer-events-none rounded bg-slate-950/80 px-0.5 text-[8px] font-semibold leading-none"
                  style={{ color: axis.color }}
                >
                  {axis.label}
                </span>
              </Html>
            )}
          </React.Fragment>
        ))}
    </group>
  );
}

function ActiveTrajectoryLine({
  points,
  color,
  playback,
  highlighted,
}: {
  points: THREE.Vector3[];
  color: string;
  playback: EpisodePoseTrajectoryLocation;
  highlighted: boolean;
}) {
  const resources = useMemo(() => {
    const prefixGeometry = new THREE.BufferGeometry().setFromPoints(points);
    prefixGeometry.setDrawRange(0, 0);
    const connectorGeometry = new THREE.BufferGeometry();
    connectorGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
    const prefix = new THREE.Line(prefixGeometry, material);
    const connector = new THREE.Line(connectorGeometry, material);
    prefix.frustumCulled = false;
    connector.frustumCulled = false;
    prefix.renderOrder = 2;
    connector.renderOrder = 2;
    const group = new THREE.Group();
    group.add(prefix, connector);
    return {
      connector,
      connectorGeometry,
      group,
      material,
      prefixGeometry,
    };
  }, [color, points]);

  useLayoutEffect(() => {
    resources.prefixGeometry.setDrawRange(0, playback.completedPointCount);
    resources.material.opacity = highlighted ? 1 : 0.9;

    const hasConnector = playback.lowerIndex !== playback.upperIndex;
    resources.connector.visible = hasConnector;
    if (!hasConnector) return;

    const start = points[playback.lowerIndex];
    const end = toScenePoint(...playback.point);
    const positions = resources.connectorGeometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    positions.setXYZ(0, start.x, start.y, start.z);
    positions.setXYZ(1, end[0], end[1], end[2]);
    positions.needsUpdate = true;
  }, [highlighted, playback, points, resources]);

  useEffect(
    () => () => {
      resources.prefixGeometry.dispose();
      resources.connectorGeometry.dispose();
      resources.material.dispose();
    },
    [resources],
  );

  return <primitive object={resources.group} />;
}

function computeBounds(trajectories: EpisodePoseTrajectory[]): SceneBounds {
  return sceneBoundsFromPointArrays(
    trajectories.map((trajectory) => trajectory.points),
  );
}

function PoseLine({
  trajectory,
  highlighted,
  currentTime,
  pointRadius,
  onHover,
}: {
  trajectory: EpisodePoseTrajectory;
  highlighted: boolean;
  currentTime: number;
  pointRadius: number;
  onHover: (id: string | null) => void;
}) {
  const points = useMemo(() => {
    const result: THREE.Vector3[] = [];
    for (let index = 0; index + 2 < trajectory.points.length; index += 3) {
      result.push(
        new THREE.Vector3(
          ...toScenePoint(
            trajectory.points[index],
            trajectory.points[index + 1],
            trajectory.points[index + 2],
          ),
        ),
      );
    }
    return result;
  }, [trajectory]);

  const playback = useMemo(
    () => locateEpisodePoseTrajectory(trajectory, currentTime),
    [currentTime, trajectory],
  );
  const rotation = useMemo(
    () => sampleEpisodePoseRotation(trajectory, currentTime),
    [currentTime, trajectory],
  );
  const currentPoint = playback ? toScenePoint(...playback.point) : null;
  const color = trajectoryColor(trajectory);

  if (points.length < 2) return null;

  return (
    <group>
      <Line
        points={points}
        color={color}
        lineWidth={highlighted ? 3 : 1.2}
        transparent
        opacity={highlighted ? 0.5 : 0.16}
        depthWrite={false}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(trajectory.id);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onHover(null);
        }}
      />
      {playback && (
        <ActiveTrajectoryLine
          points={points}
          color={color}
          playback={playback}
          highlighted={highlighted}
        />
      )}
      {currentPoint && (
        <>
          <mesh
            position={currentPoint}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(trajectory.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onHover(null);
            }}
          >
            <sphereGeometry args={[pointRadius, 12, 12]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={highlighted ? 1 : 0.95}
            />
          </mesh>
          {rotation && playback && (
            <PoseOrientationFrame
              origin={playback.point}
              rotation={rotation}
              size={pointRadius * 3}
              highlighted={highlighted}
            />
          )}
        </>
      )}
    </group>
  );
}

function PoseScene({
  trajectories,
  boundsTrajectories,
  currentTime,
  hoveredId,
  onHover,
}: {
  trajectories: EpisodePoseTrajectory[];
  boundsTrajectories: EpisodePoseTrajectory[];
  currentTime: number;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
}) {
  const controlsRef = useRef<ControlsHandle | null>(null);
  // Keep the camera bounds based on every trajectory, not only the selected
  // legend entries. Toggling action/state or left/right therefore never
  // changes the zoom or camera target.
  const bounds = useMemo(
    () => computeBounds(boundsTrajectories),
    [boundsTrajectories],
  );
  const size = bounds.extent * 1.4;
  const pointRadius = Math.max(bounds.extent * 0.012, 0.002);

  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ position: [1, 1, 1], fov: 45, near: 0.001, far: 100 }}
      gl={{ antialias: true, alpha: false }}
    >
      <color attach="background" args={["#111827"]} />
      {trajectories.map((trajectory) => (
        <PoseLine
          key={trajectory.id}
          trajectory={trajectory}
          highlighted={hoveredId === trajectory.id}
          currentTime={currentTime}
          pointRadius={pointRadius}
          onHover={onHover}
        />
      ))}
      <Grid
        args={[size, size]}
        position={[
          bounds.center.x,
          bounds.min.y - bounds.extent * 0.05,
          bounds.center.z,
        ]}
        cellSize={niceGridStep(bounds.extent)}
        cellThickness={0.45}
        cellColor="#334155"
        sectionSize={niceGridStep(bounds.extent) * 5}
        sectionThickness={0.8}
        sectionColor="#475569"
        fadeDistance={size * 1.5}
        infiniteGrid
      />
      <AxisGuide bounds={bounds} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
      />
      <CameraFit
        bounds={bounds}
        controlsRef={controlsRef}
        offset={[-0.9, 0.55, 0.35]}
      />
    </Canvas>
  );
}

export default function EpisodePose3DViewer({
  rows,
  fps,
}: {
  rows: Record<string, number>[];
  fps?: number;
}) {
  const t = useT();
  const { duration } = useTime();
  const playbackTime = useFramePlaybackTime(fps);
  const trajectories = useMemo(
    () => extractEpisodePoseTrajectories(rows),
    [rows],
  );
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    setVisibleIds(new Set(trajectories.map((trajectory) => trajectory.id)));
    setHoveredId(null);
  }, [trajectories]);

  const visibleTrajectories = useMemo(
    () => trajectories.filter((trajectory) => visibleIds.has(trajectory.id)),
    [trajectories, visibleIds],
  );
  const hoveredTrajectory = trajectories.find(
    (trajectory) => trajectory.id === hoveredId,
  );
  const hoveredPlayback = hoveredTrajectory
    ? locateEpisodePoseTrajectory(hoveredTrajectory, playbackTime)
    : null;

  useEffect(() => {
    if (hoveredId && !visibleIds.has(hoveredId)) setHoveredId(null);
  }, [hoveredId, visibleIds]);

  const toggleTrajectory = (id: string) => {
    setVisibleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (trajectories.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-white/10 bg-[var(--surface-1)]/40 text-sm text-slate-500">
        {t("chart.threeDNoData")}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-[var(--surface-1)]/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {trajectories.map((trajectory) => {
            const active = visibleIds.has(trajectory.id);
            return (
              <button
                key={trajectory.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleTrajectory(trajectory.id)}
                className={`inline-flex items-center gap-1.5 text-xs transition-colors ${
                  active
                    ? "text-slate-200"
                    : "text-slate-600 hover:text-slate-400"
                }`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: trajectoryColor(trajectory),
                    opacity: active ? 1 : 0.3,
                  }}
                />
                {sourceLabel(trajectory.source)} · {trajectory.label}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-slate-500">
          <span>
            {t("chart.threeDPointCount", {
              count: visibleTrajectories.reduce(
                (sum, trajectory) => sum + trajectory.points.length / 3,
                0,
              ),
            })}
          </span>
          <span className="ml-3 tabular-nums">
            {t("chart.threeDPlayback", {
              current: playbackTime.toFixed(2),
              duration: duration.toFixed(2),
            })}
          </span>
        </div>
      </div>

      <div
        className="flex min-h-7 items-center gap-2 rounded border border-white/10 bg-slate-950/30 px-2 py-1 text-[11px]"
        aria-live="polite"
      >
        {hoveredTrajectory ? (
          <>
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: trajectoryColor(hoveredTrajectory) }}
            />
            <span className="text-slate-100">
              {sourceLabel(hoveredTrajectory.source)} ·{" "}
              {hoveredTrajectory.label}
            </span>
            {hoveredPlayback && (
              <span className="ml-1 truncate font-mono text-[10px] tabular-nums text-slate-400">
                x {formatCoordinate(hoveredPlayback.point[0])} · y{" "}
                {formatCoordinate(hoveredPlayback.point[1])} · z{" "}
                {formatCoordinate(hoveredPlayback.point[2])} m
              </span>
            )}
          </>
        ) : (
          <span className="text-slate-500">{t("chart.threeDHoverPrompt")}</span>
        )}
      </div>

      <div
        className="relative h-[500px] overflow-hidden rounded-md border border-white/10 bg-slate-900"
        onPointerLeave={() => setHoveredId(null)}
      >
        <PoseScene
          trajectories={visibleTrajectories}
          boundsTrajectories={trajectories}
          currentTime={playbackTime}
          hoveredId={hoveredId}
          onHover={setHoveredId}
        />
        {visibleTrajectories.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-sm text-slate-500">
            {t("chart.threeDSelectTrajectory")}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span>{t("chart.threeDControls")}</span>
        <span>
          {t("chart.threeDCoordinate")} · {t("chart.threeDRotationAxes")}
        </span>
      </div>
    </div>
  );
}

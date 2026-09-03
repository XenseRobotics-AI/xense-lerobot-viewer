"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { useThree } from "@react-three/fiber";
import { Grid, Html, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import type { URDFRobot } from "urdf-loader";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { loadCachedStlGeometry } from "@/utils/urdfStlCache";
import {
  locateEpisodePoseTrajectory,
  selectTrailStartIndex,
  type EpisodePoseTrajectory,
} from "@/utils/poseTrajectory3d";
import {
  tacCapDatasetPointToScene,
  tacCapRecordedTcpSceneMatrix,
  tacCapRecordedTcpToRootMatrix,
} from "@/utils/taccapGripperTransforms";
import { mapNormalizedGripperToJoint } from "@/utils/urdfGripperMapping";
import type {
  TacCapGripperFrame,
  TacCapGripperTrack,
  TacCapHeadFrame,
  TacCapHeadTrack,
  TacCapSide,
} from "@/utils/taccapGripperReplay";

const TACCAP_TRAIL_DURATION = 3.0;
const TACCAP_TRAIL_MAX_DURATION = 10.0;
const TACCAP_TRAIL_MIN_SPAN_FRACTION = 0.12;
const TACCAP_TRAIL_SOLID_COLOR_DURATION = 1.0;
const TRAIL_CAPACITY_STEP = 128;
const TACCAP_TRAIL_MIN_COLOR_INTENSITY = 0.35;

const TACCAP_GRIPPER_URDF: Record<TacCapSide, string> = {
  left: "/urdf/taccap-grippers/left/gripper.urdf",
  right: "/urdf/taccap-grippers/right/gripper.urdf",
};
const TACCAP_TRAIL_COLOR: Record<TacCapSide, string> = {
  left: "#22d3ee",
  right: "#f472b6",
};
const TACCAP_HEAD_COLOR = "#facc15";
const TACCAP_HEADSET = {
  // Pico 4 Ultra Enterprise, approximate exterior in metres. Pico publishes a
  // weight and a 165 mm facebox but not a width/height/depth triple, so the
  // shell is proportioned from product photography around that one measured
  // figure. The recorded head pose remains the model origin; no unmeasured
  // tracker -> headset offset is introduced.
  visorWidth: 0.195,
  visorHeight: 0.098,
  // Pancake optics: the front unit is notably thin, which is the silhouette
  // that reads as "Pico 4 Ultra" rather than a generic HMD box.
  visorDepth: 0.05,
  gasketWidth: 0.165,
  gasketHeight: 0.088,
  gasketDepth: 0.055,
  // Semi-rigid halo strap with the battery as a rear counterweight.
  haloRadius: 0.104,
  haloTube: 0.0075,
  haloCenterX: -0.085,
  haloZ: 0.018,
  batteryX: -0.168,
} as const;
// Front opening of the halo ring, so the strap clears the visor instead of
// passing through it.
const TACCAP_HALO_GAP_HALF = 0.62;
const TACCAP_LOCAL_POSE_AXES = [
  { label: "X", direction: [1, 0, 0] as const, color: "#ef4444" },
  { label: "Y", direction: [0, 1, 0] as const, color: "#22c55e" },
  { label: "Z", direction: [0, 0, 1] as const, color: "#3b82f6" },
] as const;
const TACCAP_WORLD_AXES = [
  {
    label: "+X",
    // Dataset +X is forward and remains Three.js +X.
    direction: [1, 0, 0] as const,
    color: "#ef4444",
  },
  {
    label: "+Y",
    // Dataset +Y is left. The Z-up → Y-up scene conversion maps it to -Z.
    direction: [0, 0, -1] as const,
    color: "#22c55e",
  },
  {
    label: "+Z",
    // Dataset +Z is up and therefore maps to Three.js +Y.
    direction: [0, 1, 0] as const,
    color: "#3b82f6",
  },
] as const;

type SceneBounds = {
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  extent: number;
};

/**
 * Build the Three.js transform whose local frame is the recorded link4 frame.
 * Dataset coordinates use Z-up; the scene uses Y-up.
 */
function tacCapLink4SceneMatrix(frame: TacCapGripperFrame): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    ...tacCapRecordedTcpSceneMatrix(frame.position, frame.rotation),
  );
}

function applyTacCapGripperFrame(
  robot: URDFRobot,
  recordedTcpToRoot: THREE.Matrix4,
  frame: TacCapGripperFrame,
) {
  // joint2 mimics joint1 with multiplier -1 in both bundled URDFs.
  const driveJoint = robot.joints.joint1;
  robot.setJointValue(
    "joint1",
    mapNormalizedGripperToJoint(frame.opening, driveJoint.limit),
  );
  robot.matrix.copy(tacCapLink4SceneMatrix(frame)).multiply(recordedTcpToRoot);
  robot.matrixWorldNeedsUpdate = true;
  robot.updateMatrixWorld(true);
}

function TacCapAxisArrow({
  alwaysVisible = false,
  color,
  direction,
  label,
  length,
  showLabel = true,
}: {
  alwaysVisible?: boolean;
  color: string;
  direction: readonly [number, number, number];
  label: string;
  length: number;
  showLabel?: boolean;
}) {
  const arrow = useMemo(() => {
    const helper = new THREE.ArrowHelper(
      new THREE.Vector3(...direction),
      new THREE.Vector3(),
      length,
      color,
      length * 0.2,
      length * 0.1,
    );
    if (alwaysVisible) {
      helper.traverse((child) => {
        child.renderOrder = 21;
        if (!(child instanceof THREE.Line || child instanceof THREE.Mesh)) {
          return;
        }
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((material) => {
          material.depthTest = false;
          material.depthWrite = false;
        });
      });
    }
    return helper;
  }, [alwaysVisible, color, direction, length]);
  const labelPosition = useMemo(
    () =>
      new THREE.Vector3(...direction)
        .multiplyScalar(length * 1.16)
        .toArray() as [number, number, number],
    [direction, length],
  );

  useEffect(
    () => () => {
      arrow.line.geometry.dispose();
      arrow.cone.geometry.dispose();
      if (Array.isArray(arrow.line.material)) {
        arrow.line.material.forEach((material) => material.dispose());
      } else {
        arrow.line.material.dispose();
      }
      if (Array.isArray(arrow.cone.material)) {
        arrow.cone.material.forEach((material) => material.dispose());
      } else {
        arrow.cone.material.dispose();
      }
    },
    [arrow],
  );

  return (
    <>
      <primitive object={arrow} />
      {showLabel && (
        <Html
          center
          position={labelPosition}
          style={{ pointerEvents: "none" }}
          zIndexRange={[10, 0]}
        >
          <span
            className="rounded border border-white/15 bg-slate-950/85 px-1 py-0.5 font-mono text-[9px] font-semibold leading-none shadow"
            style={{ color }}
          >
            {label}
          </span>
        </Html>
      )}
    </>
  );
}

function TacCapWorldAxes({
  bounds,
  groundY,
}: {
  bounds: SceneBounds;
  groundY: number;
}) {
  const length = Math.min(0.16, Math.max(0.08, bounds.extent * 0.18));
  // Put the reference in a stable grid corner. +X, +Y and +Z all point into
  // the framed scene, so it stays visible without covering either gripper.
  const origin = useMemo(
    () =>
      [
        bounds.min.x + length * 0.45,
        groundY + 0.004,
        bounds.max.z - length * 0.45,
      ] as [number, number, number],
    [bounds, groundY, length],
  );

  return (
    <group position={origin}>
      <mesh>
        <sphereGeometry args={[length * 0.045, 12, 8]} />
        <meshBasicMaterial color="#e2e8f0" toneMapped={false} />
      </mesh>
      {TACCAP_WORLD_AXES.map((axis) => (
        <TacCapAxisArrow key={axis.label} length={length} {...axis} />
      ))}
    </group>
  );
}

function tacCapSceneBounds(
  tracks: TacCapGripperTrack[],
  headTrack: TacCapHeadTrack | null,
): SceneBounds {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const poses = [
    ...tracks.map((track) => track.pose),
    ...(headTrack ? [headTrack.pose] : []),
  ];
  for (const pose of poses) {
    for (let index = 0; index + 2 < pose.points.length; index += 3) {
      const point = tacCapDatasetPointToScene([
        pose.points[index],
        pose.points[index + 1],
        pose.points[index + 2],
      ]);
      min.min(new THREE.Vector3(...point));
      max.max(new THREE.Vector3(...point));
    }
  }
  if (!Number.isFinite(min.x)) {
    min.set(-0.5, -0.5, -0.5);
    max.set(0.5, 0.5, 0.5);
  }
  // The link4 origin sits about 16.5 cm ahead of base_link. Leave enough
  // framing room for the model around each recorded endpoint.
  min.addScalar(-0.2);
  max.addScalar(0.2);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const size = max.clone().sub(min);
  return {
    min,
    max,
    center,
    extent: Math.max(size.x, size.y, size.z, 0.4),
  };
}

function TacCapCameraFit({ bounds }: { bounds: SceneBounds }) {
  const { camera, controls } = useThree();

  useEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const distance =
      (bounds.extent / (2 * Math.tan((perspective.fov * Math.PI) / 360))) *
      1.35;
    // Initial robot/world convention: +X forward, +Z up. Dataset +Z is the
    // scene's +Y, so keep camera.up on +Y and look mostly from behind -X.
    perspective.up.set(0, 1, 0);
    perspective.position.set(
      bounds.center.x - distance * 0.9,
      bounds.center.y + distance * 0.55,
      bounds.center.z + distance * 0.35,
    );
    perspective.near = Math.max(distance / 1000, 0.001);
    perspective.far = Math.max(distance * 20, 100);
    perspective.lookAt(bounds.center);
    perspective.updateProjectionMatrix();
    const orbit = controls as unknown as {
      target?: THREE.Vector3;
      update?: () => void;
    };
    orbit?.target?.copy(bounds.center);
    orbit?.update?.();
  }, [bounds, camera, controls]);

  return null;
}

function TacCapGripperModel({
  frame,
  side,
  onReady,
}: {
  frame: TacCapGripperFrame | null;
  side: TacCapSide;
  onReady: (side: TacCapSide) => void;
}) {
  const { scene } = useThree();
  const robotRef = useRef<URDFRobot | null>(null);
  const recordedTcpToRootRef = useRef<THREE.Matrix4 | null>(null);
  const frameRef = useRef<TacCapGripperFrame | null>(frame);
  if (frame) frameRef.current = frame;

  useEffect(() => {
    let cancelled = false;
    let mountedRobot: URDFRobot | null = null;
    let robotLoaded = false;
    let assetsLoaded = false;
    let readyReported = false;
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);

    const reportReady = () => {
      if (cancelled || readyReported || !robotLoaded || !assetsLoaded) {
        return;
      }
      readyReported = true;
      onReady(side);
    };

    manager.onLoad = () => {
      assetsLoaded = true;
      reportReady();
    };

    loader.loadMeshCb = (url, meshManager, onLoad) => {
      loadCachedStlGeometry(url, meshManager)
        .then((geometry) => {
          const mesh = new THREE.Mesh(geometry);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          onLoad(mesh);
        })
        .catch((error) => onLoad(new THREE.Object3D(), error as Error));
    };

    loader.load(
      TACCAP_GRIPPER_URDF[side],
      (robot) => {
        if (cancelled) return;
        mountedRobot = robot;
        robotRef.current = robot;
        robot.matrixAutoUpdate = false;
        robot.updateMatrixWorld(true);

        const link4 = robot.links.link4;
        if (!link4) {
          console.error(`TacCap ${side} URDF has no link4 frame`);
          return;
        }
        // Incoming frames use the canonical TCP convention. Both bundled
        // URDFs now give link4 the same X/Y orientation, so only the measured
        // root -> TCP translation is needed here.
        recordedTcpToRootRef.current = new THREE.Matrix4().set(
          ...tacCapRecordedTcpToRootMatrix(side),
        );
        robot.traverse((child) => {
          child.castShadow = true;
          child.receiveShadow = true;
        });
        scene.add(robot);
        if (frameRef.current) {
          applyTacCapGripperFrame(
            robot,
            recordedTcpToRootRef.current,
            frameRef.current,
          );
        } else {
          robot.visible = false;
        }
        robotLoaded = true;
        reportReady();
      },
      undefined,
      (error) => {
        if (!cancelled) {
          console.error(`Failed to load TacCap ${side} gripper:`, error);
        }
      },
    );

    return () => {
      cancelled = true;
      const robot = mountedRobot ?? robotRef.current;
      if (robot) scene.remove(robot);
      if (robotRef.current === mountedRobot) robotRef.current = null;
      recordedTcpToRootRef.current = null;
    };
  }, [onReady, scene, side]);

  useLayoutEffect(() => {
    const robot = robotRef.current;
    const recordedTcpToRoot = recordedTcpToRootRef.current;
    if (!robot || !recordedTcpToRoot) return;

    robot.visible = frame !== null;
    if (!frame) return;

    applyTacCapGripperFrame(robot, recordedTcpToRoot, frame);
  }, [frame]);

  return null;
}

/**
 * TacCap playback trail matching the original 3D Replay treatment: a 2 px
 * Line2 whose older section brightens within the track's own colour instead
 * of fading to black. The newest section then stays at the full track colour
 * for a short period. TacCap keeps three seconds of history so the trail
 * remains useful during slow motions.
 */
function TacCapPoseTrail({
  alwaysVisible = false,
  color,
  enabled,
  pose,
  sceneExtent,
  timeSeconds,
}: {
  alwaysVisible?: boolean;
  color: string;
  enabled: boolean;
  pose: EpisodePoseTrajectory;
  /** Scene size, so the trail's size floor scales with what is on screen. */
  sceneExtent: number;
  timeSeconds: number;
}) {
  const viewportSize = useThree((state) => state.size);
  const trailColor = useMemo(() => new THREE.Color(color), [color]);
  const scenePositions = useMemo(() => {
    const positions = new Float32Array(pose.points.length);
    for (let index = 0; index + 2 < pose.points.length; index += 3) {
      const point = tacCapDatasetPointToScene([
        pose.points[index],
        pose.points[index + 1],
        pose.points[index + 2],
      ]);
      positions[index] = point[0];
      positions[index + 1] = point[1];
      positions[index + 2] = point[2];
    }
    return positions;
  }, [pose]);
  const resources = useMemo(() => {
    const material = new LineMaterial({
      color: 0xffffff,
      depthTest: !alwaysVisible,
      depthWrite: false,
      linewidth: 2,
      transparent: true,
      vertexColors: true,
      worldUnits: false,
    });
    const line = new Line2(new LineGeometry(), material);
    line.frustumCulled = false;
    line.raycast = () => undefined;
    line.renderOrder = alwaysVisible ? 20 : 2;
    line.visible = false;
    // Capacity lives on the resource object rather than in a ref so it is
    // reset together with the line it describes.
    return { line, material, capacity: 0 };
  }, [alwaysVisible]);
  // This effect runs once per rendered frame per track. Scratch buffers sized
  // to the whole trajectory are reused across frames so the hot path only
  // writes into them — allocating a pair of Float32Arrays here (plus the
  // Array.from copies the geometry does not need) is what made the trail the
  // GC-heaviest thing in the scene. The scratch is then blitted into the
  // geometry's interleaved buffers directly; see the note at the write.
  const scratch = useRef<{ positions: Float32Array; colors: Float32Array }>({
    positions: new Float32Array(0),
    colors: new Float32Array(0),
  });

  useLayoutEffect(() => {
    resources.material.resolution.set(viewportSize.width, viewportSize.height);
  }, [resources, viewportSize.height, viewportSize.width]);

  useLayoutEffect(() => {
    if (!enabled) {
      resources.line.visible = false;

      return;
    }
    const end = locateEpisodePoseTrajectory(pose, timeSeconds);
    if (!end) {
      resources.line.visible = false;
      return;
    }
    const endIndex = Math.max(0, end.completedPointCount - 1);

    // Time window with a bounding-box size floor — see `selectTrailStartIndex`.
    // Bounded by TACCAP_TRAIL_MAX_DURATION, so this is one pass over at most a
    // few hundred points, the same order as the copy loop below.
    const startIndex = selectTrailStartIndex({
      timestamps: pose.timestamps,
      positions: scenePositions,
      endIndex,
      timeSeconds,
      baseDuration: TACCAP_TRAIL_DURATION,
      maxDuration: TACCAP_TRAIL_MAX_DURATION,
      minSpan: Math.max(0, sceneExtent) * TACCAP_TRAIL_MIN_SPAN_FRACTION,
    });
    const completedPointCount = endIndex - startIndex + 1;
    const includeInterpolatedPoint =
      end.lowerIndex !== end.upperIndex && end.alpha > 0;
    const visiblePointCount =
      completedPointCount + Number(includeInterpolatedPoint);
    if (visiblePointCount < 2) {
      resources.line.visible = false;
      return;
    }

    const required = visiblePointCount * 3;
    if (scratch.current.positions.length < required) {
      scratch.current = {
        positions: new Float32Array(required),
        colors: new Float32Array(required),
      };
    }
    const positions = scratch.current.positions.subarray(0, required);
    const colors = scratch.current.colors.subarray(0, required);
    const windowSpan = Math.max(
      Number.EPSILON,
      timeSeconds - pose.timestamps[startIndex],
    );
    const solidSpan =
      windowSpan * (TACCAP_TRAIL_SOLID_COLOR_DURATION / TACCAP_TRAIL_DURATION);
    const gradientDuration = Math.max(Number.EPSILON, windowSpan - solidSpan);
    for (
      let pointIndex = 0;
      pointIndex < completedPointCount;
      pointIndex += 1
    ) {
      const sourceIndex = startIndex + pointIndex;
      const sourceOffset = sourceIndex * 3;
      const targetOffset = pointIndex * 3;
      positions[targetOffset] = scenePositions[sourceOffset];
      positions[targetOffset + 1] = scenePositions[sourceOffset + 1];
      positions[targetOffset + 2] = scenePositions[sourceOffset + 2];

      // Keep the tail in the trajectory's own hue: the older part brightens
      // from a visible same-colour tint, then the newest third stays at full
      // colour instead of immediately entering a fade. The ramp spans the
      // window actually drawn, so a stretched window fades across all of it
      // rather than bottoming out at the nominal 3 s mark.
      const sampleTime = pose.timestamps[sourceIndex] ?? timeSeconds;
      const age = Math.max(0, timeSeconds - sampleTime);
      const gradientProgress = Math.max(
        0,
        Math.min(1, (windowSpan - age) / gradientDuration),
      );
      const intensity =
        TACCAP_TRAIL_MIN_COLOR_INTENSITY +
        (1 - TACCAP_TRAIL_MIN_COLOR_INTENSITY) * gradientProgress;
      colors[targetOffset] = trailColor.r * intensity;
      colors[targetOffset + 1] = trailColor.g * intensity;
      colors[targetOffset + 2] = trailColor.b * intensity;
    }
    if (includeInterpolatedPoint) {
      const offset = completedPointCount * 3;
      const point = tacCapDatasetPointToScene(end.point);
      positions[offset] = point[0];
      positions[offset + 1] = point[1];
      positions[offset + 2] = point[2];
      colors[offset] = trailColor.r;
      colors[offset + 1] = trailColor.g;
      colors[offset + 2] = trailColor.b;
    }

    // The geometry is allocated at a capacity and only ever refilled, because
    // `WebGLRenderer` latches the instance count of an instanced geometry the
    // first time it draws it:
    //
    //   if (geometry._maxInstanceCount === undefined)
    //     geometry._maxInstanceCount = data.meshPerAttribute * data.count;
    //   ...
    //   const instanceCount = Math.min(geometry.instanceCount, maxInstanceCount);
    //
    // `_maxInstanceCount` is recomputed only on `dispose()`. A trail that was
    // first drawn holding two points is therefore clamped to **one segment**
    // for the rest of the episode, no matter how much `setPositions` raises
    // `instanceCount` — and the one segment that survives is the oldest pair
    // in the window, so the trail collapses to a dot that follows the gripper
    // a whole window behind. That is the "single lagging point" bug.
    //
    // Sizing in steps and setting `instanceCount` per frame keeps the latched
    // maximum at the capacity instead of at whatever the first frame held.
    // Writing through the interleaved buffers is also strictly cheaper than
    // the `setPositions` path this replaces: that call allocates a fresh
    // `InstancedInterleavedBuffer` every time, so the old code was never the
    // in-place update its comment claimed.
    if (visiblePointCount > resources.capacity) {
      const capacity =
        Math.ceil(visiblePointCount / TRAIL_CAPACITY_STEP) *
        TRAIL_CAPACITY_STEP;
      const geometry = new LineGeometry();
      geometry.setPositions(new Float32Array(capacity * 3));
      geometry.setColors(new Float32Array(capacity * 3));
      resources.line.geometry.dispose();
      resources.line.geometry = geometry;
      resources.capacity = capacity;
    }

    const geometry = resources.line.geometry as LineGeometry;
    const instanceStart = geometry.getAttribute(
      "instanceStart",
    ) as THREE.InterleavedBufferAttribute;
    const instanceColorStart = geometry.getAttribute(
      "instanceColorStart",
    ) as THREE.InterleavedBufferAttribute;
    const positionBuffer = instanceStart.data.array as Float32Array;
    const colorBuffer = instanceColorStart.data.array as Float32Array;
    // `instanceEnd` / `instanceColorEnd` are views onto these same buffers at
    // offset 3, so each segment is one contiguous [start xyz, end xyz] stride.
    const segmentCount = visiblePointCount - 1;
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const target = segment * 6;
      const from = segment * 3;
      const to = from + 3;
      positionBuffer[target] = positions[from];
      positionBuffer[target + 1] = positions[from + 1];
      positionBuffer[target + 2] = positions[from + 2];
      positionBuffer[target + 3] = positions[to];
      positionBuffer[target + 4] = positions[to + 1];
      positionBuffer[target + 5] = positions[to + 2];
      colorBuffer[target] = colors[from];
      colorBuffer[target + 1] = colors[from + 1];
      colorBuffer[target + 2] = colors[from + 2];
      colorBuffer[target + 3] = colors[to];
      colorBuffer[target + 4] = colors[to + 1];
      colorBuffer[target + 5] = colors[to + 2];
    }
    instanceStart.data.needsUpdate = true;
    instanceColorStart.data.needsUpdate = true;
    geometry.instanceCount = segmentCount;

    // No `computeLineDistances()`: it exists to feed the dash shader, which is
    // compiled out while `dashed` is false, and it allocates a pair of arrays
    // on every call.
    resources.line.visible = true;
  }, [
    enabled,
    pose,
    resources,
    sceneExtent,
    scenePositions,
    timeSeconds,
    trailColor,
  ]);

  useEffect(
    () => () => {
      resources.line.geometry.dispose();
      resources.material.dispose();
    },
    [resources],
  );

  return <primitive object={resources.line} />;
}

/**
 * Pico 4 Ultra Enterprise, the headset these datasets are recorded with.
 *
 * Built from Three.js primitives on purpose: 3D Replay must not depend on a
 * downloadable model, and Pico's own asset is not redistributable. The shape
 * carries the features that identify the device -- slim pancake front unit,
 * full-face black visor glass, the central colour-camera pair with the iToF
 * depth sensor between them, four peripheral tracking cameras, and the halo
 * strap with its rear battery counterweight.
 *
 * Local +X is the visor/front direction, +Y is left, and +Z is up.
 */
function TacCapHeadsetModel({ originRadius }: { originRadius: number }) {
  const {
    batteryX,
    gasketDepth,
    gasketHeight,
    gasketWidth,
    haloCenterX,
    haloRadius,
    haloTube,
    haloZ,
    visorDepth,
    visorHeight,
    visorWidth,
  } = TACCAP_HEADSET;
  const glassX = visorDepth / 2 + 0.003;

  return (
    <group>
      {/* White-grey front shell. */}
      <RoundedBox
        args={[visorDepth, visorWidth, visorHeight]}
        radius={0.015}
        smoothness={4}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color="#e2e8f0"
          metalness={0.08}
          roughness={0.45}
        />
      </RoundedBox>

      {/* Opaque black glass covering the whole face of the visor. */}
      <RoundedBox
        args={[0.012, visorWidth - 0.007, visorHeight - 0.007]}
        position={[glassX, 0, 0]}
        radius={0.005}
        smoothness={4}
        castShadow
      >
        <meshStandardMaterial
          color="#0b1120"
          metalness={0.65}
          roughness={0.08}
        />
      </RoundedBox>

      {/* Central array: two colour passthrough cameras with the iToF depth
          sensor between them. */}
      {([-1, 1] as const).map((side) => (
        <group
          key={`passthrough:${side}`}
          position={[glassX + 0.007, side * 0.035, 0.002]}
          rotation={[0, 0, -Math.PI / 2]}
        >
          <mesh castShadow>
            <cylinderGeometry args={[0.0135, 0.0135, 0.005, 24]} />
            <meshStandardMaterial
              color="#111827"
              metalness={0.5}
              roughness={0.25}
            />
          </mesh>
          <mesh position={[0, 0.003, 0]}>
            <cylinderGeometry args={[0.0085, 0.0085, 0.002, 24]} />
            <meshStandardMaterial
              color="#1e293b"
              emissive="#0c4a6e"
              emissiveIntensity={0.35}
              metalness={0.3}
              roughness={0.1}
            />
          </mesh>
        </group>
      ))}
      <group
        position={[glassX + 0.006, 0, 0.002]}
        rotation={[0, 0, -Math.PI / 2]}
      >
        <mesh castShadow>
          <cylinderGeometry args={[0.0085, 0.0085, 0.004, 20]} />
          <meshStandardMaterial
            color="#1f2937"
            metalness={0.45}
            roughness={0.3}
          />
        </mesh>
        <mesh position={[0, 0.0025, 0]}>
          <cylinderGeometry args={[0.005, 0.005, 0.002, 20]} />
          <meshStandardMaterial
            color="#450a0a"
            emissive="#7f1d1d"
            emissiveIntensity={0.3}
            roughness={0.2}
          />
        </mesh>
      </group>

      {/* Cooling vents above and below the central array. */}
      {([-1, 1] as const).map((side) => (
        <mesh key={`vent:${side}`} position={[glassX + 0.003, 0, side * 0.028]}>
          <boxGeometry args={[0.005, 0.088, 0.006]} />
          <meshStandardMaterial color="#1e293b" roughness={0.6} />
        </mesh>
      ))}

      {/* Four peripheral tracking cameras. */}
      {([-1, 1] as const).flatMap((ySide) =>
        ([-1, 1] as const).map((zSide) => (
          <mesh
            key={`tracking:${ySide}:${zSide}`}
            position={[
              glassX + 0.005,
              ySide * (visorWidth / 2 - 0.019),
              zSide * (visorHeight / 2 - 0.017),
            ]}
            rotation={[0, 0, -Math.PI / 2]}
          >
            <cylinderGeometry args={[0.0065, 0.0065, 0.003, 16]} />
            <meshStandardMaterial
              color="#0f172a"
              metalness={0.5}
              roughness={0.22}
            />
          </mesh>
        )),
      )}

      {/* Face gasket behind the shell, sized from the published 165 mm
          facebox. */}
      <RoundedBox
        args={[gasketDepth, gasketWidth, gasketHeight]}
        position={[-(visorDepth / 2 + gasketDepth / 2 - 0.006), 0, -0.002]}
        radius={0.012}
        smoothness={3}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#1f2937" roughness={0.92} />
      </RoundedBox>

      {/* Halo strap, open at the front so it clears the visor. */}
      <mesh
        position={[haloCenterX, 0, haloZ]}
        rotation={[0, 0, TACCAP_HALO_GAP_HALF]}
        castShadow
      >
        <torusGeometry
          args={[
            haloRadius,
            haloTube,
            12,
            64,
            Math.PI * 2 - TACCAP_HALO_GAP_HALF * 2,
          ]}
        />
        <meshStandardMaterial
          color="#cbd5e1"
          metalness={0.1}
          roughness={0.55}
        />
      </mesh>

      {/* Arms joining the visor to the halo ring. */}
      {([-1, 1] as const).map((side) => (
        <RoundedBox
          key={`halo-arm:${side}`}
          args={[0.052, 0.013, 0.017]}
          position={[-0.03, side * (visorWidth / 2 + 0.003), haloZ - 0.004]}
          radius={0.005}
          smoothness={3}
          castShadow
        >
          <meshStandardMaterial color="#cbd5e1" roughness={0.6} />
        </RoundedBox>
      ))}

      {/* Rear battery pack: the counterweight that balances the front unit. */}
      <RoundedBox
        args={[0.048, 0.112, 0.054]}
        position={[batteryX, 0, haloZ - 0.004]}
        radius={0.014}
        smoothness={4}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color="#e2e8f0"
          metalness={0.08}
          roughness={0.5}
        />
      </RoundedBox>
      <RoundedBox
        args={[0.014, 0.098, 0.046]}
        position={[batteryX + 0.03, 0, haloZ - 0.004]}
        radius={0.006}
        smoothness={3}
      >
        <meshStandardMaterial color="#334155" roughness={0.9} />
      </RoundedBox>

      {/* Preserve the exact sampled pose origin inside the schematic model. */}
      <mesh>
        <sphereGeometry args={[originRadius, 16, 12]} />
        <meshBasicMaterial color={TACCAP_HEAD_COLOR} toneMapped={false} />
      </mesh>
    </group>
  );
}

function TacCapHeadMarker({
  frame,
  size,
}: {
  frame: TacCapHeadFrame | null;
  size: number;
}) {
  const transform = useMemo(
    () =>
      frame
        ? new THREE.Matrix4().set(
            ...tacCapRecordedTcpSceneMatrix(frame.position, frame.rotation),
          )
        : null,
    [frame],
  );
  if (!transform) return null;

  const axisLength = Math.max(size, 0.04);
  return (
    <group matrix={transform} matrixAutoUpdate={false}>
      <TacCapHeadsetModel originRadius={size} />
      {TACCAP_LOCAL_POSE_AXES.map((axis) => (
        <TacCapAxisArrow
          key={axis.label}
          alwaysVisible
          length={axisLength}
          showLabel={false}
          {...axis}
        />
      ))}
    </group>
  );
}

export function TacCapReplayScene({
  frames,
  headFrame,
  headTrack,
  onReadyChange,
  timeSeconds,
  tracks,
  trailEnabled,
}: {
  frames: TacCapGripperFrame[];
  headFrame: TacCapHeadFrame | null;
  headTrack: TacCapHeadTrack | null;
  onReadyChange: (ready: boolean) => void;
  timeSeconds: number;
  tracks: TacCapGripperTrack[];
  trailEnabled: boolean;
}) {
  const [readySides, setReadySides] = useState<Set<TacCapSide>>(new Set());
  const bounds = useMemo(
    () => tacCapSceneBounds(tracks, headTrack),
    [headTrack, tracks],
  );
  const frameBySide = useMemo(
    () => new Map(frames.map((frame) => [frame.side, frame])),
    [frames],
  );
  const handleReady = useCallback((side: TacCapSide) => {
    setReadySides((current) => {
      if (current.has(side)) return current;
      const next = new Set(current);
      next.add(side);
      return next;
    });
  }, []);
  const modelSides = useMemo(
    () => ["left", "right"] as const satisfies readonly TacCapSide[],
    [],
  );

  useEffect(() => {
    onReadyChange(modelSides.every((side) => readySides.has(side)));
  }, [modelSides, onReadyChange, readySides]);

  const gridSize = bounds.extent * 1.5;
  const gridY = bounds.min.y - bounds.extent * 0.04;

  return (
    <>
      {modelSides.map((side) => (
        <TacCapGripperModel
          key={side}
          frame={frameBySide.get(side) ?? null}
          side={side}
          onReady={handleReady}
        />
      ))}
      {tracks.map((track) => (
        <TacCapPoseTrail
          key={`trail:${track.side}`}
          color={TACCAP_TRAIL_COLOR[track.side]}
          enabled={trailEnabled}
          pose={track.pose}
          sceneExtent={bounds.extent}
          timeSeconds={timeSeconds}
        />
      ))}
      {headTrack && (
        <TacCapPoseTrail
          alwaysVisible
          color={TACCAP_HEAD_COLOR}
          enabled={trailEnabled}
          pose={headTrack.pose}
          sceneExtent={bounds.extent}
          timeSeconds={timeSeconds}
        />
      )}
      <TacCapHeadMarker
        frame={headFrame}
        size={Math.max(0.006, Math.min(0.014, bounds.extent * 0.012))}
      />
      <Grid
        args={[gridSize, gridSize]}
        position={[bounds.center.x, gridY, bounds.center.z]}
        cellSize={Math.max(bounds.extent / 12, 0.02)}
        cellThickness={0.5}
        cellColor="#334155"
        sectionSize={Math.max(bounds.extent / 3, 0.1)}
        sectionThickness={1}
        sectionColor="#475569"
        fadeDistance={gridSize * 1.5}
      />
      <TacCapWorldAxes bounds={bounds} groundY={gridY} />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[bounds.center.x, gridY + 0.001, bounds.center.z]}
        receiveShadow
      >
        <planeGeometry args={[gridSize, gridSize]} />
        <shadowMaterial opacity={0.28} />
      </mesh>
      <TacCapCameraFit bounds={bounds} />
    </>
  );
}

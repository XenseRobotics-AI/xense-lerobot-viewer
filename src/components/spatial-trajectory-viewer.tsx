"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, Line, OrbitControls } from "@react-three/drei";
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
import {
  spatialLayerFeatureKey,
  type SpatialTrajectoryData,
  type SpatialTrajectoryLayer,
} from "@/utils/spatialTrajectories";

const LAYER_COLORS = ["#22d3ee", "#f472b6", "#34d399", "#fbbf24"];

function layerColor(layer: SpatialTrajectoryLayer): string {
  const lower = layer.label.toLowerCase();
  if (lower.includes("left")) return LAYER_COLORS[0];
  if (lower.includes("right")) return LAYER_COLORS[1];
  let hash = 0;
  for (const char of layer.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return LAYER_COLORS[Math.abs(hash) % LAYER_COLORS.length];
}

function episodeColor(episodeIndex: number, layerLabel?: string): string {
  const color = new THREE.Color();
  const hue = (((episodeIndex * 0.61803398875) % 1) + 1) % 1;
  const isRight = layerLabel?.toLowerCase().includes("right") ?? false;
  color.setHSL(hue, 0.82, isRight ? 0.58 : 0.54);
  return `#${color.getHexString()}`;
}

type HoveredEpisode = {
  episodeIndex: number;
  layerLabel: string;
  /** Dataset feature the hovered layer came from, e.g. `action`. */
  featureKey: string;
};

function computeBounds(layers: SpatialTrajectoryLayer[]): SceneBounds {
  return sceneBoundsFromPointArrays(
    layers.flatMap((layer) =>
      layer.trajectories.map((trajectory) => trajectory.points),
    ),
  );
}

function EpisodeTrajectoryLine({
  trajectory,
  layer,
  highlighted,
  onHover,
  onSelect,
}: {
  trajectory: SpatialTrajectoryLayer["trajectories"][number];
  layer: SpatialTrajectoryLayer;
  highlighted: boolean;
  onHover: (
    episodeIndex: number | null,
    layer?: SpatialTrajectoryLayer,
  ) => void;
  onSelect: (episodeIndex: number) => void;
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

  if (points.length < 2) return null;

  const color = episodeColor(trajectory.episodeIndex, layer.label);
  // A focused Episode is brighter, while every other Episode keeps its normal
  // opacity. Previously dimming the other paths made the prior selection look
  // as if it had disappeared after clicking a different Episode.
  const opacity = highlighted ? 0.98 : 0.28;
  const lineWidth = highlighted ? 3.5 : 1.1;

  return (
    <Line
      points={points}
      color={color}
      lineWidth={lineWidth}
      transparent
      opacity={opacity}
      depthWrite={false}
      onPointerOver={(event) => {
        event.stopPropagation();
        onHover(trajectory.episodeIndex, layer);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onHover(null);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(trajectory.episodeIndex);
      }}
    />
  );
}

function TrajectoryLines({
  layer,
  focusedEpisode,
  hoveredEpisode,
  onHover,
  onSelect,
}: {
  layer: SpatialTrajectoryLayer;
  focusedEpisode: number | null;
  hoveredEpisode: HoveredEpisode | null;
  onHover: (
    episodeIndex: number | null,
    layer?: SpatialTrajectoryLayer,
  ) => void;
  onSelect: (episodeIndex: number) => void;
}) {
  // Hovering temporarily takes precedence over the selected episode. This
  // makes it possible to inspect a nearby line without losing the selection.
  const emphasizedEpisode = hoveredEpisode?.episodeIndex ?? focusedEpisode;

  return (
    <group>
      {layer.trajectories.map((trajectory) => {
        const isEpisodeEmphasized =
          emphasizedEpisode === trajectory.episodeIndex;

        return (
          <EpisodeTrajectoryLine
            key={`${layer.id}:${trajectory.episodeIndex}`}
            trajectory={trajectory}
            layer={layer}
            highlighted={isEpisodeEmphasized}
            onHover={onHover}
            onSelect={onSelect}
          />
        );
      })}
    </group>
  );
}

function TrajectoryScene({
  layers,
  focusedEpisode,
  hoveredEpisode,
  onHover,
  onSelect,
}: {
  layers: SpatialTrajectoryLayer[];
  focusedEpisode: number | null;
  hoveredEpisode: HoveredEpisode | null;
  onHover: (
    episodeIndex: number | null,
    layer?: SpatialTrajectoryLayer,
  ) => void;
  onSelect: (episodeIndex: number) => void;
}) {
  const controlsRef = useRef<ControlsHandle | null>(null);
  const bounds = useMemo(() => computeBounds(layers), [layers]);
  const gridSize = bounds.extent * 1.4;

  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ position: [1, 1, 1], fov: 45, near: 0.001, far: 100 }}
      gl={{ antialias: true, alpha: false }}
    >
      <color attach="background" args={["#111827"]} />
      {layers.map((layer) => (
        <TrajectoryLines
          key={layer.id}
          layer={layer}
          focusedEpisode={focusedEpisode}
          hoveredEpisode={hoveredEpisode}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}
      <Grid
        args={[gridSize, gridSize]}
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
        fadeDistance={gridSize * 1.5}
        infiniteGrid
      />
      <AxisGuide bounds={bounds} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
      />
      <CameraFit bounds={bounds} controlsRef={controlsRef} />
    </Canvas>
  );
}

export default function SpatialTrajectoryViewer({
  data,
  loading,
  fullscreen = false,
}: {
  data: SpatialTrajectoryData | null | undefined;
  loading: boolean;
  fullscreen?: boolean;
}) {
  const t = useT();
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [focusedEpisode, setFocusedEpisode] = useState<number | null>(null);
  const [hoveredEpisode, setHoveredEpisode] = useState<HoveredEpisode | null>(
    null,
  );

  useEffect(() => {
    setVisibleIds(new Set(data?.layers.map((layer) => layer.id) ?? []));
    setFocusedEpisode(null);
    setHoveredEpisode(null);
  }, [data]);

  const visibleLayers = useMemo(
    () => data?.layers.filter((layer) => visibleIds.has(layer.id)) ?? [],
    [data, visibleIds],
  );
  const coverage = useMemo(() => {
    const episodes = new Set<number>();
    let points = 0;
    for (const layer of visibleLayers) {
      for (const trajectory of layer.trajectories) {
        episodes.add(trajectory.episodeIndex);
        points += trajectory.points.length / 3;
      }
    }
    return { episodes: episodes.size, points };
  }, [visibleLayers]);
  const episodeIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const layer of visibleLayers) {
      for (const trajectory of layer.trajectories) {
        indices.add(trajectory.episodeIndex);
      }
    }
    return [...indices].sort((a, b) => a - b);
  }, [visibleLayers]);

  useEffect(() => {
    if (focusedEpisode !== null && !episodeIndices.includes(focusedEpisode)) {
      setFocusedEpisode(null);
    }
  }, [episodeIndices, focusedEpisode]);

  const toggleLayer = (id: string) => {
    setVisibleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The legend lists Episodes, not layers, so its swatches follow the first
  // visible layer — the one `handleHover` also reports. `episodeColor` varies
  // lightness per layer, so passing nothing here would paint a swatch that
  // does not match the line it selects.
  const legendLayerLabel = visibleLayers[0]?.label;

  const handleHover = (
    episodeIndex: number | null,
    layer?: SpatialTrajectoryLayer,
  ) => {
    if (episodeIndex === null || !layer) {
      setHoveredEpisode(null);
      return;
    }
    setHoveredEpisode({
      episodeIndex,
      layerLabel: layer.label,
      featureKey: spatialLayerFeatureKey(layer.id),
    });
  };

  const toggleEpisodeFocus = (episodeIndex: number) => {
    setFocusedEpisode((current) =>
      current === episodeIndex ? null : episodeIndex,
    );
  };
  const episodeLabel = (episodeIndex: number) =>
    t("insights.trajEpisodeLabel", { episode: episodeIndex });

  return (
    <div className="bg-[var(--surface-1)]/60 rounded-lg p-5 border border-white/10 space-y-4">
      <div className="pr-10">
        <h3 className="text-sm font-semibold text-slate-200">
          {t("insights.trajTitle")}
        </h3>
        <p className="mt-1 text-xs text-slate-400">{t("insights.trajDesc")}</p>
      </div>

      {loading && !data ? (
        <div className="h-72 rounded-md border border-white/10 bg-slate-950/30 flex items-center justify-center text-sm text-slate-400 animate-pulse">
          {t("insights.trajLoading")}
        </div>
      ) : !data || data.layers.length === 0 ? (
        <div className="h-40 rounded-md border border-white/10 bg-slate-950/30 flex items-center justify-center text-sm text-slate-500">
          {t("insights.trajNoData")}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {data.layers.map((layer) => {
                const active = visibleIds.has(layer.id);
                return (
                  <button
                    key={layer.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleLayer(layer.id)}
                    className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? "border-white/20 bg-white/10 text-slate-200"
                        : "border-white/5 bg-transparent text-slate-600"
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        backgroundColor: layerColor(layer),
                        opacity: active ? 1 : 0.3,
                      }}
                    />
                    {spatialLayerFeatureKey(layer.id)} · {layer.label}
                  </button>
                );
              })}
            </div>
            <div className="text-right text-[11px] leading-5 text-slate-500 tabular-nums">
              <p>
                {t("insights.trajCoverage", {
                  loaded: coverage.episodes,
                  total: data.totalEpisodes,
                })}
              </p>
              <p>{t("insights.trajPointCount", { count: coverage.points })}</p>
            </div>
          </div>

          <div
            className="flex min-h-9 items-center gap-2 rounded-md border border-white/10 bg-slate-950/30 px-3 py-2 text-xs"
            aria-live="polite"
          >
            {hoveredEpisode ? (
              <>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: episodeColor(
                      hoveredEpisode.episodeIndex,
                      hoveredEpisode.layerLabel,
                    ),
                  }}
                />
                <span className="font-medium text-slate-100">
                  {t("insights.trajHoveredStatus", {
                    episode: hoveredEpisode.episodeIndex,
                    feature: hoveredEpisode.featureKey,
                    layer: hoveredEpisode.layerLabel,
                  })}
                </span>
              </>
            ) : focusedEpisode !== null ? (
              <>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: episodeColor(
                      focusedEpisode,
                      legendLayerLabel,
                    ),
                  }}
                />
                <span className="font-medium text-slate-200">
                  {t("insights.trajFocusedStatus", {
                    episode: focusedEpisode,
                  })}
                </span>
              </>
            ) : (
              <span className="text-slate-500">
                {t("insights.trajHoverPrompt")}
              </span>
            )}
          </div>

          {visibleLayers.length === 0 ? (
            <div className="h-40 rounded-md border border-white/10 bg-slate-950/30 flex items-center justify-center text-sm text-slate-500">
              {t("insights.trajSelectLayer")}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-white/10 bg-slate-900">
              <div
                className={`grid min-h-0 ${
                  fullscreen
                    ? "h-[calc(100vh-13rem)] min-h-[520px] grid-cols-[minmax(0,1fr)_220px]"
                    : "h-[520px] grid-cols-[minmax(0,1fr)_190px]"
                }`}
              >
                <div className="min-w-0 border-r border-white/10">
                  <TrajectoryScene
                    layers={visibleLayers}
                    focusedEpisode={focusedEpisode}
                    hoveredEpisode={hoveredEpisode}
                    onHover={handleHover}
                    onSelect={toggleEpisodeFocus}
                  />
                </div>
                <aside className="flex min-h-0 flex-col bg-slate-950/45">
                  <div className="border-b border-white/10 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                        {t("insights.trajEpisodeLegend")}
                      </p>
                      {focusedEpisode !== null && (
                        <button
                          type="button"
                          onClick={() => setFocusedEpisode(null)}
                          className="text-[10px] text-cyan-400 transition-colors hover:text-cyan-300"
                        >
                          {t("insights.trajShowAll")}
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-slate-500">
                      {t("insights.trajEpisodeLegendHint")}
                    </p>
                    <select
                      aria-label={t("insights.trajEpisodeSelectAria")}
                      value={focusedEpisode ?? ""}
                      onChange={(event) => {
                        setHoveredEpisode(null);
                        setFocusedEpisode(
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                        );
                      }}
                      className="mt-2 w-full rounded border border-white/10 bg-slate-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none transition-colors focus:border-cyan-500/60"
                    >
                      <option value="">
                        {t("insights.trajAllEpisodesOption", {
                          count: episodeIndices.length,
                        })}
                      </option>
                      {episodeIndices.map((episodeIndex) => (
                        <option key={episodeIndex} value={episodeIndex}>
                          {episodeLabel(episodeIndex)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    <div className="grid grid-cols-1 gap-1">
                      {episodeIndices.map((episodeIndex) => {
                        const active = focusedEpisode === episodeIndex;
                        const hovered =
                          hoveredEpisode?.episodeIndex === episodeIndex;
                        return (
                          <button
                            key={episodeIndex}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleEpisodeFocus(episodeIndex)}
                            onPointerEnter={() =>
                              handleHover(episodeIndex, visibleLayers[0])
                            }
                            onPointerLeave={() => setHoveredEpisode(null)}
                            className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] tabular-nums transition-colors ${
                              active
                                ? "bg-white/15 text-white ring-1 ring-white/25"
                                : hovered
                                  ? "bg-white/10 text-slate-100"
                                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                            }`}
                            title={t("insights.trajEpisodeButtonTitle", {
                              episode: episodeIndex,
                            })}
                          >
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{
                                backgroundColor: episodeColor(
                                  episodeIndex,
                                  legendLayerLabel,
                                ),
                              }}
                            />
                            ep {episodeIndex}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>{t("insights.trajControls")}</span>
            <span>{t("insights.trajCoordinate")}</span>
          </div>
        </>
      )}
    </div>
  );
}

"use client";

import {
  type CSSProperties,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { TacCapReplayScene } from "@/components/taccap-replay-scene";
import UrdfVideoOverlay from "@/components/urdf-video-overlay";
import * as THREE from "three";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  FiChevronLeft,
  FiChevronRight,
  FiPause,
  FiPlay,
  FiX,
} from "react-icons/fi";
import { formatBytes } from "@/utils/byteSize";
import {
  WORKBENCH_DISPLAY_DETAIL_PAGE_DURATION_MS,
  WORKBENCH_DISPLAY_PERSONNEL_PAGE_DURATION_MS,
  WORKBENCH_DISPLAY_HEATMAP_WINDOW_DURATION_MS,
  getWorkbenchDisplaySlides,
  createWorkbenchDisplayClock,
  getWorkbenchDetailPage,
  getWorkbenchPersonnelPage,
  getWorkbenchDisplayClockRemaining,
  getWorkbenchDisplaySlideIndex,
  getWorkbenchHeatmapWindow,
  getWorkbenchDisplayDailyTargetHours,
  getWorkbenchDisplayRewardTone,
  getWorkbenchOverviewActiveCardIndex,
  pauseWorkbenchDisplayClock,
  resumeWorkbenchDisplayClock,
  type WorkbenchDisplayClock,
  type WorkbenchDisplaySnapshot,
  type WorkbenchDisplaySlideId,
  type WorkbenchDisplayRewardTone,
} from "@/components/workbench-display-utils";
import {
  extractTacCapGripperTracks,
  sampleTacCapGripperFrame,
} from "@/utils/taccapGripperReplay";
import styles from "@/components/workbench-display.module.css";
import { formatWorkbenchRewardAmount } from "@/utils/workbenchRewards";
import WorkbenchRuleBadge from "@/components/workbench-rule-badge";

type WorkbenchDisplayProps = {
  snapshot: WorkbenchDisplaySnapshot;
  onExit: () => void;
};

type DelayStyle = CSSProperties & { "--display-delay": string };
type BarStyle = CSSProperties & {
  "--display-delay": string;
  "--display-bar-width": string;
};

function formatHours(value: number): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} h`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatReward(value: number): string {
  return formatWorkbenchRewardAmount(value);
}

function rewardSymbol(value: number): "✅" | "❌" | "—" {
  if (value > 0) return "✅";
  if (value < 0) return "❌";
  return "—";
}

function rewardToneClass(tone: WorkbenchDisplayRewardTone): string {
  if (tone === "positive") return styles.rewardPositive;
  if (tone === "negative") return styles.rewardNegative;
  return styles.rewardNeutral;
}

function formatRange(snapshot: WorkbenchDisplaySnapshot): string {
  const { startDate, endDate } = snapshot.dateRange;
  if (!startDate && !endDate) return "No date range available";
  return `${startDate ?? "Beginning"} → ${endDate ?? "Latest"}`;
}

function formatCapturedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function EmptySlide({
  range,
  children,
}: {
  range: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyGlyph} aria-hidden="true">
        00
      </div>
      <p className={styles.emptyTitle}>{children}</p>
      <p className={styles.emptyRange}>{range}</p>
    </div>
  );
}

function SummaryHeader({ snapshot }: { snapshot: WorkbenchDisplaySnapshot }) {
  const cards = [
    ["Selected range hours", formatHours(snapshot.summary.selectedRangeHours)],
    ["Total bonus", formatReward(snapshot.summary.totalBonus)],
  ] as const;
  const bonusToneClass = rewardToneClass(
    getWorkbenchDisplayRewardTone(snapshot.summary.totalBonus),
  );

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <div className={styles.eyebrow}>Workbench · Live operations</div>
        <div className={styles.organization} title={snapshot.organization}>
          {snapshot.organization}
        </div>
        <div className={styles.contextLine}>
          <span>{formatRange(snapshot)}</span>
          <span className={styles.contextDivider} aria-hidden="true" />
          <span>Snapshot {formatCapturedAt(snapshot.capturedAt)}</span>
        </div>
      </div>
      <div className={styles.summaryGrid}>
        {cards.map(([label, value]) => (
          <div
            className={[
              styles.summaryCard,
              label === "Total bonus" ? bonusToneClass : "",
            ].join(" ")}
            key={label}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </header>
  );
}

function SlideHeading({
  index,
  title,
  meta,
  total,
}: {
  index: number;
  title: string;
  meta: string;
  total: number;
}) {
  return (
    <div className={styles.slideHeading}>
      <div>
        <span className={styles.chapterNumber}>
          {String(index + 1).padStart(2, "0")} /{" "}
          {String(total).padStart(2, "0")}
        </span>
        <h2>{title}</h2>
      </div>
      <div className={styles.slideMeta}>{meta}</div>
    </div>
  );
}

function OverviewSlide({
  snapshot,
  elapsedMs,
  reducedMotion,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  elapsedMs: number;
  reducedMotion: boolean;
  total: number;
}) {
  const metrics = [
    [
      "Organization total hours",
      formatHours(snapshot.summary.organizationTotalHours),
    ],
    ["Selected range hours", formatHours(snapshot.summary.selectedRangeHours)],
    ["Episodes", formatCount(snapshot.summary.episodes)],
    ["Tasks", formatCount(snapshot.summary.tasks)],
    ["Storage", formatBytes(snapshot.summary.storageBytes)],
    [
      "Daily target hours",
      `${formatHours(snapshot.summary.dailyTargetHours)} / day`,
    ],
    ["Total bonus", formatReward(snapshot.summary.totalBonus)],
    ["Sources", formatCount(snapshot.summary.robotIds)],
    [
      "Days in range",
      snapshot.summary.daysInRange === null
        ? "—"
        : formatCount(snapshot.summary.daysInRange),
    ],
  ] as const;
  const activeCardIndex = getWorkbenchOverviewActiveCardIndex(
    elapsedMs,
    reducedMotion,
  );
  const bonusToneClass = rewardToneClass(
    getWorkbenchDisplayRewardTone(snapshot.summary.totalBonus),
  );

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={0}
        total={total}
        title="Overview"
        meta="Selected range snapshot"
      />
      <div className={styles.overviewFrame}>
        <div className={styles.overviewGrid}>
          {metrics.map(([label, value], index) => (
            <div
              className={[
                styles.overviewCard,
                index < 2 ? styles.overviewCardFeatured : "",
                activeCardIndex === null
                  ? ""
                  : index === activeCardIndex
                    ? styles.overviewCardActive
                    : styles.overviewCardDimmed,
                label === "Total bonus" ? bonusToneClass : "",
              ].join(" ")}
              data-focused={index === activeCardIndex || undefined}
              key={label}
            >
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        {snapshot.unattributedHours > 0 && (
          <div className={styles.overviewNote}>
            {formatHours(snapshot.unattributedHours)} of workstation hours are
            not assigned to personnel.
          </div>
        )}
      </div>
    </section>
  );
}

function WorkstationDetailSlide({
  snapshot,
  elapsedMs,
  pageCursor,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  elapsedMs: number;
  pageCursor: number;
  total: number;
}) {
  const elapsedPage = Math.floor(
    elapsedMs / WORKBENCH_DISPLAY_DETAIL_PAGE_DURATION_MS,
  );
  const page = getWorkbenchDetailPage(
    snapshot.workstations,
    pageCursor + elapsedPage,
  );

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={1}
        total={total}
        title="Workstation detail"
        meta={
          snapshot.workstations.length === 0
            ? "No workstation rows"
            : `Page ${page.pageIndex + 1} / ${page.pageCount} · ${snapshot.workstations.length} workstations`
        }
      />
      {page.items.length === 0 ? (
        <EmptySlide range={formatRange(snapshot)}>
          No workstation additions in this range
        </EmptySlide>
      ) : (
        <div className={styles.tableFrame}>
          <table className={styles.detailTable}>
            <thead>
              <tr>
                <th>Workstation</th>
                <th>Personnel</th>
                <th>Source repos</th>
                <th>Datasets</th>
                <th title="Workstation Hours">WS hours</th>
                <th>Target</th>
                <th>Rate</th>
                <th>Rule</th>
                <th>Reward</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((row, index) => {
                const rateTone =
                  row.ratePercent === null
                    ? styles.toneNeutral
                    : row.ratePercent >= 100
                      ? styles.toneSuccess
                      : styles.toneAttention;
                return (
                  <tr
                    key={`${page.pageIndex}-${row.sourceLabel ?? row.robotId}-${row.workstation}`}
                    className={styles.revealRow}
                    style={
                      {
                        "--display-delay": `${index * 70}ms`,
                      } as DelayStyle
                    }
                  >
                    <td
                      className={`${styles.primaryCell} ${styles.workstationCell}`}
                      title={`Robot ID: ${row.robotId}`}
                    >
                      {row.workstation}
                    </td>
                    <td title={row.personnel}>{row.personnel}</td>
                    <td
                      className={styles.sourceRepoCell}
                      title={row.sourceRepoIds.join(", ")}
                    >
                      {row.sourceRepoIds.length > 0
                        ? row.sourceRepoIds.join(", ")
                        : "—"}
                    </td>
                    <td>{formatCount(row.datasets)}</td>
                    <td className={styles.hoursCell}>
                      {formatHours(row.hours)}
                    </td>
                    <td>
                      {row.targetHours === null
                        ? "—"
                        : formatHours(row.targetHours)}
                    </td>
                    <td className={rateTone}>{formatRate(row.ratePercent)}</td>
                    <td>
                      <WorkbenchRuleBadge
                        label={row.rule}
                        symbol={row.ruleSymbol ?? rewardSymbol(row.reward)}
                      />
                    </td>
                    <td
                      className={
                        row.reward > 0
                          ? styles.toneSuccess
                          : row.reward < 0
                            ? styles.toneAttention
                            : styles.toneNeutral
                      }
                    >
                      {formatReward(row.reward)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PersonnelWorkloadSlide({
  snapshot,
  elapsedMs,
  pageCursor,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  elapsedMs: number;
  pageCursor: number;
  total: number;
}) {
  const elapsedPage = Math.floor(
    elapsedMs / WORKBENCH_DISPLAY_PERSONNEL_PAGE_DURATION_MS,
  );
  const page = getWorkbenchPersonnelPage(
    snapshot.personnelRows,
    pageCursor + elapsedPage,
  );

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={2}
        total={total}
        title="Personnel workload"
        meta={
          snapshot.personnelRows.length === 0
            ? "No personnel rows"
            : `Page ${page.pageIndex + 1} / ${page.pageCount} · ${snapshot.personnelRows.length} personnel`
        }
      />
      {page.items.length === 0 ? (
        <EmptySlide range={formatRange(snapshot)}>
          No personnel workload in this range
        </EmptySlide>
      ) : (
        <div className={styles.tableFrame}>
          <table className={styles.personnelTable}>
            <thead>
              <tr>
                <th>Personnel</th>
                <th>Workstation</th>
                <th title="Per-person hours">Avg hours</th>
                <th title="Per-person target hours">Avg target</th>
                <th>Rate</th>
                <th>Rule</th>
                <th>Reward</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((row, index) => {
                const rateTone =
                  row.ratePercent === null
                    ? styles.toneNeutral
                    : row.ratePercent >= 100
                      ? styles.toneSuccess
                      : styles.toneAttention;
                return (
                  <tr
                    key={`${page.pageIndex}-${row.personnel}-${row.email}`}
                    className={styles.revealRow}
                    style={
                      {
                        "--display-delay": `${index * 70}ms`,
                      } as DelayStyle
                    }
                  >
                    <td className={styles.primaryCell}>{row.personnel}</td>
                    <td>{row.workstation || "—"}</td>
                    <td className={styles.hoursCell}>
                      {formatHours(row.hours)}
                    </td>
                    <td>{formatHours(row.targetHours)}</td>
                    <td className={rateTone}>{formatRate(row.ratePercent)}</td>
                    <td>
                      <WorkbenchRuleBadge
                        label={row.rule}
                        symbol={row.ruleSymbol ?? rewardSymbol(row.reward)}
                      />
                    </td>
                    <td
                      className={
                        row.reward > 0
                          ? styles.toneSuccess
                          : row.reward < 0
                            ? styles.toneAttention
                            : styles.toneNeutral
                      }
                    >
                      {formatReward(row.reward)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>Personnel bonus total</td>
                <td className={styles.toneSuccess}>
                  {formatReward(snapshot.personnelBonusTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function WorkstationHeatmapSlide({
  snapshot,
  elapsedMs,
  windowCursor,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  elapsedMs: number;
  windowCursor: number;
  total: number;
}) {
  const elapsedWindow = Math.floor(
    elapsedMs / WORKBENCH_DISPLAY_HEATMAP_WINDOW_DURATION_MS,
  );
  const windowPage = getWorkbenchHeatmapWindow(
    snapshot.heatmapDays,
    windowCursor + elapsedWindow,
  );
  const maxHours = Math.max(
    1,
    ...snapshot.heatmapRows.flatMap((row) =>
      windowPage.items.map((day) => row.hoursByDay[day] ?? 0),
    ),
  );

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={3}
        total={total}
        title="Workstation day heatmap"
        meta={
          snapshot.heatmapDays.length === 0
            ? "No daily additions since 2026-08-22"
            : `2026-08-22 → ${snapshot.dateRange.endDate ?? "Latest"} · Window ${windowPage.pageIndex + 1} / ${windowPage.pageCount} · Top ${snapshot.heatmapRows.length}`
        }
      />
      {windowPage.items.length === 0 || snapshot.heatmapRows.length === 0 ? (
        <EmptySlide range={formatRange(snapshot)}>
          No workstation day data in this range
        </EmptySlide>
      ) : (
        <div
          className={styles.heatmap}
          style={{
            gridTemplateColumns: `minmax(11rem, 1.6fr) repeat(${windowPage.items.length}, minmax(0, 1fr))`,
          }}
        >
          <div className={styles.heatmapCorner}>Workstation</div>
          {windowPage.items.map((day, dayIndex) => (
            <div
              key={day}
              className={`${styles.heatmapDay} ${styles.revealColumn}`}
              style={
                {
                  "--display-delay": `${dayIndex * 55}ms`,
                } as DelayStyle
              }
              title={day}
            >
              <span>{day.slice(5)}</span>
              <small>{day.slice(0, 4)}</small>
            </div>
          ))}
          {snapshot.heatmapRows.map((row) => (
            <div className={styles.heatmapContents} key={row.workstation}>
              <div className={styles.heatmapLabel}>
                <strong title={row.workstation}>{row.workstation}</strong>
              </div>
              {windowPage.items.map((day, dayIndex) => {
                const hours = row.hoursByDay[day] ?? 0;
                const achieved =
                  snapshot.dailyTargetHours > 0 &&
                  hours >= snapshot.dailyTargetHours;
                const alpha =
                  hours <= 0
                    ? 0
                    : Math.min(0.84, 0.2 + (hours / maxHours) * 0.64);
                return (
                  <div
                    key={`${row.workstation}-${day}`}
                    className={`${styles.heatmapCell} ${styles.revealColumn} ${
                      achieved ? styles.heatmapSuccess : ""
                    }`}
                    style={
                      {
                        "--display-delay": `${dayIndex * 55}ms`,
                        backgroundColor: achieved
                          ? `rgba(52, 211, 153, ${Math.max(alpha, 0.32)})`
                          : hours > 0
                            ? `rgba(34, 211, 238, ${alpha})`
                            : undefined,
                      } as DelayStyle
                    }
                    title={`${row.workstation} · ${day} · ${formatHours(hours)}`}
                  >
                    {hours > 0 ? hours.toFixed(1) : "—"}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const DailyTrendSlide = memo(function DailyTrendSlide({
  snapshot,
  reducedMotion,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  reducedMotion: boolean;
  total: number;
}) {
  const chartRows = snapshot.trend.map((row) => ({
    ...row,
    label: row.day.slice(5),
  }));
  const peakHours = Math.max(0, ...snapshot.trend.map((row) => row.hours));
  const dailyTargetHours = getWorkbenchDisplayDailyTargetHours(
    snapshot.dailyTargetHours,
    snapshot.workstations.length,
  );

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={4}
        total={total}
        title="Daily trend"
        meta={`2026-07-01 → ${snapshot.dateRange.endDate ?? "Latest"} · ${snapshot.trend.length} reporting day${snapshot.trend.length === 1 ? "" : "s"}`}
      />
      {chartRows.length === 0 ? (
        <EmptySlide range={formatRange(snapshot)}>
          No daily trend data in this range
        </EmptySlide>
      ) : (
        <div className={styles.trendLayout}>
          <div className={styles.chartFrame}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartRows}
                margin={{ top: 18, right: 22, bottom: 10, left: 4 }}
              >
                <CartesianGrid
                  vertical={false}
                  stroke="rgba(148, 163, 184, 0.13)"
                  strokeDasharray="4 6"
                />
                <XAxis
                  dataKey="label"
                  minTickGap={34}
                  tick={{ fill: "#87919f", fontSize: 14 }}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(148, 163, 184, 0.18)" }}
                />
                <YAxis
                  width={58}
                  tick={{ fill: "#87919f", fontSize: 14 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) => `${value}h`}
                />
                <Tooltip
                  cursor={{ stroke: "rgba(34, 211, 238, 0.28)" }}
                  contentStyle={{
                    background: "#171b20",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    color: "#f1f5f9",
                    fontSize: 14,
                  }}
                  formatter={(value) => [
                    formatHours(Number(value ?? 0)),
                    "Daily hours",
                  ]}
                  labelFormatter={(_, payload) =>
                    String(payload[0]?.payload?.day ?? "")
                  }
                />
                {dailyTargetHours > 0 && (
                  <ReferenceLine
                    y={dailyTargetHours}
                    stroke="#fbbf24"
                    strokeDasharray="8 7"
                    strokeWidth={1.5}
                    label={{
                      value: "Daily target " + formatHours(dailyTargetHours),
                      fill: "#fbbf24",
                      fontSize: 13,
                      position: "insideTopRight",
                    }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="hours"
                  stroke="#22d3ee"
                  strokeWidth={4}
                  dot={{ r: 4, fill: "#171b20", strokeWidth: 3 }}
                  activeDot={{ r: 7, fill: "#22d3ee" }}
                  isAnimationActive={!reducedMotion}
                  animationDuration={1_500}
                  animationEasing="ease-out"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <aside className={styles.trendMetrics}>
            <div className={styles.largeMetric}>
              <span>Cumulative hours</span>
              <strong>
                {formatHours(snapshot.summary.selectedRangeHours)}
              </strong>
              <small>Selected reporting range</small>
            </div>
            <div className={styles.smallMetrics}>
              <div>
                <span>
                  Daily target · {formatCount(snapshot.workstations.length)}{" "}
                  groups
                </span>
                <strong>{formatHours(dailyTargetHours)}</strong>
              </div>
              <div>
                <span>Peak day</span>
                <strong>{formatHours(peakHours)}</strong>
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
});

const ignoreTacCapModelReady = () => undefined;

function TacCapReplaySlide({
  snapshot,
  elapsedMs,
  paused,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  elapsedMs: number;
  paused: boolean;
  total: number;
}) {
  const replay = snapshot.replay;
  const chartRows = useMemo(
    () => (replay ? Array.from(replay.chartRows) : []),
    [replay],
  );
  const tracks = useMemo(
    () => extractTacCapGripperTracks(chartRows),
    [chartRows],
  );
  const frames = useMemo(
    () =>
      tracks.flatMap((track) => {
        const sampled = sampleTacCapGripperFrame(
          track,
          replay
            ? replay.randomStartSeconds +
                Math.min(
                  replay.windowDurationSeconds,
                  Math.max(0, elapsedMs / 1_000),
                )
            : 0,
        );
        return sampled ? [sampled] : [];
      }),
    [elapsedMs, replay, tracks],
  );
  if (!replay) return null;

  const localTimeSeconds = Math.min(
    replay.windowDurationSeconds,
    Math.max(0, elapsedMs / 1_000),
  );
  const episodeTimeSeconds = replay.randomStartSeconds + localTimeSeconds;
  const issues = [
    ...replay.missingVideoStreams.map((side) => `${side} video streams`),
    ...replay.missingTrajectories.map((side) => `${side} TCP trajectory`),
  ];

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={6}
        total={total}
        title="3D Replay"
        meta={`Episode ${replay.episodeId} · ${replay.fps || 30} FPS · ${replay.windowDurationSeconds.toFixed(1)}s window`}
      />
      <div className={styles.replayFrame}>
        <Canvas
          className={styles.replayCanvas}
          shadows
          frameloop="always"
          camera={{
            position: [0.65, 0.45, 0.65],
            fov: 45,
            near: 0.001,
            far: 100,
          }}
          gl={{
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 0.9,
          }}
        >
          <color attach="background" args={["#1a2433"]} />
          <ambientLight intensity={0.12} />
          <directionalLight
            color="#fff2e3"
            position={[3, 5, 3]}
            intensity={1}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-camera-near={0.1}
            shadow-camera-far={15}
            shadow-camera-left={-3}
            shadow-camera-right={3}
            shadow-camera-top={3}
            shadow-camera-bottom={-3}
            shadow-bias={-0.0005}
          />
          <directionalLight
            color="#bfd9ff"
            position={[-4, 2, -2]}
            intensity={0.25}
          />
          <directionalLight
            color="#ffffff"
            position={[0, 3, -4]}
            intensity={0.4}
          />
          <TacCapReplayScene
            frames={frames}
            headFrame={null}
            headTrack={null}
            onReadyChange={ignoreTacCapModelReady}
            timeSeconds={episodeTimeSeconds}
            tracks={tracks}
            trailEnabled
          />
          <OrbitControls makeDefault target={[0, 0, 0]} />
        </Canvas>
        <UrdfVideoOverlay
          active
          episodeTimeSeconds={episodeTimeSeconds}
          playing={!paused && replay.windowDurationSeconds > 0}
          replayRevision={0}
          videos={Array.from(replay.videosInfo)}
        />
        <div className={styles.replayStatus}>
          <span>
            {replay.recognizedVideoCount} / 6 video streams · t+
            {localTimeSeconds.toFixed(1)}s
          </span>
          {issues.length > 0 && <strong>Missing: {issues.join(", ")}</strong>}
        </div>
      </div>
    </section>
  );
}

const TopGroupsSlide = memo(function TopGroupsSlide({
  snapshot,
  total,
}: {
  snapshot: WorkbenchDisplaySnapshot;
  total: number;
}) {
  const maxHours = Math.max(1, ...snapshot.topGroups.map((row) => row.hours));

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={5}
        total={total}
        title="Top groups"
        meta={`Workstation · ${formatRange(snapshot)} · Top ${snapshot.topGroups.length}`}
      />
      {snapshot.topGroups.length === 0 ? (
        <EmptySlide range={formatRange(snapshot)}>
          No group data in this range
        </EmptySlide>
      ) : (
        <div className={styles.barList}>
          {snapshot.topGroups.map((row, index) => (
            <div
              className={styles.barRow}
              key={row.group}
              style={
                {
                  "--display-delay": `${index * 110}ms`,
                  "--display-bar-width": `${Math.max(2, (row.hours / maxHours) * 100)}%`,
                } as BarStyle
              }
            >
              <div className={styles.rank}>
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className={styles.groupName} title={row.group}>
                {row.group}
              </div>
              <div className={styles.barTrack}>
                <div className={styles.barFill} />
                <div className={styles.barValues}>
                  <strong>{formatHours(row.hours)}</strong>
                  <span>{formatCount(row.datasets)} datasets</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});

function TacCapVideoSlide({
  elapsedMs,
  paused,
  total,
}: {
  elapsedMs: number;
  paused: boolean;
  total: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [showSoundPrompt, setShowSoundPrompt] = useState(false);

  const playVideo = useCallback((allowMutedFallback: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => {
      if (!allowMutedFallback) return;
      video.muted = true;
      setMuted(true);
      setShowSoundPrompt(true);
      void video.play().catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.muted = false;
    setMuted(false);
    setShowSoundPrompt(false);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) {
      video.pause();
      return;
    }
    playVideo(true);
  }, [paused, playVideo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const targetSeconds = Math.min(20, Math.max(0, elapsedMs / 1_000));
    if (Math.abs(video.currentTime - targetSeconds) > 0.75) {
      video.currentTime = targetSeconds;
    }
  }, [elapsedMs]);

  const restoreSound = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
    setShowSoundPrompt(false);
    if (!paused) playVideo(false);
  };

  return (
    <section className={styles.slideSection}>
      <SlideHeading
        index={total - 1}
        total={total}
        title="TacCap Video"
        meta="Showcase · First 20 seconds"
      />
      <div className={styles.showcaseVideoFrame}>
        <video
          aria-label="TacCap showcase video"
          autoPlay
          className={styles.showcaseVideo}
          muted={muted}
          playsInline
          preload="auto"
          ref={videoRef}
          src="/media/xense-taccap.mp4"
        />
        {showSoundPrompt && (
          <button
            className={styles.soundPrompt}
            onClick={restoreSound}
            type="button"
          >
            Autoplay continued muted · Turn sound on
          </button>
        )}
      </div>
    </section>
  );
}

export default function WorkbenchDisplay({
  snapshot,
  onExit,
}: WorkbenchDisplayProps) {
  const reducedMotion = useReducedMotion();
  const slides = useMemo(
    () => getWorkbenchDisplaySlides(Boolean(snapshot.replay)),
    [snapshot.replay],
  );
  const [slideIndex, setSlideIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const slideIndexRef = useRef(0);
  const pausedRef = useRef(false);
  const clockRef = useRef<WorkbenchDisplayClock>(
    createWorkbenchDisplayClock(slides[0].durationMs, performance.now()),
  );
  const detailCursorRef = useRef(0);
  const personnelCursorRef = useRef(0);
  const heatmapCursorRef = useRef(0);
  const backgroundPausedRef = useRef(false);
  const controlsTimerRef = useRef<number | null>(null);
  const exitingRef = useRef(false);

  const commitCursor = useCallback(() => {
    const index = slideIndexRef.current;
    const slide = slides[index];
    const now = performance.now();
    const elapsed =
      slide.durationMs -
      getWorkbenchDisplayClockRemaining(clockRef.current, now);
    if (slide.id === "workstation-detail") {
      detailCursorRef.current += Math.min(
        3,
        Math.floor(elapsed / WORKBENCH_DISPLAY_DETAIL_PAGE_DURATION_MS) + 1,
      );
    }
    if (slide.id === "personnel-workload") {
      personnelCursorRef.current += Math.min(
        3,
        Math.floor(elapsed / WORKBENCH_DISPLAY_PERSONNEL_PAGE_DURATION_MS) + 1,
      );
    }
    if (slide.id === "workstation-heatmap") {
      heatmapCursorRef.current += Math.min(
        3,
        Math.floor(elapsed / WORKBENCH_DISPLAY_HEATMAP_WINDOW_DURATION_MS) + 1,
      );
    }
  }, [slides]);

  const moveSlide = useCallback(
    (offset: number) => {
      commitCursor();
      const nextIndex = getWorkbenchDisplaySlideIndex(
        slideIndexRef.current,
        offset,
        slides,
      );
      const now = performance.now();
      const nextClock = createWorkbenchDisplayClock(
        slides[nextIndex].durationMs,
        now,
      );
      clockRef.current = pausedRef.current
        ? pauseWorkbenchDisplayClock(nextClock, now)
        : nextClock;
      slideIndexRef.current = nextIndex;
      setElapsedMs(0);
      setSlideIndex(nextIndex);
    },
    [commitCursor, slides],
  );

  const pausePlayback = useCallback(() => {
    if (pausedRef.current) return;
    const now = performance.now();
    const slide = slides[slideIndexRef.current];
    clockRef.current = pauseWorkbenchDisplayClock(clockRef.current, now);
    pausedRef.current = true;
    setElapsedMs(slide.durationMs - clockRef.current.remainingMs);
    setPaused(true);
  }, [slides]);

  const resumePlayback = useCallback(() => {
    if (!pausedRef.current) return;
    clockRef.current = resumeWorkbenchDisplayClock(
      clockRef.current,
      performance.now(),
    );
    pausedRef.current = false;
    setPaused(false);
  }, []);

  const togglePlayback = useCallback(() => {
    if (pausedRef.current) resumePlayback();
    else pausePlayback();
  }, [pausePlayback, resumePlayback]);

  const exitDisplay = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onExit();
  }, [onExit]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
    }
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      controlsTimerRef.current = null;
    }, 3_000);
  }, []);

  useEffect(() => {
    const slide = slides[slideIndex];
    if (paused) return;

    const updateElapsed = () => {
      const remaining = getWorkbenchDisplayClockRemaining(
        clockRef.current,
        performance.now(),
      );
      setElapsedMs(slide.durationMs - remaining);
    };
    updateElapsed();
    const tickTimer = window.setInterval(updateElapsed, 100);
    const advanceTimer = window.setTimeout(
      () => moveSlide(1),
      getWorkbenchDisplayClockRemaining(clockRef.current, performance.now()),
    );
    return () => {
      window.clearInterval(tickTimer);
      window.clearTimeout(advanceTimer);
    };
  }, [moveSlide, paused, slideIndex, slides]);

  useEffect(() => {
    showControls();
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    return () => {
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, [showControls]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSlide(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSlide(1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        exitDisplay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exitDisplay, moveSlide, togglePlayback]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (!pausedRef.current) {
          backgroundPausedRef.current = true;
          pausePlayback();
        }
      } else if (backgroundPausedRef.current) {
        backgroundPausedRef.current = false;
        resumePlayback();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [pausePlayback, resumePlayback]);

  useEffect(() => {
    let ownedFullscreen = Boolean(document.fullscreenElement);
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) {
        ownedFullscreen = true;
      } else if (ownedFullscreen && !exitingRef.current) {
        exitingRef.current = true;
        onExit();
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [onExit]);

  const slide = slides[slideIndex];
  const slideProgress = Math.min(1, elapsedMs / slide.durationMs);
  const slideContent = useMemo(() => {
    switch (slide.id as WorkbenchDisplaySlideId) {
      case "overview":
        return (
          <OverviewSlide
            snapshot={snapshot}
            elapsedMs={elapsedMs}
            reducedMotion={reducedMotion}
            total={slides.length}
          />
        );
      case "workstation-detail":
        return (
          <WorkstationDetailSlide
            snapshot={snapshot}
            elapsedMs={elapsedMs}
            pageCursor={detailCursorRef.current}
            total={slides.length}
          />
        );
      case "personnel-workload":
        return (
          <PersonnelWorkloadSlide
            snapshot={snapshot}
            elapsedMs={elapsedMs}
            pageCursor={personnelCursorRef.current}
            total={slides.length}
          />
        );
      case "workstation-heatmap":
        return (
          <WorkstationHeatmapSlide
            snapshot={snapshot}
            elapsedMs={elapsedMs}
            windowCursor={heatmapCursorRef.current}
            total={slides.length}
          />
        );
      case "daily-trend":
        return (
          <DailyTrendSlide
            snapshot={snapshot}
            reducedMotion={reducedMotion}
            total={slides.length}
          />
        );
      case "top-groups":
        return <TopGroupsSlide snapshot={snapshot} total={slides.length} />;
      case "3d-replay":
        return (
          <TacCapReplaySlide
            snapshot={snapshot}
            elapsedMs={elapsedMs}
            paused={paused}
            total={slides.length}
          />
        );
      case "taccap-video":
        return (
          <TacCapVideoSlide
            elapsedMs={elapsedMs}
            paused={paused}
            total={slides.length}
          />
        );
    }
  }, [elapsedMs, paused, reducedMotion, slide.id, slides.length, snapshot]);

  return createPortal(
    <div
      className={styles.display}
      role="dialog"
      aria-modal="true"
      aria-label="Workbench operations display"
      onMouseMove={showControls}
    >
      <div className={styles.ambientGlow} aria-hidden="true" />
      <SummaryHeader snapshot={snapshot} />
      <main className={styles.stage} aria-live="off" data-slide={slide.id}>
        <div className={styles.slideTransition} key={slide.id}>
          {slideContent}
        </div>
      </main>

      <div
        className={`${styles.controls} ${controlsVisible ? styles.controlsVisible : ""}`}
        aria-hidden={!controlsVisible}
      >
        <button
          type="button"
          onClick={() => moveSlide(-1)}
          aria-label="Previous chapter"
          title="Previous chapter (Left arrow)"
          tabIndex={controlsVisible ? 0 : -1}
        >
          <FiChevronLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={togglePlayback}
          aria-label={paused ? "Resume display" : "Pause display"}
          title={paused ? "Resume (Space)" : "Pause (Space)"}
          tabIndex={controlsVisible ? 0 : -1}
        >
          {paused ? (
            <FiPlay aria-hidden="true" />
          ) : (
            <FiPause aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => moveSlide(1)}
          aria-label="Next chapter"
          title="Next chapter (Right arrow)"
          tabIndex={controlsVisible ? 0 : -1}
        >
          <FiChevronRight aria-hidden="true" />
        </button>
        <span className={styles.controlDivider} />
        <button
          type="button"
          onClick={exitDisplay}
          aria-label="Exit display"
          title="Exit display (Esc)"
          tabIndex={controlsVisible ? 0 : -1}
        >
          <FiX aria-hidden="true" />
        </button>
      </div>

      <footer
        className={styles.progress}
        aria-label="Display chapter progress"
        tabIndex={0}
        style={{
          gridTemplateColumns: `repeat(${slides.length}, minmax(0, 1fr))`,
        }}
      >
        {slides.map((item, index) => {
          const value =
            index < slideIndex ? 1 : index === slideIndex ? slideProgress : 0;
          return (
            <div
              className={`${styles.progressSegment} ${
                index === slideIndex ? styles.progressActive : ""
              }`}
              key={item.id}
            >
              <div className={styles.progressTrack}>
                <span style={{ transform: `scaleX(${value})` }} />
              </div>
              <div className={styles.progressLabel}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{item.title}</strong>
                <small>{item.durationMs / 1_000}s</small>
              </div>
            </div>
          );
        })}
      </footer>
      {paused && <div className={styles.pausedBadge}>Paused</div>}
    </div>,
    document.body,
  );
}

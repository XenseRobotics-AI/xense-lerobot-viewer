import { describe, expect, test } from "bun:test";
import { makeLocalRepoId } from "@/utils/datasetRoute";
import {
  TACCAP_WORKBENCH_REPLAY_DATASET,
  WORKBENCH_DISPLAY_SLIDES,
  WORKBENCH_DISPLAY_TOTAL_DURATION_MS,
  createWorkbenchDisplayClock,
  createWorkbenchDisplayReplaySnapshot,
  createWorkbenchDisplaySnapshot,
  getWorkbenchDisplaySlides,
  getWorkbenchDetailPage,
  getWorkbenchPersonnelPage,
  getWorkbenchDisplayClockRemaining,
  getWorkbenchDisplaySlideAtElapsed,
  getWorkbenchDisplaySlideIndex,
  getWorkbenchHeatmapWindow,
  getWorkbenchTopGroups,
  isTacCapWorkbenchReplaySource,
  pauseWorkbenchDisplayClock,
  resumeWorkbenchDisplayClock,
  sortWorkbenchDisplayWorkstations,
  getWorkbenchDisplayDailyTargetHours,
  type WorkbenchDisplaySnapshotInput,
} from "@/components/workbench-display-utils";

function snapshotInput(
  overrides: Partial<WorkbenchDisplaySnapshotInput> = {},
): WorkbenchDisplaySnapshotInput {
  return {
    organization: "Factory",
    capturedAt: "2026-09-03T12:00:00.000Z",
    dateRange: {
      startDate: "2026-09-01",
      endDate: "2026-09-03",
    },
    dailyTargetHours: 6,
    summary: {
      totalHours: 12,
      episodes: 24,
      targetHours: 12,
      projectedReward: 200,
    },
    workstations: [],
    heatmapDays: [],
    heatmapRows: [],
    trend: [],
    topGroups: [],
    ...overrides,
  };
}

describe("Workbench display slide sequence", () => {
  test("uses the fixed six-chapter order and a 74 second loop", () => {
    expect(WORKBENCH_DISPLAY_SLIDES.map((slide) => slide.id)).toEqual([
      "overview",
      "workstation-detail",
      "personnel-workload",
      "workstation-heatmap",
      "daily-trend",
      "top-groups",
    ]);
    expect(WORKBENCH_DISPLAY_SLIDES.map((slide) => slide.durationMs)).toEqual([
      10_000, 15_000, 15_000, 12_000, 11_000, 11_000,
    ]);
    expect(WORKBENCH_DISPLAY_TOTAL_DURATION_MS).toBe(74_000);
  });

  test("moves manually in either direction and wraps at both ends", () => {
    expect(getWorkbenchDisplaySlideIndex(0, 1)).toBe(1);
    expect(getWorkbenchDisplaySlideIndex(0, -1)).toBe(5);
    expect(getWorkbenchDisplaySlideIndex(3, 1)).toBe(4);
  });

  test("maps elapsed loop time and returns to the first chapter", () => {
    expect(getWorkbenchDisplaySlideAtElapsed(14_999)).toEqual({
      slideIndex: 1,
      slideElapsedMs: 4_999,
    });
    expect(getWorkbenchDisplaySlideAtElapsed(15_000)).toEqual({
      slideIndex: 1,
      slideElapsedMs: 5_000,
    });
    expect(getWorkbenchDisplaySlideAtElapsed(48_999)).toEqual({
      slideIndex: 3,
      slideElapsedMs: 8_999,
    });
    expect(getWorkbenchDisplaySlideAtElapsed(74_000)).toEqual({
      slideIndex: 0,
      slideElapsedMs: 0,
    });
  });
});

describe("Workbench display pagination", () => {
  test("shows ten workstation rows and wraps the last page to the first", () => {
    const rows = Array.from({ length: 13 }, (_, index) => "row-" + (index + 1));

    expect(getWorkbenchDetailPage(rows, 0)).toEqual({
      items: rows.slice(0, 10),
      pageIndex: 0,
      pageCount: 2,
    });
    expect(getWorkbenchDetailPage(rows, 1)).toEqual({
      items: ["row-11", "row-12", "row-13"],
      pageIndex: 1,
      pageCount: 2,
    });
    expect(getWorkbenchDetailPage(rows, 2)).toEqual({
      items: rows.slice(0, 10),
      pageIndex: 0,
      pageCount: 2,
    });
  });

  test("shows ten personnel rows and wraps the last page to the first", () => {
    const rows = Array.from(
      { length: 13 },
      (_, index) => "person-" + (index + 1),
    );

    expect(getWorkbenchPersonnelPage(rows, 0)).toEqual({
      items: rows.slice(0, 10),
      pageIndex: 0,
      pageCount: 2,
    });
    expect(getWorkbenchPersonnelPage(rows, 1)).toEqual({
      items: ["person-11", "person-12", "person-13"],
      pageIndex: 1,
      pageCount: 2,
    });
    expect(getWorkbenchPersonnelPage(rows, 2).pageIndex).toBe(0);
  });

  test("shows at most fourteen heatmap days per date window", () => {
    const days = Array.from(
      { length: 30 },
      (_, index) => "2026-09-" + String(index + 1).padStart(2, "0"),
    );

    expect(getWorkbenchHeatmapWindow(days, 0).items).toHaveLength(14);
    expect(getWorkbenchHeatmapWindow(days, 1).items).toEqual(
      days.slice(14, 28),
    );
    expect(getWorkbenchHeatmapWindow(days, 2).items).toEqual(days.slice(28));
    expect(getWorkbenchHeatmapWindow(days, 3).pageIndex).toBe(0);
  });

  test("returns stable empty pages instead of skipping empty chapters", () => {
    expect(getWorkbenchDetailPage([], 99)).toEqual({
      items: [],
      pageIndex: 0,
      pageCount: 1,
    });
    expect(getWorkbenchHeatmapWindow([], 99)).toEqual({
      items: [],
      pageIndex: 0,
      pageCount: 1,
    });
  });
});

describe("Workbench display snapshot", () => {
  test("orders workstation detail rows by bonus before paging", () => {
    const rows = [
      {
        robotId: "robot-a",
        workstation: "Station A",
        personnel: "Alice",
        sourceRepoIds: [],
        datasets: 1,
        hours: 12,
        targetHours: 6,
        ratePercent: 200,
        reward: 20,
      },
      {
        robotId: "robot-b",
        workstation: "Station B",
        personnel: "Bob",
        sourceRepoIds: [],
        datasets: 1,
        hours: 24,
        targetHours: 6,
        ratePercent: 400,
        reward: 5,
      },
    ];

    expect(
      sortWorkbenchDisplayWorkstations(rows).map((row) => row.reward),
    ).toEqual([20, 5]);
  });

  test("calculates the aggregate daily target from group count", () => {
    expect(getWorkbenchDisplayDailyTargetHours(5, 9)).toBe(45);
    expect(getWorkbenchDisplayDailyTargetHours(5, 0)).toBe(0);
  });

  test("keeps only the top eight groups sorted by hours", () => {
    const groups = Array.from({ length: 12 }, (_, index) => ({
      group: "group-" + index,
      hours: index,
      datasets: index + 1,
    }));

    const top = getWorkbenchTopGroups(groups);
    expect(top).toHaveLength(8);
    expect(top.map((row) => row.hours)).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
  });

  test("clones, freezes, sorts and limits mutable source data", () => {
    const sourceHours = { "2026-09-01": 8 };
    const sourceRepoIds = ["Factory/robot-a"];
    const input = snapshotInput({
      workstations: [
        {
          robotId: "robot-a",
          workstation: "Station A",
          personnel: "Alice",
          sourceRepoIds,
          datasets: 1,
          hours: 8,
          targetHours: 6,
          ratePercent: 133.3,
          reward: 20,
        },
      ],
      heatmapDays: ["2026-09-02", "2026-09-01"],
      heatmapRows: Array.from({ length: 12 }, (_, index) => ({
        robotId: "robot-" + index,
        workstation: "station-" + index,
        totalHours: index,
        hoursByDay: index === 11 ? sourceHours : {},
      })),
      topGroups: Array.from({ length: 10 }, (_, index) => ({
        group: "group-" + index,
        hours: index,
        datasets: index,
      })),
    });

    const snapshot = createWorkbenchDisplaySnapshot(input);
    sourceHours["2026-09-01"] = 99;
    sourceRepoIds.push("Factory/robot-a-2");

    expect(snapshot.workstations[0]).toMatchObject({
      workstation: "Station A",
      personnel: "Alice",
      sourceRepoIds: ["Factory/robot-a"],
    });
    expect(Object.isFrozen(snapshot.workstations[0].sourceRepoIds)).toBe(true);
    expect(snapshot.heatmapDays).toEqual(["2026-09-01", "2026-09-02"]);
    expect(snapshot.heatmapRows).toHaveLength(10);
    expect(snapshot.heatmapRows[0].robotId).toBe("robot-11");
    expect(snapshot.heatmapRows[0].hoursByDay["2026-09-01"]).toBe(8);
    expect(snapshot.topGroups).toHaveLength(8);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.summary)).toBe(true);
    expect(Object.isFrozen(snapshot.heatmapRows[0].hoursByDay)).toBe(true);
  });

  test("captures all Overview metrics and deep-freezes personnel rows", () => {
    const personnelRow = {
      personnel: "Alice",
      workstation: "Station A",
      hours: 8.5,
      targetHours: 12,
      ratePercent: 70.8,
      rule: "Developing",
      reward: 25,
      email: "alice@example.com",
    };
    const snapshot = createWorkbenchDisplaySnapshot(
      snapshotInput({
        summary: {
          organizationTotalHours: 120,
          selectedRangeHours: 48,
          episodes: 32,
          tasks: 7,
          storageBytes: 4096,
          dailyTargetHours: 6,
          totalBonus: 125,
          robotIds: 4,
          daysInRange: 8,
        },
        personnelRows: [personnelRow],
        personnelBonusTotal: 25,
        unattributedHours: 1.5,
      }),
    );

    expect(snapshot.summary).toEqual({
      organizationTotalHours: 120,
      selectedRangeHours: 48,
      episodes: 32,
      tasks: 7,
      storageBytes: 4096,
      dailyTargetHours: 6,
      totalBonus: 125,
      robotIds: 4,
      daysInRange: 8,
    });
    expect(snapshot.personnelRows).toEqual([personnelRow]);
    expect(snapshot.personnelBonusTotal).toBe(25);
    expect(snapshot.unattributedHours).toBe(1.5);
    expect(Object.isFrozen(snapshot.personnelRows)).toBe(true);
    expect(Object.isFrozen(snapshot.personnelRows[0])).toBe(true);
    personnelRow.personnel = "Changed";
    expect(snapshot.personnelRows[0].personnel).toBe("Alice");
  });

  test("preserves an explicit empty-data snapshot and its date range", () => {
    const snapshot = createWorkbenchDisplaySnapshot(snapshotInput());

    expect(snapshot.dateRange).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-03",
    });
    expect(snapshot.workstations).toEqual([]);
    expect(snapshot.heatmapRows).toEqual([]);
    expect(snapshot.trend).toEqual([]);
    expect(snapshot.topGroups).toEqual([]);
  });
});

describe("Workbench display playback clock", () => {
  test("does not advance while paused and resumes from remaining time", () => {
    const running = createWorkbenchDisplayClock(15_000, 1_000);
    const paused = pauseWorkbenchDisplayClock(running, 5_000);

    expect(paused.remainingMs).toBe(11_000);
    expect(getWorkbenchDisplayClockRemaining(paused, 20_000)).toBe(11_000);

    const resumed = resumeWorkbenchDisplayClock(paused, 20_000);
    expect(getWorkbenchDisplayClockRemaining(resumed, 21_000)).toBe(10_000);
  });
});

function replayRows(): Record<string, number>[] {
  return [0, 1].map((timestamp) => ({
    timestamp,
    "action | left_tcp.x": timestamp,
    "action | left_tcp.y": 0,
    "action | left_tcp.z": 0,
    "action | left_tcp.r1": 1,
    "action | left_tcp.r2": 0,
    "action | left_tcp.r3": 0,
    "action | left_tcp.r4": 0,
    "action | left_tcp.r5": 1,
    "action | left_tcp.r6": 0,
    "action | right_tcp.x": timestamp,
    "action | right_tcp.y": 0,
    "action | right_tcp.z": 0,
    "action | right_tcp.r1": 1,
    "action | right_tcp.r2": 0,
    "action | right_tcp.r3": 0,
    "action | right_tcp.r4": 0,
    "action | right_tcp.r5": 1,
    "action | right_tcp.r6": 0,
    "action | left_gripper": 0.5,
    "action | right_gripper": 0.5,
  }));
}

function replayVideos() {
  return [
    "left_wrist_rgb.mp4",
    "left_tactile_0.mp4",
    "left_tactile_1.mp4",
    "right_wrist_rgb.mp4",
    "right_tactile_0.mp4",
    "right_tactile_1.mp4",
  ].map((filename) => ({ filename, url: "/" + filename }));
}

describe("TacCap Workbench replay", () => {
  test("only enables the fixed dataset Episode 0 source", () => {
    expect(
      isTacCapWorkbenchReplaySource(TACCAP_WORKBENCH_REPLAY_DATASET, 0),
    ).toBe(true);
    expect(
      isTacCapWorkbenchReplaySource(
        makeLocalRepoId(
          "/home/xense/.cache/huggingface/lerobot/TacVerse/taccap-g1-operate-shoe-box-0812",
        ),
        0,
      ),
    ).toBe(true);
    expect(
      isTacCapWorkbenchReplaySource(TACCAP_WORKBENCH_REPLAY_DATASET, 1),
    ).toBe(false);
    expect(isTacCapWorkbenchReplaySource("TacVerse/another-dataset", 0)).toBe(
      false,
    );
  });

  test("uses the middle half of the valid random window and handles short episodes", () => {
    const source = {
      datasetName: TACCAP_WORKBENCH_REPLAY_DATASET,
      episodeId: 0,
      chartRows: replayRows(),
      videosInfo: replayVideos(),
      episodeDurationSeconds: 60,
      fps: 30,
    };
    const first = createWorkbenchDisplayReplaySnapshot(source, 0);
    const last = createWorkbenchDisplayReplaySnapshot(source, 1);
    expect(first?.randomStartSeconds).toBe(11.25);
    expect(last?.randomStartSeconds).toBe(33.75);
    expect(first?.windowDurationSeconds).toBe(15);

    const short = createWorkbenchDisplayReplaySnapshot(
      { ...source, episodeDurationSeconds: 10 },
      0.5,
    );
    expect(short?.randomStartSeconds).toBe(0);
    expect(short?.windowDurationSeconds).toBe(10);
  });

  test("recognizes six videos and reports missing streams and trajectories", () => {
    const complete = createWorkbenchDisplayReplaySnapshot(
      {
        datasetName: TACCAP_WORKBENCH_REPLAY_DATASET,
        episodeId: 0,
        chartRows: replayRows(),
        videosInfo: replayVideos(),
        episodeDurationSeconds: 20,
        fps: 30,
      },
      0.5,
    );
    expect(complete?.recognizedVideoCount).toBe(6);
    expect(complete?.missingVideoStreams).toEqual([]);
    expect(complete?.missingTrajectories).toEqual([]);

    const incomplete = createWorkbenchDisplayReplaySnapshot(
      {
        datasetName: TACCAP_WORKBENCH_REPLAY_DATASET,
        episodeId: 0,
        chartRows: [],
        videosInfo: replayVideos().slice(0, 1),
        episodeDurationSeconds: 20,
        fps: 30,
      },
      0.5,
    );
    expect(incomplete?.recognizedVideoCount).toBe(1);
    expect(incomplete?.missingVideoStreams).toEqual(["left", "right"]);
    expect(incomplete?.missingTrajectories).toEqual(["left", "right"]);
  });

  test("deep-freezes replay data when Display opens", () => {
    const rows = replayRows();
    const videos = replayVideos();
    const replay = createWorkbenchDisplayReplaySnapshot(
      {
        datasetName: TACCAP_WORKBENCH_REPLAY_DATASET,
        episodeId: 0,
        chartRows: rows,
        videosInfo: videos,
        episodeDurationSeconds: 20,
        fps: 30,
      },
      0.5,
    );
    const snapshot = createWorkbenchDisplaySnapshot(
      snapshotInput({ replay: replay ?? undefined }),
    );
    rows[0].timestamp = 99;
    videos[0].url = "/changed.mp4";

    expect(snapshot.replay?.chartRows[0].timestamp).toBe(0);
    expect(snapshot.replay?.videosInfo[0].url).toBe("/left_wrist_rgb.mp4");
    expect(Object.isFrozen(snapshot.replay)).toBe(true);
    expect(Object.isFrozen(snapshot.replay?.chartRows[0])).toBe(true);
    expect(Object.isFrozen(snapshot.replay?.videosInfo[0])).toBe(true);
  });

  test("adds a fifteen-second replay chapter after the six base chapters", () => {
    const five = getWorkbenchDisplaySlides(true);
    expect(five.map((slide) => slide.id)).toEqual([
      "overview",
      "workstation-detail",
      "personnel-workload",
      "workstation-heatmap",
      "daily-trend",
      "top-groups",
      "3d-replay",
    ]);
    expect(five.reduce((total, slide) => total + slide.durationMs, 0)).toBe(
      89_000,
    );
    expect(getWorkbenchDisplaySlideAtElapsed(88_999, five)).toEqual({
      slideIndex: 6,
      slideElapsedMs: 14_999,
    });
    expect(getWorkbenchDisplaySlideAtElapsed(89_000, five)).toEqual({
      slideIndex: 0,
      slideElapsedMs: 0,
    });
    expect(WORKBENCH_DISPLAY_TOTAL_DURATION_MS).toBe(74_000);
  });
});

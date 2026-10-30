import { describe, expect, test } from "bun:test";
import {
  activeRowAt,
  normalizeEpisode,
  normalizeTimeline,
} from "@/types/auto-annotation.types";

describe("normalizeTimeline", () => {
  test("keeps well-formed rows, reads numeric text, drops rows without readable times, sorts", () => {
    const rows = normalizeTimeline([
      { start_s: "5", end_s: 9, arm: "left", action: "place" },
      { start_s: 0, end_s: 5, arm: "right", action: "grasp", notes: "" },
      { start_s: "x", end_s: 2 },
      { start_s: 4, end_s: 3 },
      "not a row",
    ]);
    expect(rows.map((r) => [r.start_s, r.end_s, r.arm])).toEqual([
      [0, 5, "right"],
      [5, 9, "left"],
    ]);
    expect(rows[0].notes).toBeNull();
  });
});

describe("activeRowAt", () => {
  const rows = normalizeTimeline([
    { start_s: 0, end_s: 5 },
    { start_s: 5, end_s: 9 },
  ]);
  test("a boundary instant belongs to the step that begins there", () => {
    expect(activeRowAt(rows, 5)).toBe(1);
    expect(activeRowAt(rows, 2)).toBe(0);
    expect(activeRowAt(rows, 9.5)).toBe(-1);
  });
});

describe("normalizeEpisode", () => {
  test("merges data issues and operator mistakes in time order and reads the outcome", () => {
    const ep = normalizeEpisode({
      episode_index: 4,
      usable: true,
      problems: [],
      labels: {
        completion: {
          task_completed: "success_then_undone",
          reason: "recapped",
        },
        task_summary: "open and pour",
        timeline: [[0, 1]],
        data_issues: [
          { issue: "late", category: "instruction_mismatch", t_s: 43 },
        ],
        operator_mistakes: [
          { issue: "recap", category: "goal_undone", t_s: 12 },
        ],
      },
    });
    expect(ep?.outcome).toBe("success_then_undone");
    expect(ep?.findings.map((f) => [f.kind, f.t_s])).toEqual([
      ["operator_mistake", 12],
      ["data_issue", 43],
    ]);
    expect(ep?.timeline).toEqual([]); // array rows are TacFlow-side input; the report stores objects
  });

  test("an unusable entry keeps its problems", () => {
    const ep = normalizeEpisode({
      episode_index: 0,
      usable: false,
      problems: ["no reply"],
      labels: null,
    });
    expect(ep?.usable).toBe(false);
    expect(ep?.problems).toEqual(["no reply"]);
  });
});

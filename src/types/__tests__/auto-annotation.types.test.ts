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

import { summarizeReport, totalSummaries } from "@/types/auto-annotation.types";

describe("summarizeReport / totalSummaries", () => {
  const report = {
    schema: "tacflow.annotate.dataset/1",
    models: ["gpt-6.1-terra"],
    episodes_total: 3,
    spent_usd: 0.06,
    episodes: [
      {
        episode_index: 0,
        usable: true,
        labels: { completion: { task_completed: "success" } },
      },
      {
        episode_index: 1,
        usable: true,
        labels: {
          completion: { task_completed: "success_then_undone" },
          data_issues: [
            {
              issue: "single instruction, many items",
              category: "instruction_mismatch",
              t_s: 5,
            },
          ],
          operator_mistakes: [
            { issue: "recap", category: "goal_undone", t_s: 43 },
          ],
        },
      },
      { episode_index: 2, usable: false, problems: ["no reply"], labels: null },
    ],
  };

  test("counts only usable episodes and lists every finding with its episode", () => {
    const s = summarizeReport(report, "2026-10-30T13:21:21+00:00");
    expect(s.episodes_total).toBe(3);
    expect(s.episodes_usable).toBe(2);
    expect(s.outcomes).toEqual({ success: 1, success_then_undone: 1 });
    expect(s.episodes_with_findings).toBe(1);
    expect(s.findings.map((f) => [f.episode_index, f.category])).toEqual([
      [1, "instruction_mismatch"],
      [1, "goal_undone"],
    ]);
  });

  test("totals add up across datasets and group findings by category", () => {
    const a = summarizeReport(report, null);
    const totals = totalSummaries([a, a]);
    expect(totals).toMatchObject({
      datasets: 2,
      episodes: 6,
      usable: 4,
      findings: 4,
    });
    expect(totals.outcomes).toEqual({ success: 2, success_then_undone: 2 });
    expect(totals.categories).toEqual({
      instruction_mismatch: 2,
      goal_undone: 2,
    });
    expect(totals.spent).toBeCloseTo(0.12);
  });
});

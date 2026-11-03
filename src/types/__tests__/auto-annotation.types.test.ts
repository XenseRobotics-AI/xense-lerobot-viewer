import { describe, expect, test } from "bun:test";
import {
  activeRowAt,
  findingKey,
  groupFindings,
  normalizeEpisode,
  normalizeResolutions,
  normalizeTimeline,
  withResolutions,
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

describe("finding rulings (TacFlow `tacflow review --finding`)", () => {
  const finding = (
    episode_index: number,
    kind: "data_issue" | "operator_mistake",
    category: string | null,
    t_s: number | null,
  ) => ({
    episode_index,
    kind,
    category,
    severity: null,
    t_s,
    end_s: null,
    issue: `${kind} ${category} @${episode_index}`,
    evidence: null,
  });

  test("findingKey spells the key like TacFlow's registry.finding_key", () => {
    expect(findingKey(4, "operator_mistake", "goal_undone")).toBe(
      "4:operator_mistake:goal_undone",
    );
    expect(findingKey(0, "data_issue", null)).toBe("0:data_issue:");
  });

  test("normalizeResolutions keeps well-formed entries only", () => {
    const out = normalizeResolutions({
      "4:data_issue:x": {
        resolution: "confirmed",
        by: "u",
        at: "t",
        note: "keep",
      },
      bad: { by: "u" },
      worse: 3,
    });
    expect(Object.keys(out)).toEqual(["4:data_issue:x"]);
    expect(out["4:data_issue:x"].note).toBe("keep");
    expect(normalizeResolutions(null)).toEqual({});
  });

  test("withResolutions attaches a ruling by episode + kind + category", () => {
    const [ruled, open] = withResolutions(
      4,
      [finding(4, "data_issue", "x", 1), finding(4, "data_issue", "y", 2)],
      normalizeResolutions({ "4:data_issue:x": { resolution: "fixed" } }),
    );
    expect(ruled.resolution?.resolution).toBe("fixed");
    expect(open.resolution).toBeNull();
  });

  test("groupFindings merges a dataset's findings per kind + category, open groups first", () => {
    const ruled = { resolution: "confirmed", by: null, at: null, note: null };
    const groups = groupFindings([
      {
        ...finding(1, "data_issue", "instruction_mismatch", 9),
        resolution: ruled,
      },
      finding(7, "data_issue", "instruction_mismatch", 3),
      finding(3, "data_issue", "instruction_mismatch", 5),
      {
        ...finding(0, "operator_mistake", "goal_undone", 1),
        resolution: ruled,
      },
    ]);
    expect(groups.map((g) => [g.category, g.count, g.resolved])).toEqual([
      ["instruction_mismatch", 3, 1],
      ["goal_undone", 1, 1],
    ]);
    expect(groups[0].episodes).toEqual([1, 3, 7]);
    expect(groups[0].first.episode_index).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  baseScoreForSeverity,
  calculateTacFlowScore,
  gradeTacFlowScore,
  parseTacFlowDoctorReport,
  type TacFlowDoctorCheck,
} from "../scoring";

function check(
  id: string,
  severity: TacFlowDoctorCheck["severity"],
): TacFlowDoctorCheck {
  return {
    id,
    name: id,
    severity,
    messages: [],
    findings: [],
  };
}

describe("TacFlow scoring", () => {
  test("maps severity to base score", () => {
    expect(baseScoreForSeverity("PASS")).toBe(100);
    expect(baseScoreForSeverity("WARN")).toBe(70);
    expect(baseScoreForSeverity("FAIL")).toBe(0);
  });

  test("calculates the equal-weight score for fourteen checks", () => {
    const checks = [
      ...Array.from({ length: 10 }, (_, index) =>
        check(`pass_${index}`, "PASS"),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        check(`warn_${index}`, "WARN"),
      ),
      check("per_episode", "FAIL"),
    ];

    const result = calculateTacFlowScore(checks, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score).toBe(86.4);
      expect(result.grade).toBe("B");
      expect(result.rows).toHaveLength(14);
    }
  });

  test("uses custom weights without rerunning the report", () => {
    const checks = [check("metadata", "PASS"), check("per_episode", "FAIL")];

    const result = calculateTacFlowScore(checks, {
      metadata: 1,
      per_episode: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.score).toBe(25);
      expect(result.grade).toBe("D");
      expect(result.rows[1].weightedScore).toBe(0);
    }
  });

  test("returns a configuration error when all weights are zero", () => {
    const result = calculateTacFlowScore(
      [check("metadata", "PASS"), check("per_episode", "WARN")],
      { metadata: 0, per_episode: 0 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("greater than 0");
      expect(result.weightSum).toBe(0);
    }
  });

  test("grades the threshold boundaries", () => {
    expect(gradeTacFlowScore(90)).toBe("A");
    expect(gradeTacFlowScore(89.9)).toBe("B");
    expect(gradeTacFlowScore(75)).toBe("B");
    expect(gradeTacFlowScore(74.9)).toBe("C");
    expect(gradeTacFlowScore(60)).toBe("C");
    expect(gradeTacFlowScore(59.9)).toBe("D");
  });

  test("parses checks, messages, findings, and per_episode from a report", () => {
    const report = parseTacFlowDoctorReport({
      schema: "tacflow.doctor/1",
      overall_severity: "WARN",
      checks: [
        {
          id: "metadata",
          name: "Metadata",
          severity: "PASS",
          messages: [{ severity: "PASS", message: "ok" }],
          findings: [],
        },
        {
          id: "per_episode",
          name: "Per-Episode Summary",
          severity: "WARN",
          messages: ["Episode 1 needs review"],
          findings: [{ kind: "action_jump", episode: 1 }],
        },
      ],
    });

    expect(report.checks.map((item) => item.id)).toEqual([
      "metadata",
      "per_episode",
    ]);
    expect(report.checks[1].messages[0]).toEqual({
      severity: "WARN",
      message: "Episode 1 needs review",
    });
    expect(report.checks[1].findings[0]).toMatchObject({
      kind: "action_jump",
      episode: 1,
    });
  });
});

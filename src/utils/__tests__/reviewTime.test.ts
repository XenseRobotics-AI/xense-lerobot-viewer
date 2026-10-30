import { describe, expect, test } from "bun:test";
import { reviewTimestamp, REVIEW_TIME_ZONE } from "../reviewTime";

describe("review UTC+8 timestamps", () => {
  test("uses the fixed inspection timezone", () => {
    expect(REVIEW_TIME_ZONE).toBe("Asia/Shanghai");
  });
  test("preserves milliseconds and rolls across calendar boundaries", () => {
    expect(reviewTimestamp("2026-12-31T20:30:00.125Z")).toBe(
      "2027-01-01T04:30:00.125+08:00",
    );
    expect(reviewTimestamp(new Date("2026-10-29T06:00:00Z"))).toBe(
      "2026-10-29T14:00:00.000+08:00",
    );
  });
  test("normalizes offsets without changing the instant or converting twice", () => {
    const input = "2026-10-29T14:00:00.000+08:00";
    expect(reviewTimestamp(input)).toBe(input);
    expect(reviewTimestamp(reviewTimestamp(input))).toBe(input);
    expect(reviewTimestamp("2026-10-29T02:00:00-04:00")).toBe(input);
    expect(Date.parse(reviewTimestamp(input))).toBe(Date.parse(input));
  });
  test("new timestamps use an explicit offset and invalid timestamps fail", () => {
    expect(reviewTimestamp()).toMatch(/\+08:00$/);
    expect(() => reviewTimestamp("invalid")).toThrow(
      "Invalid review timestamp",
    );
  });
});

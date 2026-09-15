import { describe, expect, test } from "bun:test";
import {
  buildWorkbenchTrendRows,
  getWorkbenchTrendTicks,
  workbenchDateAtOffset,
  workbenchDateOffset,
} from "@/utils/workbenchTrend";

describe("Workbench trend calendar axis", () => {
  test("keeps real day gaps without filling missing days", () => {
    const trend = buildWorkbenchTrendRows(
      [
        { day: "2026-08-12", hours: 20, datasets: 1 },
        { day: "2026-08-16", hours: 10, datasets: 1 },
      ],
      {
        startDate: "2026-08-01",
        endDateExclusive: "2026-08-17",
      },
    );

    expect(trend.rows).toHaveLength(2);
    expect(trend.rows[0]).toMatchObject({
      day: "2026-08-12",
      dayOffset: 0,
      hours: 20,
      cumulativeHours: 20,
      hasActivity: true,
    });
    expect(trend.rows[1]).toMatchObject({
      day: "2026-08-16",
      dayOffset: 4,
      hours: 10,
      cumulativeHours: 30,
      hasActivity: true,
    });
    expect(trend.rows.map((row) => row.day)).not.toContain("2026-08-13");
  });

  test("uses the first and last active days when no explicit range is supplied", () => {
    const trend = buildWorkbenchTrendRows([
      { day: "2026-08-12", hours: 20, datasets: 1 },
      { day: "2026-08-16", hours: 10, datasets: 1 },
    ]);

    expect(trend.startDate).toBe("2026-08-12");
    expect(trend.endDateExclusive).toBe("2026-08-17");
    expect(trend.rows.map((row) => row.day)).toEqual([
      "2026-08-12",
      "2026-08-16",
    ]);
  });

  test("selects adaptive ticks only from actual data rows", () => {
    const rows = buildWorkbenchTrendRows(
      [
        { day: "2026-01-01", hours: 1, datasets: 1 },
        { day: "2026-01-03", hours: 1, datasets: 1 },
        { day: "2026-01-10", hours: 1, datasets: 1 },
        { day: "2026-01-20", hours: 1, datasets: 1 },
        { day: "2026-01-31", hours: 1, datasets: 1 },
      ],
      { startDate: "2026-01-01", endDateExclusive: "2026-02-01" },
    ).rows;
    const ticks = getWorkbenchTrendTicks(rows, 380);

    expect(ticks).toHaveLength(5);
    expect(ticks[0]).toMatchObject({ offset: 0, day: "2026-01-01" });
    expect(ticks.at(-1)).toMatchObject({
      offset: 30,
      day: "2026-01-31",
      label: "01-31",
    });
    expect(
      ticks.every((tick) => rows.some((row) => row.day === tick.day)),
    ).toBe(true);
  });

  test("rejects invalid dates instead of inventing an axis", () => {
    expect(workbenchDateOffset("2026-02-30", "2026-03-01")).toBeNull();
    expect(workbenchDateAtOffset("2026-08-01", -1)).toBeNull();
  });
});

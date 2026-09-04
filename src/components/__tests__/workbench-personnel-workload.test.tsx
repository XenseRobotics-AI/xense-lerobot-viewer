import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkbenchPersonnelWorkload, {
  WORKBENCH_PERSONNEL_WORKLOAD_COLUMNS,
} from "@/components/workbench-personnel-workload";
import type { WorkbenchPersonnelRollup } from "@/types/workbench-personnel.types";

function rollup(): WorkbenchPersonnelRollup {
  return {
    rows: [
      {
        personId: "zhang",
        personnel: "张三",
        workstations: ["A1", "B2"],
        hours: 8,
        scheduledDays: 1,
        targetHours: 6,
        ratePercent: 133.333,
        rule: "达标",
        reward: {
          percent: 133.333,
          level: null,
          amount: 200,
          symbol: "✅",
        },
        email: "zhang@example.com",
      },
    ],
    totalBonus: 200,
    unattributedHours: 1.25,
    unattributedWorkstations: [
      { day: "2026-09-03", workstation: "C3", hours: 1.25 },
    ],
  };
}

describe("WorkbenchPersonnelWorkload", () => {
  test("renders the fixed column order, deduplicated workstations, and total", () => {
    const html = renderToStaticMarkup(
      <WorkbenchPersonnelWorkload rollup={rollup()} />,
    );
    const headerPositions = WORKBENCH_PERSONNEL_WORKLOAD_COLUMNS.map((column) =>
      html.indexOf(`>${column}</th>`),
    );

    expect(headerPositions.every((position) => position >= 0)).toBeTrue();
    expect(headerPositions).toEqual([...headerPositions].sort((a, b) => a - b));
    expect(html).toContain("张三");
    expect(html).toContain("A1, B2");
    expect(html).toContain(">Email</th>");
    expect(html).toContain("zhang@example.com");
    expect(html).toContain("Personnel bonus total");
    expect(html).toContain("¥+200 🪙");
    expect(html).toContain("达标");
    expect(html).toContain("border-emerald-400/30");
    expect(html).toContain("Personnel attribution incomplete: 1.25 h");
  });

  test("keeps the table horizontally scrollable for 390px layouts", () => {
    const html = renderToStaticMarkup(
      <WorkbenchPersonnelWorkload rollup={rollup()} />,
    );
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-[900px]");
  });

  test("shows a concise empty mapping state", () => {
    const empty = rollup();
    empty.rows = [];
    const html = renderToStaticMarkup(
      <WorkbenchPersonnelWorkload rollup={empty} />,
    );

    expect(html).toContain("No personnel mappings are configured.");
  });
});

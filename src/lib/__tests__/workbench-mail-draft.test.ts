import { describe, expect, test } from "bun:test";
import {
  createDefaultWorkbenchMailDraft,
  createWorkbenchDashboardMarkdown,
  formatWorkbenchMailSubject,
  readWorkbenchMailDraft,
  saveWorkbenchMailDraft,
  validateWorkbenchMailDraft,
  workbenchMailDraftStorageKey,
  type WorkbenchDashboardMailInput,
} from "@/lib/workbench-mail-draft";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function createDashboardMailInput(
  overrides: Partial<WorkbenchDashboardMailInput> = {},
): WorkbenchDashboardMailInput {
  return {
    organization: "TacVerse",
    dateRange: {
      startDate: "2026-09-01",
      endDate: "2026-09-03",
    },
    generatedAt: "2026-09-02T08:30:00.000Z",
    summary: {
      totalHours: 12.5,
      episodes: 1024,
      targetHours: 6,
      projectedReward: 200,
      mappedWorkstations: 1,
      unmappedRobotIds: 1,
      legacyRows: 0,
      daysInRange: 2,
    },
    rows: [
      {
        robotId: "robot_01",
        sourceRepoIds: ["TacVerse/repo-a", "TacVerse/repo-b"],
        workstation: "Workstation A",
        datasets: 2,
        hours: 7.5,
        targetHours: 6,
        ratePercent: 125,
        rule: "达标",
        reward: 200,
      },
    ],
    alerts: [
      {
        kind: "warn",
        title: "Unmapped robot IDs",
        detail: "1 robot_id row(s) do not resolve to a workstation yet.",
      },
    ],
    ...overrides,
  };
}

describe("workbench mail draft", () => {
  test("provides the default sender, recipient, subject, and body", () => {
    expect(createDefaultWorkbenchMailDraft()).toEqual({
      sender: "1796262052@qq.com",
      recipient: "frank@xenserobotics.com",
      subject: "SMTP smoketest",
      body: "",
    });
  });

  test("saves and restores drafts per organization", () => {
    const storage = createMemoryStorage();
    const draft = {
      sender: "ignored@example.com",
      recipient: " ops@xenserobotics.com ",
      subject: " SMTP smoketest extra ",
      body: "Plain text body",
    };

    const saved = saveWorkbenchMailDraft("TacVerse", draft, storage);

    expect(saved).toEqual({
      sender: "1796262052@qq.com",
      recipient: "ops@xenserobotics.com",
      subject: "SMTP smoketest extra",
      body: "Plain text body",
    });
    expect(readWorkbenchMailDraft("TacVerse", storage)).toEqual(saved);
    expect(readWorkbenchMailDraft("OtherOrg", storage)).toEqual(
      createDefaultWorkbenchMailDraft(),
    );
    expect(storage.getItem(workbenchMailDraftStorageKey("TacVerse"))).toContain(
      '"org":"TacVerse"',
    );
  });

  test("rejects missing required fields", () => {
    const draft = createDefaultWorkbenchMailDraft();

    expect(validateWorkbenchMailDraft({ ...draft, recipient: " " })).toBe(
      "收件人不能为空。",
    );
    expect(validateWorkbenchMailDraft({ ...draft, subject: " " })).toBe(
      "主题不能为空。",
    );
    expect(validateWorkbenchMailDraft({ ...draft, body: "   " })).toBe(
      "正文不能为空。",
    );
  });

  test("formats a single-day dashboard subject", () => {
    expect(
      formatWorkbenchMailSubject({
        dateRange: { startDate: "2026-09-02", endDate: "2026-09-03" },
      }),
    ).toBe("Workbench dashboard 20260902");
  });

  test("formats a multi-day dashboard subject", () => {
    expect(
      formatWorkbenchMailSubject({
        dateRange: { startDate: "2026-09-01", endDate: "2026-09-03" },
      }),
    ).toBe("Workbench dashboard 20260901-20260902");
  });

  test("falls back when the dashboard date range is unavailable", () => {
    expect(
      formatWorkbenchMailSubject({
        dateRange: { startDate: null, endDate: null },
      }),
    ).toBe("Workbench dashboard");
  });

  test("creates Markdown with summary metrics and workstation rows", () => {
    const body = createWorkbenchDashboardMarkdown(createDashboardMailInput());

    expect(body).toContain("# Workbench dashboard");
    expect(body).toContain("Organization: TacVerse");
    expect(body).toContain("Date range: 2026-09-01 to 2026-09-02");
    expect(body).toContain("Generated at: 2026-09-02T08:30:00.000Z");
    expect(body).toContain("| Total hours | 12.50 |");
    expect(body).toContain("| Episodes | 1,024 |");
    expect(body).toContain("| Target | 6.00 |");
    expect(body).toContain("| Projected reward | +200 |");
    expect(body).toContain(
      "| Robot ID | Source repos | Workstation | Datasets | Hours | Target | Rate | Rule | Reward |",
    );
    expect(body).toContain(
      "| robot_01 | 2 repos: TacVerse/repo-a<br>TacVerse/repo-b | Workstation A | 2 | 7.50 | 6.00 | 125.0% | 达标 | +200 |",
    );
    expect(body).toContain(
      "- [WARN] Unmapped robot IDs: 1 robot_id row(s) do not resolve to a workstation yet.",
    );
  });

  test("creates placeholders for empty rows and alerts", () => {
    const body = createWorkbenchDashboardMarkdown(
      createDashboardMailInput({ rows: [], alerts: [] }),
    );

    expect(body).toContain("No workstation detail rows in the current range.");
    expect(body).toContain("No blockers detected in the current range.");
  });
});

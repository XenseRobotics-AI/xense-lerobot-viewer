import { describe, expect, test } from "bun:test";
import {
  createDefaultWorkbenchMailDraft,
  createWorkbenchDashboardMail,
  formatWorkbenchMailSubject,
  normalizeWorkbenchMailRecipients,
  parseWorkbenchMailRecipients,
  readWorkbenchMailDraft,
  saveWorkbenchMailDraft,
  validateWorkbenchMailDraft,
  validateWorkbenchMailMessage,
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
      organizationTotalHours: 2168.1,
      rangeHours: 12.5,
      episodes: 1024,
      tasks: 2,
      storageBytes: 1536,
      dailyTargetHours: 6,
      totalBonus: 200,
      robotIds: 1,
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
    personnelRows: [
      {
        personnel: "张三",
        workstation: "A1, B2",
        hours: 9.5,
        targetHours: 12,
        ratePercent: 79.2,
        rule: "不达标",
        reward: -160,
        email: "zhang@example.com",
      },
    ],
    personnelBonusTotal: -160,
    alerts: [
      {
        kind: "warn",
        title: "Reward rules need attention",
        detail: "Review the configured reward levels.",
      },
    ],
    ...overrides,
  };
}

describe("workbench mail draft", () => {
  test("provides the default sender, recipient, subject, and empty note", () => {
    expect(createDefaultWorkbenchMailDraft()).toEqual({
      sender: "1796262052@qq.com",
      recipient: "frank@xenserobotics.com",
      subject: "SMTP smoketest",
      note: "",
    });
  });

  test("saves and restores drafts per organization", () => {
    const storage = createMemoryStorage();
    const draft = {
      sender: "ignored@example.com",
      recipient:
        " ops@xenserobotics.com; jay@xenserobotics.com,OPS@xenserobotics.com ",
      subject: " SMTP smoketest extra ",
      note: "Please review the flagged rows.",
    };

    const saved = saveWorkbenchMailDraft("TacVerse", draft, storage);

    expect(saved).toEqual({
      sender: "1796262052@qq.com",
      recipient: "ops@xenserobotics.com, jay@xenserobotics.com",
      subject: "SMTP smoketest extra",
      note: "Please review the flagged rows.",
    });
    expect(readWorkbenchMailDraft("TacVerse", storage)).toEqual(saved);
    expect(readWorkbenchMailDraft("OtherOrg", storage)).toEqual(
      createDefaultWorkbenchMailDraft(),
    );
    expect(storage.getItem(workbenchMailDraftStorageKey("TacVerse"))).toContain(
      '"org":"TacVerse"',
    );
  });

  test("migrates only recipient and subject from legacy Markdown drafts", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      workbenchMailDraftStorageKey("TacVerse"),
      JSON.stringify({
        org: "TacVerse",
        draft: {
          sender: "spoof@example.com",
          recipient: "legacy@example.com",
          subject: "Legacy subject",
          body: "# Generated Markdown must not become a note",
        },
      }),
    );

    expect(readWorkbenchMailDraft("TacVerse", storage)).toEqual({
      sender: "1796262052@qq.com",
      recipient: "legacy@example.com",
      subject: "Legacy subject",
      note: "",
    });
  });

  test("validates drafts and generated messages separately", () => {
    const draft = createDefaultWorkbenchMailDraft();
    expect(validateWorkbenchMailDraft({ ...draft, recipient: " " })).toBe(
      "收件人不能为空。",
    );
    expect(validateWorkbenchMailDraft({ ...draft, subject: " " })).toBe(
      "主题不能为空。",
    );
    expect(validateWorkbenchMailDraft(draft)).toBeNull();
    expect(
      validateWorkbenchMailDraft({
        ...draft,
        recipient: "valid@example.com, invalid",
      }),
    ).toBe("收件人邮箱格式无效：invalid");

    const message = {
      ...draft,
      textBody: "Readable fallback",
      htmlBody: "<html><body>Report</body></html>",
    };
    expect(validateWorkbenchMailMessage(message)).toBeNull();
    expect(validateWorkbenchMailMessage({ ...message, textBody: " " })).toBe(
      "纯文本正文不能为空。",
    );
    expect(validateWorkbenchMailMessage({ ...message, htmlBody: " " })).toBe(
      "HTML 正文不能为空。",
    );
  });

  test("parses, deduplicates, and normalizes multiple recipients", () => {
    expect(
      parseWorkbenchMailRecipients(
        "one@example.com；two@example.com, ONE@example.com",
      ),
    ).toEqual(["one@example.com", "two@example.com"]);
    expect(
      normalizeWorkbenchMailRecipients(
        "one@example.com two@example.com,one@example.com",
      ),
    ).toBe("one@example.com, two@example.com");
  });

  test("formats dashboard subjects from the exclusive date range", () => {
    expect(
      formatWorkbenchMailSubject({
        dateRange: { startDate: "2026-09-02", endDate: "2026-09-03" },
      }),
    ).toBe("Workbench dashboard 20260902");
    expect(
      formatWorkbenchMailSubject({
        dateRange: { startDate: "2026-09-01", endDate: "2026-09-03" },
      }),
    ).toBe("Workbench dashboard 20260901-20260902");
    expect(
      formatWorkbenchMailSubject({
        dateRange: { startDate: null, endDate: null },
      }),
    ).toBe("Workbench dashboard");
  });

  test("creates structured text and responsive HTML bodies", () => {
    const { textBody, htmlBody } = createWorkbenchDashboardMail(
      createDashboardMailInput(),
      "Check the totals before approval.",
    );

    expect(textBody).toContain("WORKBENCH DASHBOARD");
    expect(textBody).toContain("Organization: TacVerse");
    expect(textBody).toContain("Date range: 2026-09-01 to 2026-09-02");
    expect(textBody).toContain("TacVerse total hours: 2,168.1 h");
    expect(textBody).toContain("Selected range hours: 12.50");
    expect(textBody).toContain("Tasks: 2");
    expect(textBody).toContain("Storage: 1.5 KB");
    expect(textBody).toContain("Daily target hours: 6.00 h/day");
    expect(textBody).toContain("Total bonus: +200");
    expect(textBody).toContain("Robot IDs: 1");
    expect(textBody.indexOf("TacVerse total hours")).toBeLessThan(
      textBody.indexOf("Selected range hours"),
    );
    expect(textBody).toContain("Robot ID: robot_01");
    expect(textBody).toContain("Hours / Range target: 7.50 / 6.00");
    expect(textBody).toContain("PERSONNEL WORKLOAD");
    expect(textBody).toContain("Personnel: 张三");
    expect(textBody).toContain("Workstation: A1, B2");
    expect(textBody).toContain("Hours: 9.50");
    expect(textBody).toContain("Range target: 12.00");
    expect(textBody).toContain("Rate: 79.2%");
    expect(textBody).toContain("Rule: 不达标");
    expect(textBody).toContain("Reward: -160");
    expect(textBody).toContain("Email: zhang@example.com");
    expect(textBody).toContain("Personnel bonus total: -160");
    const personnelText = textBody.slice(
      textBody.indexOf("PERSONNEL WORKLOAD"),
    );
    const personnelTextPositions = [
      "Personnel:",
      "Workstation:",
      "Hours:",
      "Range target:",
      "Rate:",
      "Rule:",
      "Reward:",
      "Email:",
    ].map((label) => personnelText.indexOf(label));
    expect(
      personnelTextPositions.every((position) => position >= 0),
    ).toBeTrue();
    expect(personnelTextPositions).toEqual(
      [...personnelTextPositions].sort((left, right) => left - right),
    );
    expect(textBody).toContain("Warning — Reward rules need attention");
    expect(textBody).toContain("NOTE\nCheck the totals before approval.");
    expect(textBody).not.toContain("| Robot ID |");

    expect(htmlBody).toContain("<h2");
    expect(htmlBody).toContain(">Summary</h2>");
    expect(htmlBody).toContain('class="mobile-detail" style="display:block;"');
    expect(htmlBody).toContain('class="desktop-detail"');
    expect(htmlBody).toContain('aria-label="Workstation detail"');
    expect(htmlBody).toContain('aria-label="Personnel workload"');
    expect(htmlBody).toContain("张三");
    expect(htmlBody).toContain("zhang@example.com");
    expect(htmlBody).toContain("Personnel bonus total");
    const personnelHtml = htmlBody.slice(
      htmlBody.indexOf('aria-label="Personnel workload"'),
    );
    const personnelHeaderPositions = [
      "Personnel",
      "Workstation",
      "Hours",
      "Range target",
      "Rate",
      "Rule",
      "Reward",
      "Email",
    ].map((label) => personnelHtml.indexOf(">" + label + "</th>"));
    expect(
      personnelHeaderPositions.every((position) => position >= 0),
    ).toBeTrue();
    expect(personnelHeaderPositions).toEqual(
      [...personnelHeaderPositions].sort((left, right) => left - right),
    );
    expect(htmlBody).toContain("@media only screen and (min-width: 720px)");
    expect(htmlBody).toContain("max-width:760px");
    expect(htmlBody).toContain("padding:12px");
    expect(htmlBody).toContain("Hours / Range target");
    expect(htmlBody).toContain("TacVerse total hours");
    expect(htmlBody).toContain("Selected range hours");
    expect(htmlBody).toContain("Storage");
    expect(htmlBody).not.toContain("Projected reward");
    expect(htmlBody).not.toContain("Mapped workstations");
    expect(htmlBody).not.toContain("Unmapped robot IDs");
    expect(htmlBody).not.toContain("Legacy rows");
    expect(htmlBody).toContain("Source repos");
    expect(htmlBody).toContain("Warning · Reward rules need attention");
    expect(htmlBody).toContain("Check the totals before approval.");
  });

  test("escapes every user-controlled HTML field", () => {
    const dangerous = '<img src=x onerror="alert(1)"> & value';
    const { htmlBody } = createWorkbenchDashboardMail(
      createDashboardMailInput({
        organization: dangerous,
        rows: [
          {
            ...createDashboardMailInput().rows[0],
            robotId: dangerous,
            sourceRepoIds: [dangerous],
            workstation: dangerous,
            rule: dangerous,
          },
        ],
        personnelRows: [
          {
            ...createDashboardMailInput().personnelRows[0],
            personnel: dangerous,
            workstation: dangerous,
            rule: dangerous,
            email: dangerous,
          },
        ],
        alerts: [{ kind: "error", title: dangerous, detail: dangerous }],
      }),
      `${dangerous}\n<script>alert(2)</script>`,
    );

    expect(htmlBody).not.toContain("<img src=x");
    expect(htmlBody).not.toContain("<script>alert(2)</script>");
    expect(htmlBody).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; value",
    );
    expect(htmlBody).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("keeps long robot and repository names breakable on narrow screens", () => {
    const longValue =
      "warehouse-with-an-extremely-long-name-without-a-natural-column-break-abcdefghijklmnopqrstuvwxyz";
    const { htmlBody } = createWorkbenchDashboardMail(
      createDashboardMailInput({
        rows: [
          {
            ...createDashboardMailInput().rows[0],
            robotId: longValue,
            sourceRepoIds: [longValue],
            workstation: longValue,
          },
        ],
      }),
    );

    expect(htmlBody).toContain(longValue);
    expect(htmlBody).toContain("word-break:break-all");
    expect(htmlBody).toContain("overflow-wrap:anywhere");
    expect(htmlBody).toContain("table-layout:fixed");
  });

  test("creates readable placeholders for empty rows and alerts", () => {
    const { textBody, htmlBody } = createWorkbenchDashboardMail(
      createDashboardMailInput({ rows: [], personnelRows: [], alerts: [] }),
    );

    expect(textBody).toContain(
      "No workstation detail rows in the current range.",
    );
    expect(textBody).toContain(
      "No personnel workload rows in the current range.",
    );
    expect(textBody).toContain("No blockers detected in the current range.");
    expect(htmlBody).toContain(
      "No workstation detail rows in the current range.",
    );
    expect(htmlBody).toContain(
      "No personnel workload rows in the current range.",
    );
    expect(htmlBody).toContain("No blockers detected in the current range.");
  });
});

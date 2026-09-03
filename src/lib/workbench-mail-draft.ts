export const WORKBENCH_MAIL_SENDER = "1796262052@qq.com";
const WORKBENCH_MAIL_RECIPIENT = "frank@xenserobotics.com";
const WORKBENCH_MAIL_SUBJECT = "SMTP smoketest";
const STORAGE_PREFIX = "xense-workbench-mail-draft";

export type WorkbenchMailDraft = {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
};

export type WorkbenchDashboardMailDateRange = {
  startDate: string | null;
  endDate: string | null;
};

export type WorkbenchDashboardMailSummary = {
  totalHours: number;
  episodes: number;
  targetHours: number | null;
  projectedReward: number;
  mappedWorkstations: number;
  unmappedRobotIds: number;
  legacyRows: number;
  daysInRange: number | null;
};

export type WorkbenchDashboardMailRow = {
  robotId: string | null;
  sourceRepoIds: readonly string[];
  workstation: string;
  datasets: number;
  hours: number;
  targetHours: number | null;
  ratePercent: number | null;
  rule: string;
  reward: number;
};

export type WorkbenchDashboardMailAlert = {
  kind: "warn" | "info" | "error";
  title: string;
  detail: string;
};

export type WorkbenchDashboardMailInput = {
  organization: string;
  dateRange: WorkbenchDashboardMailDateRange;
  generatedAt?: Date | string;
  summary: WorkbenchDashboardMailSummary;
  rows: readonly WorkbenchDashboardMailRow[];
  alerts: readonly WorkbenchDashboardMailAlert[];
};

type WorkbenchMailDraftRecord = {
  org: string;
  draft: WorkbenchMailDraft;
  updatedAt: string;
};

type WorkbenchMailDraftStorage = Pick<Storage, "getItem" | "setItem">;

function normalizeOrg(value: string): string {
  const org = value.trim();
  return org || "default";
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isDayKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function parseDayUtc(value: string): number | null {
  const [year, month, day] = value.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  const parsed = Date.UTC(year, month - 1, day);
  return dayKeyFromUtc(parsed) === value ? parsed : null;
}

function dayKeyFromUtc(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function normalizedMailDateRange(
  range?: WorkbenchDashboardMailDateRange | null,
): { startDate: string; inclusiveEndDate: string; days: number } | null {
  if (!range || !isDayKey(range.startDate) || !isDayKey(range.endDate)) {
    return null;
  }
  let start = parseDayUtc(range.startDate);
  let end = parseDayUtc(range.endDate);
  if (start === null || end === null) return null;
  if (start > end) [start, end] = [end, start];
  if (start === end) return null;
  const days = Math.floor((end - start) / 86_400_000);
  if (days <= 0) return null;
  return {
    startDate: dayKeyFromUtc(start),
    inclusiveEndDate: dayKeyFromUtc(end - 86_400_000),
    days,
  };
}

function compactDayKey(value: string): string {
  return value.replace(/-/gu, "");
}

function cleanInlineText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatDecimal(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatInteger(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return Math.round(Number(value)).toLocaleString("en-US");
}

function formatSignedNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "0";
  const number = Number(value);
  const prefix = number > 0 ? "+" : "";
  return (
    prefix +
    number.toLocaleString("en-US", {
      maximumFractionDigits: 2,
    })
  );
}

function formatPercent(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return `${Number(value).toFixed(1)}%`;
}

function formatGeneratedAt(value?: Date | string): string {
  const date =
    value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return cleanInlineText(value) || "-";
  return date.toISOString();
}

function escapeMarkdownTableCell(value: unknown): string {
  const text = cleanInlineText(value).replace(/\|/gu, "\\|");
  return text || "-";
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function markdownTableRow(cells: readonly unknown[]): string {
  return `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function formatDateRangeLabel(range: WorkbenchDashboardMailDateRange): string {
  const normalized = normalizedMailDateRange(range);
  if (!normalized) return "Not available";
  if (normalized.days === 1) return normalized.startDate;
  return `${normalized.startDate} to ${normalized.inclusiveEndDate}`;
}

function formatSourceReposCell(repoIds: readonly string[]): string {
  const repos = repoIds.map((repoId) => repoId.trim()).filter(Boolean);
  if (repos.length === 0) return "0";
  const label = repos.length === 1 ? "1 repo" : `${repos.length} repos`;
  return `${label}: ${repos.map(escapeHtmlText).join("<br>")}`;
}

function formatAlertKind(kind: WorkbenchDashboardMailAlert["kind"]): string {
  if (kind === "error") return "[ERROR]";
  if (kind === "warn") return "[WARN]";
  return "[INFO]";
}

function normalizeDraft(input: unknown): WorkbenchMailDraft | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const recipient = cleanText(raw.recipient);
  const subject = cleanText(raw.subject);
  const body = typeof raw.body === "string" ? raw.body : null;
  if (!recipient || !subject || body === null || !body.trim()) return null;
  return {
    sender: WORKBENCH_MAIL_SENDER,
    recipient,
    subject,
    body,
  };
}

function normalizeStoredRecord(
  input: unknown,
  org: string,
): WorkbenchMailDraft | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const recordOrg = cleanText(raw.org);
  if (recordOrg && recordOrg !== normalizeOrg(org)) return null;
  return normalizeDraft(raw.draft);
}

export function createDefaultWorkbenchMailDraft(): WorkbenchMailDraft {
  return {
    sender: WORKBENCH_MAIL_SENDER,
    recipient: WORKBENCH_MAIL_RECIPIENT,
    subject: WORKBENCH_MAIL_SUBJECT,
    body: "",
  };
}

export function formatWorkbenchMailSubject(input: {
  dateRange?: WorkbenchDashboardMailDateRange | null;
}): string {
  const range = normalizedMailDateRange(input.dateRange);
  if (!range) return "Workbench dashboard";
  if (range.days === 1) {
    return `Workbench dashboard ${compactDayKey(range.startDate)}`;
  }
  return `Workbench dashboard ${compactDayKey(
    range.startDate,
  )}-${compactDayKey(range.inclusiveEndDate)}`;
}

export function createWorkbenchDashboardMarkdown(
  input: WorkbenchDashboardMailInput,
): string {
  const lines = [
    "# Workbench dashboard",
    "",
    `Organization: ${cleanInlineText(input.organization) || "default"}`,
    `Date range: ${formatDateRangeLabel(input.dateRange)}`,
    `Generated at: ${formatGeneratedAt(input.generatedAt)}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    markdownTableRow(["Total hours", formatDecimal(input.summary.totalHours)]),
    markdownTableRow(["Episodes", formatInteger(input.summary.episodes)]),
    markdownTableRow(["Target", formatDecimal(input.summary.targetHours)]),
    markdownTableRow([
      "Projected reward",
      formatSignedNumber(input.summary.projectedReward),
    ]),
    markdownTableRow([
      "Mapped workstations",
      formatInteger(input.summary.mappedWorkstations),
    ]),
    markdownTableRow([
      "Unmapped robot IDs",
      formatInteger(input.summary.unmappedRobotIds),
    ]),
    markdownTableRow(["Legacy rows", formatInteger(input.summary.legacyRows)]),
    markdownTableRow([
      "Days in range",
      formatInteger(input.summary.daysInRange),
    ]),
    "",
    "## Workstation detail",
    "",
  ];

  if (input.rows.length === 0) {
    lines.push("No workstation detail rows in the current range.");
  } else {
    lines.push(
      "| Robot ID | Source repos | Workstation | Datasets | Hours | Target | Rate | Rule | Reward |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |",
    );
    for (const row of input.rows) {
      lines.push(
        markdownTableRow([
          row.robotId || "-",
          formatSourceReposCell(row.sourceRepoIds),
          row.workstation,
          formatInteger(row.datasets),
          formatDecimal(row.hours),
          formatDecimal(row.targetHours),
          formatPercent(row.ratePercent),
          row.rule,
          formatSignedNumber(row.reward),
        ]),
      );
    }
  }

  lines.push("", "## Alerts", "");
  if (input.alerts.length === 0) {
    lines.push("No blockers detected in the current range.");
  } else {
    for (const alert of input.alerts) {
      const title = cleanInlineText(alert.title) || "Alert";
      const detail = cleanInlineText(alert.detail);
      lines.push(
        `- ${formatAlertKind(alert.kind)} ${title}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
  }

  return lines.join("\n");
}

export function validateWorkbenchMailDraft(
  draft: WorkbenchMailDraft,
): string | null {
  if (!draft.recipient.trim()) return "收件人不能为空。";
  if (!draft.subject.trim()) return "主题不能为空。";
  if (!draft.body.trim()) return "正文不能为空。";
  return null;
}

export function workbenchMailDraftStorageKey(org: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(normalizeOrg(org))}`;
}

export function readWorkbenchMailDraft(
  org: string,
  storage: WorkbenchMailDraftStorage,
): WorkbenchMailDraft {
  const raw = storage.getItem(workbenchMailDraftStorageKey(org));
  if (!raw) return createDefaultWorkbenchMailDraft();
  try {
    return (
      normalizeStoredRecord(JSON.parse(raw) as unknown, org) ??
      createDefaultWorkbenchMailDraft()
    );
  } catch {
    return createDefaultWorkbenchMailDraft();
  }
}

export function saveWorkbenchMailDraft(
  org: string,
  draft: WorkbenchMailDraft,
  storage: WorkbenchMailDraftStorage,
): WorkbenchMailDraft {
  const validationError = validateWorkbenchMailDraft(draft);
  if (validationError) {
    throw new Error(validationError);
  }
  const normalizedOrg = normalizeOrg(org);
  const normalizedDraft: WorkbenchMailDraft = {
    sender: WORKBENCH_MAIL_SENDER,
    recipient: draft.recipient.trim(),
    subject: draft.subject.trim(),
    body: draft.body,
  };
  const record: WorkbenchMailDraftRecord = {
    org: normalizedOrg,
    draft: normalizedDraft,
    updatedAt: new Date().toISOString(),
  };
  storage.setItem(
    workbenchMailDraftStorageKey(normalizedOrg),
    JSON.stringify(record),
  );
  return normalizedDraft;
}

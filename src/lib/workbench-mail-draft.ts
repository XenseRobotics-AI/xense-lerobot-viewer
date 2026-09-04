import { formatBytes } from "@/utils/byteSize";

export const WORKBENCH_MAIL_SENDER = "1796262052@qq.com";
const WORKBENCH_MAIL_RECIPIENT = "frank@xenserobotics.com";
const STORAGE_PREFIX = "xense-workbench-mail-draft";
const MAIL_ADDRESS_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;
const WORKBENCH_MAIL_AUTO_SUBJECT_PATTERN =
  /^XenseRobotics · .+ Data Collection Team Daily Report(?: · \d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?)?$/u;
const WORKBENCH_MAIL_LEGACY_SUBJECT_PATTERN =
  /^(?:SMTP smoketest|Workbench dashboard(?: \d{8}(?:-\d{8})?)?)$/u;

export type WorkbenchMailDraft = {
  sender: string;
  recipient: string;
  subject: string;
  note: string;
};

export type WorkbenchMailMessage = {
  sender: string;
  recipient: string;
  subject: string;
  textBody: string;
  htmlBody: string;
};

export type WorkbenchDashboardMailDateRange = {
  startDate: string | null;
  endDate: string | null;
};

export type WorkbenchDashboardMailSummary = {
  organizationTotalHours: number;
  rangeHours: number;
  episodes: number;
  tasks: number;
  storageBytes: number;
  dailyTargetHours: number;
  totalBonus: number;
  sources: number;
  daysInRange: number | null;
};

export type WorkbenchDashboardMailRow = {
  sourceLabel: string;
  personnel: string;
  sourceRepoIds: readonly string[];
  workstation: string;
  datasets: number;
  hours: number;
  targetHours: number | null;
  ratePercent: number | null;
  rule: string;
  reward: number;
};

export type WorkbenchDashboardPersonnelMailRow = {
  personnel: string;
  workstation: string;
  hours: number;
  targetHours: number | null;
  ratePercent: number | null;
  rule: string;
  reward: number;
  email: string;
};

export type WorkbenchDashboardMailInput = {
  organization: string;
  dateRange: WorkbenchDashboardMailDateRange;
  generatedAt?: Date | string;
  summary: WorkbenchDashboardMailSummary;
  rows: readonly WorkbenchDashboardMailRow[];
  personnelRows: readonly WorkbenchDashboardPersonnelMailRow[];
  personnelBonusTotal: number;
};

type WorkbenchMailDraftRecord = {
  org: string;
  draft: WorkbenchMailDraft;
  updatedAt: string;
};

type WorkbenchMailDraftStorage = Pick<Storage, "getItem" | "setItem">;

type MailBodies = Pick<WorkbenchMailMessage, "textBody" | "htmlBody">;

function normalizeOrg(value: string): string {
  const org = value.trim();
  return org || "default";
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function parseWorkbenchMailRecipients(value: string): string[] {
  const recipients = value
    .split(/[\s,，;；]+/u)
    .map((recipient) => recipient.trim())
    .filter(Boolean);
  const unique = new Map<string, string>();
  for (const recipient of recipients) {
    const key = recipient.toLowerCase();
    if (!unique.has(key)) unique.set(key, recipient);
  }
  return Array.from(unique.values());
}

export function normalizeWorkbenchMailRecipients(value: string): string {
  return parseWorkbenchMailRecipients(value).join(", ");
}

function validateWorkbenchMailRecipients(value: string): string | null {
  const recipients = parseWorkbenchMailRecipients(value);
  if (recipients.length === 0) return "收件人不能为空。";
  const invalid = recipients.find(
    (recipient) => !MAIL_ADDRESS_PATTERN.test(recipient),
  );
  return invalid ? `收件人邮箱格式无效：${invalid}` : null;
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function formatDateRangeLabel(range: WorkbenchDashboardMailDateRange): string {
  const normalized = normalizedMailDateRange(range);
  if (!normalized) return "Not available";
  if (normalized.days === 1) return normalized.startDate;
  return `${normalized.startDate} to ${normalized.inclusiveEndDate}`;
}

function normalizedSourceRepos(repoIds: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const repoId of repoIds) {
    const repo = cleanInlineText(repoId);
    if (repo && repo !== "TacVerse/待确认") unique.add(repo);
  }
  return Array.from(unique).slice(0, 2);
}

function isClassifiedMailRow(row: WorkbenchDashboardMailRow): boolean {
  return cleanInlineText(row.sourceLabel) !== "TacVerse/待确认";
}

function htmlMetricRow(label: string, value: string): string {
  return `<tr>
    <td style="width:58%;padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;line-height:18px;">${escapeHtml(label)}</td>
    <td style="width:42%;padding:9px 10px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-weight:600;line-height:18px;text-align:right;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(value)}</td>
  </tr>`;
}

function htmlSourceRepos(repoIds: readonly string[]): string {
  const repos = normalizedSourceRepos(repoIds);
  if (repos.length === 0) return "<div>None</div>";
  return repos
    .map(
      (repo) =>
        `<div class="breakable" style="word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(repo)}</div>`,
    )
    .join("");
}

function htmlMobileDetailRow(
  row: WorkbenchDashboardMailRow,
  index: number,
): string {
  const source = cleanInlineText(row.sourceLabel) || "-";
  const workstation = cleanInlineText(row.workstation) || "-";
  const personnel = cleanInlineText(row.personnel) || "-";
  return `<div style="margin:0 0 12px;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;overflow:hidden;">
    <div style="padding:12px;background:#f1f5f9;border-bottom:1px solid #cbd5e1;">
      <div style="margin:0 0 3px;color:#64748b;font-size:11px;line-height:15px;text-transform:uppercase;letter-spacing:.06em;">Workstation ${index + 1}</div>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;">
      ${htmlMetricRow("Source", source)}
      ${htmlMetricRow("Workstation", workstation)}
      ${htmlMetricRow("Personnel", personnel)}
      ${htmlMetricRow("Source repos (first 2)", normalizedSourceRepos(row.sourceRepoIds).join(" / ") || "None")}
      ${htmlMetricRow("Datasets", formatInteger(row.datasets))}
      ${htmlMetricRow("WS hours", formatDecimal(row.hours))}
      ${htmlMetricRow("Avg target", formatDecimal(row.targetHours))}
      ${htmlMetricRow("Rate", formatPercent(row.ratePercent))}
      ${htmlMetricRow("Rule", cleanInlineText(row.rule) || "-")}
      ${htmlMetricRow("Reward", formatSignedNumber(row.reward))}
    </table>
  </div>`;
}

function htmlDesktopCell(value: unknown, align: "left" | "right" = "left") {
  return `<td style="padding:9px 7px;border-bottom:1px solid #e2e8f0;color:#334155;font-size:11px;line-height:16px;text-align:${align};vertical-align:top;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(value)}</td>`;
}

function htmlDesktopSourceCell(repoIds: readonly string[]): string {
  return `<td style="padding:9px 7px;border-bottom:1px solid #e2e8f0;color:#334155;font-size:11px;line-height:16px;vertical-align:top;word-break:break-all;overflow-wrap:anywhere;">${htmlSourceRepos(repoIds)}</td>`;
}

function htmlDesktopDetailRow(row: WorkbenchDashboardMailRow): string {
  return `<tr>
    ${htmlDesktopCell(cleanInlineText(row.sourceLabel) || "-")}
    ${htmlDesktopCell(cleanInlineText(row.workstation) || "-")}
    ${htmlDesktopCell(cleanInlineText(row.personnel) || "-")}
    ${htmlDesktopSourceCell(row.sourceRepoIds)}
    ${htmlDesktopCell(formatInteger(row.datasets), "right")}
    ${htmlDesktopCell(formatDecimal(row.hours), "right")}
    ${htmlDesktopCell(formatDecimal(row.targetHours), "right")}
    ${htmlDesktopCell(formatPercent(row.ratePercent), "right")}
    ${htmlDesktopCell(cleanInlineText(row.rule) || "-")}
    ${htmlDesktopCell(formatSignedNumber(row.reward), "right")}
  </tr>`;
}

function htmlMobilePersonnelRow(
  row: WorkbenchDashboardPersonnelMailRow,
  index: number,
): string {
  const personnel = cleanInlineText(row.personnel) || "-";
  const workstation = cleanInlineText(row.workstation) || "-";
  const email = cleanInlineText(row.email) || "-";
  return `<div style="margin:0 0 12px;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;overflow:hidden;">
    <div style="padding:12px;background:#f1f5f9;border-bottom:1px solid #cbd5e1;">
      <div style="margin:0 0 3px;color:#64748b;font-size:11px;line-height:15px;text-transform:uppercase;letter-spacing:.06em;">Personnel ${index + 1}</div>
      <div class="breakable" style="color:#0f172a;font-size:16px;font-weight:700;line-height:22px;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(personnel)}</div>
      <div style="margin-top:3px;color:#334155;font-size:13px;line-height:19px;">${escapeHtml(workstation)}</div>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;">
      ${htmlMetricRow("Avg hours", formatDecimal(row.hours))}
      ${htmlMetricRow("Avg target", formatDecimal(row.targetHours))}
      ${htmlMetricRow("Rate", formatPercent(row.ratePercent))}
      ${htmlMetricRow("Rule", cleanInlineText(row.rule) || "-")}
      ${htmlMetricRow("Reward", formatSignedNumber(row.reward))}
      ${htmlMetricRow("Email", email)}
    </table>
  </div>`;
}

function htmlDesktopPersonnelRow(
  row: WorkbenchDashboardPersonnelMailRow,
): string {
  return `<tr>
    ${htmlDesktopCell(cleanInlineText(row.personnel) || "-")}
    ${htmlDesktopCell(cleanInlineText(row.workstation) || "-")}
    ${htmlDesktopCell(formatDecimal(row.hours), "right")}
    ${htmlDesktopCell(formatDecimal(row.targetHours), "right")}
    ${htmlDesktopCell(formatPercent(row.ratePercent), "right")}
    ${htmlDesktopCell(cleanInlineText(row.rule) || "-")}
    ${htmlDesktopCell(formatSignedNumber(row.reward), "right")}
    ${htmlDesktopCell(cleanInlineText(row.email) || "-")}
  </tr>`;
}

function htmlHeaderCell(label: string, align: "left" | "right" = "left") {
  return `<th scope="col" style="padding:9px 7px;background:#e2e8f0;color:#334155;font-size:10px;font-weight:700;line-height:14px;text-align:${align};vertical-align:bottom;">${escapeHtml(label)}</th>`;
}

function htmlNote(note: string): string {
  return escapeHtml(note.trim()).replace(/\r?\n/gu, "<br>");
}

function createWorkbenchDashboardText(
  input: WorkbenchDashboardMailInput,
  note: string,
): string {
  const rows = input.rows.filter(isClassifiedMailRow);
  const lines = [
    "WORKBENCH DASHBOARD",
    `Organization: ${cleanInlineText(input.organization) || "default"}`,
    `Date range: ${formatDateRangeLabel(input.dateRange)}`,
    `Generated at: ${formatGeneratedAt(input.generatedAt)}`,
    "",
    "SUMMARY",
    `${cleanInlineText(input.organization) || "default"} total hours: ${formatDecimalOneHour(input.summary.organizationTotalHours)}`,
    `Selected range hours: ${formatDecimal(input.summary.rangeHours)} h`,
    `Episodes: ${formatInteger(input.summary.episodes)}`,
    `Tasks: ${formatInteger(input.summary.tasks)}`,
    `Storage: ${formatBytes(input.summary.storageBytes)}`,
    `Daily target hours: ${formatDecimal(input.summary.dailyTargetHours)} h/day`,
    `Total bonus: ${formatSignedNumber(input.summary.totalBonus)}`,
    `Sources: ${formatInteger(input.summary.sources)}`,
    `Days in range: ${formatInteger(input.summary.daysInRange)}`,
    "",
    "WORKSTATION DETAIL",
  ];

  if (rows.length === 0) {
    lines.push("No workstation detail rows in the current range.");
  } else {
    rows.forEach((row, index) => {
      const repos = normalizedSourceRepos(row.sourceRepoIds);
      if (index > 0) lines.push("");
      lines.push(
        `Workstation ${index + 1}`,
        `Source: ${cleanInlineText(row.sourceLabel) || "-"}`,
        `Workstation: ${cleanInlineText(row.workstation) || "-"}`,
        `Personnel: ${cleanInlineText(row.personnel) || "-"}`,
        "Source repos (first 2):",
      );
      if (repos.length === 0) lines.push("  None");
      else repos.forEach((repo) => lines.push(`  ${repo}`));
      lines.push(
        `Datasets: ${formatInteger(row.datasets)}`,
        `WS hours: ${formatDecimal(row.hours)}`,
        `Avg target: ${formatDecimal(row.targetHours)}`,
        `Rate: ${formatPercent(row.ratePercent)}`,
        `Rule: ${cleanInlineText(row.rule) || "-"}`,
        `Reward: ${formatSignedNumber(row.reward)}`,
      );
    });
  }

  lines.push("", "PERSONNEL WORKLOAD");
  if (input.personnelRows.length === 0) {
    lines.push("No personnel workload rows in the current range.");
  } else {
    input.personnelRows.forEach((row, index) => {
      if (index > 0) lines.push("");
      lines.push(
        "Personnel " + (index + 1),
        "Personnel: " + (cleanInlineText(row.personnel) || "-"),
        "Workstation: " + (cleanInlineText(row.workstation) || "-"),
        "Avg hours: " + formatDecimal(row.hours),
        "Avg target: " + formatDecimal(row.targetHours),
        "Rate: " + formatPercent(row.ratePercent),
        "Rule: " + (cleanInlineText(row.rule) || "-"),
        "Reward: " + formatSignedNumber(row.reward),
        "Email: " + (cleanInlineText(row.email) || "-"),
      );
    });
  }
  lines.push(
    "",
    "Personnel bonus total: " + formatSignedNumber(input.personnelBonusTotal),
  );
  if (note.trim()) lines.push("", "NOTE", note.trim());
  return lines.join("\n");
}

function createWorkbenchDashboardHtml(
  input: WorkbenchDashboardMailInput,
  note: string,
): string {
  const organization = cleanInlineText(input.organization) || "default";
  const dateRange = formatDateRangeLabel(input.dateRange);
  const rows = input.rows.filter(isClassifiedMailRow);
  const generatedAt = formatGeneratedAt(input.generatedAt);
  const summaryRows = [
    [
      `${organization} total hours`,
      formatDecimalOneHour(input.summary.organizationTotalHours),
    ],
    ["Selected range hours", `${formatDecimal(input.summary.rangeHours)} h`],
    ["Episodes", formatInteger(input.summary.episodes)],
    ["Tasks", formatInteger(input.summary.tasks)],
    ["Storage", formatBytes(input.summary.storageBytes)],
    [
      "Daily target hours",
      `${formatDecimal(input.summary.dailyTargetHours)} h/day`,
    ],
    ["Total bonus", formatSignedNumber(input.summary.totalBonus)],
    ["Sources", formatInteger(input.summary.sources)],
    ["Days in range", formatInteger(input.summary.daysInRange)],
  ].map(([label, value]) => htmlMetricRow(label, value));
  const emptyDetail = `<div style="padding:12px;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;color:#475569;font-size:13px;line-height:19px;">No workstation detail rows in the current range.</div>`;
  const mobileRows = rows.length
    ? rows.map(htmlMobileDetailRow).join("")
    : emptyDetail;
  const desktopRows = rows.length
    ? rows.map(htmlDesktopDetailRow).join("")
    : `<tr><td colspan="10" style="padding:12px;color:#475569;font-size:12px;line-height:18px;">No workstation detail rows in the current range.</td></tr>`;
  const emptyPersonnel = `<div style="padding:12px;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;color:#475569;font-size:13px;line-height:19px;">No personnel workload rows in the current range.</div>`;
  const mobilePersonnelRows = input.personnelRows.length
    ? input.personnelRows.map(htmlMobilePersonnelRow).join("")
    : emptyPersonnel;
  const desktopPersonnelRows = input.personnelRows.length
    ? input.personnelRows.map(htmlDesktopPersonnelRow).join("")
    : `<tr><td colspan="8" style="padding:12px;color:#475569;font-size:12px;line-height:18px;">No personnel workload rows in the current range.</td></tr>`;
  const noteSection = note.trim()
    ? `<div style="padding-top:22px;">
        <h2 style="margin:0 0 10px;color:#0f172a;font-size:17px;line-height:22px;">Note</h2>
        <div class="breakable" style="padding:12px;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;color:#334155;font-size:13px;line-height:20px;word-break:break-word;overflow-wrap:anywhere;">${htmlNote(note)}</div>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>Workbench dashboard</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    table { border-spacing: 0; border-collapse: collapse; }
    .mobile-detail { display: block; }
    .desktop-detail { display: none; }
    .breakable { word-break: break-word; overflow-wrap: anywhere; }
    @media only screen and (min-width: 720px) {
      .mobile-detail { display: none !important; max-height: 0 !important; overflow: hidden !important; }
      .desktop-detail { display: table !important; width: 100% !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#e2e8f0;color:#0f172a;font-family:Arial,'Helvetica Neue',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#e2e8f0;">
    <tr>
      <td align="center" style="padding:12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:760px;margin:0 auto;background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;">
          <tr>
            <td style="padding:22px 16px 24px;">
              <div style="padding-bottom:18px;border-bottom:1px solid #cbd5e1;">
                <h1 style="margin:0 0 12px;color:#0f172a;font-size:24px;line-height:30px;">Workbench dashboard</h1>
                <div class="breakable" style="margin:3px 0;color:#475569;font-size:13px;line-height:19px;word-break:break-word;overflow-wrap:anywhere;"><strong style="color:#334155;">Organization:</strong> ${escapeHtml(organization)}</div>
                <div style="margin:3px 0;color:#475569;font-size:13px;line-height:19px;"><strong style="color:#334155;">Date range:</strong> ${escapeHtml(dateRange)}</div>
                <div class="breakable" style="margin:3px 0;color:#64748b;font-size:12px;line-height:18px;word-break:break-word;overflow-wrap:anywhere;"><strong>Generated at:</strong> ${escapeHtml(generatedAt)}</div>
              </div>

              <div style="padding-top:22px;">
                <h2 style="margin:0 0 10px;color:#0f172a;font-size:17px;line-height:22px;">Summary</h2>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;table-layout:fixed;overflow:hidden;">
                  ${summaryRows.join("")}
                </table>
              </div>

              <div style="padding-top:22px;">
                <h2 style="margin:0 0 10px;color:#0f172a;font-size:17px;line-height:22px;">Workstation detail</h2>
                <div class="mobile-detail" style="display:block;">${mobileRows}</div>
                <table class="desktop-detail" aria-label="Workstation detail" width="100%" cellpadding="0" cellspacing="0" style="display:none;width:100%;border:1px solid #cbd5e1;background:#ffffff;table-layout:fixed;">
                  <thead>
                    <tr>
                      ${htmlHeaderCell("Source")}
                      ${htmlHeaderCell("Workstation")}
                      ${htmlHeaderCell("Personnel")}
                      ${htmlHeaderCell("Source repos (first 2)")}
                      ${htmlHeaderCell("Datasets", "right")}
                      ${htmlHeaderCell("WS hours", "right")}
                      ${htmlHeaderCell("Avg target", "right")}
                      ${htmlHeaderCell("Rate", "right")}
                      ${htmlHeaderCell("Rule")}
                      ${htmlHeaderCell("Reward", "right")}
                    </tr>
                  </thead>
                  <tbody>${desktopRows}</tbody>
                </table>
              </div>

              <div style="padding-top:22px;">
                <h2 style="margin:0 0 10px;color:#0f172a;font-size:17px;line-height:22px;">Personnel workload</h2>
                <div class="mobile-detail" style="display:block;">
                  ${mobilePersonnelRows}
                  <div style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#f1f5f9;color:#0f172a;font-size:13px;font-weight:700;text-align:right;">Personnel bonus total: ${escapeHtml(formatSignedNumber(input.personnelBonusTotal))}</div>
                </div>
                <table class="desktop-detail" aria-label="Personnel workload" width="100%" cellpadding="0" cellspacing="0" style="display:none;width:100%;border:1px solid #cbd5e1;background:#ffffff;table-layout:fixed;">
                  <thead>
                    <tr>
                      ${htmlHeaderCell("Personnel")}
                      ${htmlHeaderCell("Workstation")}
                      ${htmlHeaderCell("Avg hours", "right")}
                      ${htmlHeaderCell("Avg target", "right")}
                      ${htmlHeaderCell("Rate", "right")}
                      ${htmlHeaderCell("Rule")}
                      ${htmlHeaderCell("Reward", "right")}
                      ${htmlHeaderCell("Email")}
                    </tr>
                  </thead>
                  <tbody>${desktopPersonnelRows}</tbody>
                  <tfoot>
                    <tr>
                      <td colspan="6" style="padding:10px 7px;background:#f1f5f9;color:#334155;font-size:11px;font-weight:700;text-align:right;">Personnel bonus total</td>
                      <td style="padding:10px 7px;background:#f1f5f9;color:#0f172a;font-size:11px;font-weight:700;text-align:right;">${escapeHtml(formatSignedNumber(input.personnelBonusTotal))}</td>
                      <td style="background:#f1f5f9;"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              ${noteSection}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function normalizeDraft(input: unknown): WorkbenchMailDraft | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const recipient =
    typeof raw.recipient === "string"
      ? normalizeWorkbenchMailRecipients(raw.recipient)
      : "";
  const subject = cleanText(raw.subject);
  if (!recipient || !subject) return null;
  return {
    sender: WORKBENCH_MAIL_SENDER,
    recipient,
    subject,
    // Legacy drafts used `body` for generated Markdown. It is deliberately not
    // migrated into the user-authored note field.
    note: typeof raw.note === "string" ? raw.note : "",
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

export function createDefaultWorkbenchMailDraft(
  input: {
    organization?: string;
    dateRange?: WorkbenchDashboardMailDateRange | null;
  } = {},
): WorkbenchMailDraft {
  return {
    sender: WORKBENCH_MAIL_SENDER,
    recipient: WORKBENCH_MAIL_RECIPIENT,
    subject: formatWorkbenchMailSubject(input),
    note: "",
  };
}
export function formatWorkbenchMailSubject(input: {
  organization?: string | null;
  dateRange?: WorkbenchDashboardMailDateRange | null;
}): string {
  const organization = cleanInlineText(input.organization);
  const prefix = organization
    ? `XenseRobotics · ${organization} Data Collection Team Daily Report`
    : "XenseRobotics · Data Collection Team Daily Report";
  const range = normalizedMailDateRange(input.dateRange);
  if (!range) return prefix;
  if (range.days === 1) return `${prefix} · ${range.startDate}`;
  return `${prefix} · ${range.startDate} to ${range.inclusiveEndDate}`;
}
export function isWorkbenchMailSubjectAutomaticallyGenerated(
  subject: string,
): boolean {
  const normalized = subject.trim();
  return (
    WORKBENCH_MAIL_AUTO_SUBJECT_PATTERN.test(normalized) ||
    WORKBENCH_MAIL_LEGACY_SUBJECT_PATTERN.test(normalized)
  );
}
export function createWorkbenchDashboardMail(
  input: WorkbenchDashboardMailInput,
  note = "",
): MailBodies {
  return {
    textBody: createWorkbenchDashboardText(input, note),
    htmlBody: createWorkbenchDashboardHtml(input, note),
  };
}

export function validateWorkbenchMailDraft(
  draft: WorkbenchMailDraft,
): string | null {
  const recipientError = validateWorkbenchMailRecipients(draft.recipient);
  if (recipientError) return recipientError;
  if (!draft.subject.trim()) return "主题不能为空。";
  return null;
}

export function validateWorkbenchMailMessage(
  message: WorkbenchMailMessage,
): string | null {
  const recipientError = validateWorkbenchMailRecipients(message.recipient);
  if (recipientError) return recipientError;
  if (!message.subject.trim()) return "主题不能为空。";
  if (!message.textBody.trim()) return "纯文本正文不能为空。";
  if (!message.htmlBody.trim()) return "HTML 正文不能为空。";
  return null;
}

export function workbenchMailDraftStorageKey(org: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(normalizeOrg(org))}`;
}

export function readWorkbenchMailDraft(
  org: string,
  storage: WorkbenchMailDraftStorage,
  input: { dateRange?: WorkbenchDashboardMailDateRange | null } = {},
): WorkbenchMailDraft {
  const defaultDraft = createDefaultWorkbenchMailDraft({
    organization: org,
    dateRange: input.dateRange,
  });
  const raw = storage.getItem(workbenchMailDraftStorageKey(org));
  if (!raw) return defaultDraft;
  try {
    return (
      normalizeStoredRecord(JSON.parse(raw) as unknown, org) ?? defaultDraft
    );
  } catch {
    return defaultDraft;
  }
}

export function saveWorkbenchMailDraft(
  org: string,
  draft: WorkbenchMailDraft,
  storage: WorkbenchMailDraftStorage,
): WorkbenchMailDraft {
  const validationError = validateWorkbenchMailDraft(draft);
  if (validationError) throw new Error(validationError);
  const normalizedOrg = normalizeOrg(org);
  const normalizedDraft: WorkbenchMailDraft = {
    sender: WORKBENCH_MAIL_SENDER,
    recipient: normalizeWorkbenchMailRecipients(draft.recipient),
    subject: draft.subject.trim(),
    note: draft.note,
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

function formatDecimalOneHour(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "0.0 h";
  return `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

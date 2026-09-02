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

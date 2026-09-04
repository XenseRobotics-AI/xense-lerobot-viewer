"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDefaultWorkbenchMailDraft,
  createWorkbenchDashboardMail,
  formatWorkbenchMailSubject,
  isWorkbenchMailSubjectAutomaticallyGenerated,
  parseWorkbenchMailRecipients,
  readWorkbenchMailDraft,
  saveWorkbenchMailDraft,
  validateWorkbenchMailDraft,
  validateWorkbenchMailMessage,
  type WorkbenchDashboardMailInput,
  type WorkbenchMailDraft,
  type WorkbenchMailMessage,
} from "@/lib/workbench-mail-draft";

export type WorkbenchMailRecipientGroup = {
  id: string;
  label: string;
  emails: readonly string[];
};

type WorkbenchMailComposerProps = {
  organization: string;
  dashboardInput?: WorkbenchDashboardMailInput;
  recipientSuggestions?: readonly { label: string; email: string }[];
  recipientGroups?: readonly WorkbenchMailRecipientGroup[];
};

type WorkbenchMailSmokeTestResponse = {
  message?: string;
  error?: string;
  stage?: string;
  code?: string;
};

type WorkbenchSmtpPasswordResponse = {
  message?: string;
  error?: string;
  passwordFile?: string;
};

export default function WorkbenchMailComposer({
  organization,
  dashboardInput,
  recipientSuggestions = [],
  recipientGroups = [],
}: WorkbenchMailComposerProps) {
  const [draft, setDraft] = useState<WorkbenchMailDraft>(() =>
    createDefaultWorkbenchMailDraft({
      organization,
      dateRange: dashboardInput?.dateRange,
    }),
  );
  const subjectCustomizedRef = useRef(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [selectedRecipientGroup, setSelectedRecipientGroup] = useState("");
  const recipientOptions = useMemo(() => {
    const grouped = new Map<string, { email: string; labels: Set<string> }>();
    for (const item of recipientSuggestions) {
      const email = item.email.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      const option = grouped.get(key) ?? {
        email,
        labels: new Set<string>(),
      };
      if (item.label.trim()) option.labels.add(item.label.trim());
      grouped.set(key, option);
    }
    return Array.from(grouped.values()).map((option) => ({
      email: option.email,
      label: Array.from(option.labels).join("、") || option.email,
    }));
  }, [recipientSuggestions]);
  const [status, setStatus] = useState<{
    kind: "error" | "info";
    message: string;
  } | null>(null);
  const [passwordEditorOpen, setPasswordEditorOpen] = useState(false);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState<{
    kind: "error" | "info";
    message: string;
  } | null>(null);

  useEffect(() => {
    try {
      const restoredDraft = readWorkbenchMailDraft(
        organization,
        window.localStorage,
        { dateRange: dashboardInput?.dateRange },
      );
      subjectCustomizedRef.current =
        !isWorkbenchMailSubjectAutomaticallyGenerated(restoredDraft.subject);
      setDraft(restoredDraft);
    } catch {
      const defaultDraft = createDefaultWorkbenchMailDraft({
        organization,
        dateRange: dashboardInput?.dateRange,
      });
      subjectCustomizedRef.current = false;
      setDraft(defaultDraft);
    }
    setGeneratedAt(null);
    setSelectedRecipientGroup("");
    setStatus(null);
    setPasswordStatus(null);
    setSmtpPassword("");
    setPasswordEditorOpen(false);
  }, [organization]);

  const updateDraft = useCallback((patch: Partial<WorkbenchMailDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus(null);
  }, []);

  const selectedRecipientEmails = useMemo(
    () =>
      new Set(
        parseWorkbenchMailRecipients(draft.recipient).map((email) =>
          email.toLowerCase(),
        ),
      ),
    [draft.recipient],
  );

  const toggleRecipient = useCallback((email: string, checked: boolean) => {
    setDraft((current) => {
      const recipients = new Map(
        parseWorkbenchMailRecipients(current.recipient).map((recipient) => [
          recipient.toLowerCase(),
          recipient,
        ]),
      );
      if (checked) recipients.set(email.toLowerCase(), email);
      else recipients.delete(email.toLowerCase());
      return {
        ...current,
        recipient: Array.from(recipients.values()).join(", "),
      };
    });
    setStatus(null);
  }, []);

  const applyRecipientGroup = useCallback(
    (groupId: string) => {
      const group = recipientGroups.find((item) => item.id === groupId);
      if (!group) return;
      setDraft((current) => {
        const recipients = new Map(
          parseWorkbenchMailRecipients(current.recipient).map((recipient) => [
            recipient.toLowerCase(),
            recipient,
          ]),
        );
        for (const email of group.emails) {
          const normalized = email.trim();
          if (normalized) recipients.set(normalized.toLowerCase(), normalized);
        }
        return {
          ...current,
          recipient: Array.from(recipients.values()).join(", "),
        };
      });
      setSelectedRecipientGroup("");
      setStatus(null);
    },
    [recipientGroups],
  );

  const message = useMemo<WorkbenchMailMessage | null>(() => {
    if (!dashboardInput || !generatedAt) return null;
    const bodies = createWorkbenchDashboardMail(
      {
        ...dashboardInput,
        organization,
        generatedAt,
      },
      draft.note,
    );
    return {
      sender: draft.sender,
      recipient: draft.recipient,
      subject: draft.subject,
      ...bodies,
    };
  }, [dashboardInput, draft, generatedAt, organization]);

  const handleGenerateDraft = useCallback(() => {
    if (!dashboardInput) return;
    if (!subjectCustomizedRef.current) {
      setDraft((current) => ({
        ...current,
        subject: formatWorkbenchMailSubject({
          ...dashboardInput,
          organization,
        }),
      }));
    }
    setGeneratedAt(new Date().toISOString());
    setStatus(null);
  }, [dashboardInput, organization]);

  const handleSaveSmtpPassword = useCallback(async () => {
    const password = smtpPassword.trim();
    if (!password) {
      setPasswordStatus({ kind: "error", message: "SMTP 密码不能为空。" });
      return;
    }

    setPasswordSaving(true);
    setPasswordStatus(null);
    try {
      const response = await fetch("/api/workbench/smtp-password", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as WorkbenchSmtpPasswordResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      setSmtpPassword("");
      setPasswordStatus({
        kind: "info",
        message: payload.message ?? "SMTP 密码已保存。",
      });
    } catch (reason: unknown) {
      setPasswordStatus({
        kind: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setPasswordSaving(false);
    }
  }, [smtpPassword]);

  const handleSend = useCallback(async () => {
    const error = validateWorkbenchMailDraft(draft);
    if (error) {
      setStatus({ kind: "error", message: error });
      return;
    }
    if (!message) {
      setStatus({ kind: "error", message: "请先生成邮件预览。" });
      return;
    }
    const messageError = validateWorkbenchMailMessage(message);
    if (messageError) {
      setStatus({ kind: "error", message: messageError });
      return;
    }
    try {
      const next = saveWorkbenchMailDraft(
        organization,
        draft,
        window.localStorage,
      );
      setDraft(next);
      const nextMessage: WorkbenchMailMessage = {
        ...message,
        sender: next.sender,
        recipient: next.recipient,
        subject: next.subject,
      };
      const response = await fetch("/api/workbench/mail-smoke-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          org: organization,
          message: nextMessage,
        }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as WorkbenchMailSmokeTestResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? `发送失败 (${response.status})`);
      }
      setStatus({
        kind: "info",
        message: payload.message ?? "发送完成。",
      });
    } catch (reason: unknown) {
      setStatus({
        kind: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [draft, message, organization]);

  const statusTone =
    status?.kind === "error"
      ? "border-red-400/25 bg-red-400/5 text-red-100"
      : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200";
  const passwordStatusTone =
    passwordStatus?.kind === "error"
      ? "border-red-400/25 bg-red-400/5 text-red-100"
      : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200";

  return (
    <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
          邮件发送
        </h4>
        <button
          type="button"
          onClick={() => {
            setPasswordEditorOpen((value) => !value);
            setPasswordStatus(null);
          }}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
        >
          SMTP 密码
        </button>
      </div>
      {passwordEditorOpen && (
        <div className="mb-3 rounded-md border border-white/10 bg-[var(--surface-0)]/60 p-3">
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-slate-500">
              SMTP 密码
            </span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={smtpPassword}
                autoComplete="off"
                onChange={(event) => {
                  setSmtpPassword(event.target.value);
                  setPasswordStatus(null);
                }}
                placeholder="QQ 邮箱授权码"
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSaveSmtpPassword}
                disabled={passwordSaving}
                className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:opacity-50"
              >
                {passwordSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </label>
          {passwordStatus && (
            <div
              aria-live="polite"
              className={`mt-2 rounded-md border px-3 py-2 text-xs ${passwordStatusTone}`}
            >
              {passwordStatus.message}
            </div>
          )}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-slate-500">
            发件人
          </label>
          <div className="rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-sm text-slate-300 break-all">
            {draft.sender}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-slate-500">
            收件人
          </span>
          <input
            type="text"
            value={draft.recipient}
            onChange={(event) => updateDraft({ recipient: event.target.value })}
            placeholder="多个邮箱使用逗号分隔"
            className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-slate-500">
            主题
          </span>
          <input
            type="text"
            value={draft.subject}
            onChange={(event) => {
              subjectCustomizedRef.current = true;
              updateDraft({ subject: event.target.value });
            }}
            className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
          />
        </label>
        <label className="block md:col-span-2">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-slate-500">
            邮件备注
          </span>
          <textarea
            value={draft.note}
            onChange={(event) => updateDraft({ note: event.target.value })}
            rows={4}
            placeholder="可选；备注会同时出现在 HTML 邮件和纯文本兜底中。"
            className="min-h-24 w-full resize-y rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
          />
        </label>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-slate-500">
          邮件预览
        </div>
        {message ? (
          <div className="w-full overflow-hidden rounded-md border border-white/10 bg-slate-200">
            <iframe
              title="Workbench HTML 邮件预览"
              sandbox=""
              srcDoc={message.htmlBody}
              className="h-[720px] w-full border-0 bg-slate-200"
            />
          </div>
        ) : (
          <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-white/10 bg-[var(--surface-0)]/60 px-4 text-center text-xs text-slate-500">
            尚未生成邮件。生成预览后才能发送。
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {status ? (
          <div
            aria-live="polite"
            className={`rounded-md border px-3 py-2 text-xs ${statusTone}`}
          >
            {status.message}
          </div>
        ) : (
          <div />
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleGenerateDraft}
            disabled={!dashboardInput}
            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:border-cyan-300/50 hover:text-cyan-100 disabled:opacity-50"
          >
            生成/刷新预览
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!message}
            className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </div>
      {(recipientOptions.length > 0 || recipientGroups.length > 0) && (
        <fieldset className="mt-3 rounded-md border border-white/10 bg-[var(--surface-0)]/40 p-3">
          <legend className="px-1 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            收件人邮箱（可多选）
          </legend>
          {recipientGroups.length > 0 && (
            <div className="mb-3 flex flex-col gap-2 rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] p-2.5 sm:flex-row sm:items-center">
              <label
                htmlFor="workbench-recipient-group"
                className="shrink-0 text-xs font-medium text-cyan-100"
              >
                快捷分组
              </label>
              <select
                id="workbench-recipient-group"
                value={selectedRecipientGroup}
                onChange={(event) => {
                  const groupId = event.target.value;
                  setSelectedRecipientGroup(groupId);
                  applyRecipientGroup(groupId);
                }}
                className="min-w-0 flex-1 rounded-md border border-cyan-400/20 bg-[var(--surface-0)] px-3 py-2 text-xs text-slate-100 focus:border-cyan-300 focus:outline-none"
              >
                <option value="">选择分组，自动填充邮箱</option>
                {recipientGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.label}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-slate-500">
                选择后会合并到收件人，可重复选择
              </span>
            </div>
          )}
          <div className="mb-2 text-[11px] text-slate-500">
            也可以直接勾选人员
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {recipientOptions.map((item) => (
              <label
                key={item.email}
                className="flex items-center gap-2 text-xs text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={selectedRecipientEmails.has(
                    item.email.toLowerCase(),
                  )}
                  onChange={(event) =>
                    toggleRecipient(item.email, event.target.checked)
                  }
                />
                <span>{item.label}</span>
                <span className="text-slate-500">{item.email}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
}

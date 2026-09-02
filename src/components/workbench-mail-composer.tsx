"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createDefaultWorkbenchMailDraft,
  readWorkbenchMailDraft,
  saveWorkbenchMailDraft,
  validateWorkbenchMailDraft,
  type WorkbenchMailDraft,
} from "@/lib/workbench-mail-draft";

type WorkbenchMailComposerProps = {
  organization: string;
};

type WorkbenchMailSmokeTestResponse = {
  message?: string;
  error?: string;
  stage?: string;
  code?: string;
};

export default function WorkbenchMailComposer({
  organization,
}: WorkbenchMailComposerProps) {
  const [draft, setDraft] = useState<WorkbenchMailDraft>(() =>
    createDefaultWorkbenchMailDraft(),
  );
  const [status, setStatus] = useState<{
    kind: "error" | "info";
    message: string;
  } | null>(null);

  useEffect(() => {
    try {
      setDraft(readWorkbenchMailDraft(organization, window.localStorage));
    } catch {
      setDraft(createDefaultWorkbenchMailDraft());
    }
    setStatus(null);
  }, [organization]);

  const updateDraft = useCallback((patch: Partial<WorkbenchMailDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus(null);
  }, []);

  const handleSend = useCallback(async () => {
    const error = validateWorkbenchMailDraft(draft);
    if (error) {
      setStatus({ kind: "error", message: error });
      return;
    }
    try {
      const next = saveWorkbenchMailDraft(
        organization,
        draft,
        window.localStorage,
      );
      setDraft(next);
      const response = await fetch("/api/workbench/mail-smoke-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          org: organization,
          draft: next,
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
  }, [draft, organization]);

  const statusTone =
    status?.kind === "error"
      ? "border-red-400/25 bg-red-400/5 text-red-100"
      : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200";

  return (
    <section className="rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
          邮件发送
        </h4>
      </div>
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
            type="email"
            value={draft.recipient}
            onChange={(event) => updateDraft({ recipient: event.target.value })}
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
            onChange={(event) => updateDraft({ subject: event.target.value })}
            className="w-full rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
          />
        </label>
        <label className="block md:col-span-2">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.14em] text-slate-500">
            正文
          </span>
          <textarea
            value={draft.body}
            onChange={(event) => updateDraft({ body: event.target.value })}
            rows={6}
            className="min-h-32 w-full resize-y rounded-md border border-white/10 bg-[var(--surface-0)] px-3 py-2 text-slate-100 focus:border-cyan-400 focus:outline-none"
          />
        </label>
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
        <button
          type="button"
          onClick={handleSend}
          className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15"
        >
          发送
        </button>
      </div>
    </section>
  );
}

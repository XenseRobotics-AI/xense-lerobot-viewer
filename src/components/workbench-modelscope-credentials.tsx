"use client";

import { useEffect, useState } from "react";
import { FiKey, FiTrash2 } from "react-icons/fi";
import { useLocale } from "@/context/locale-context";
import {
  clearModelScopeToken,
  readModelScopeAccount,
  saveModelScopeToken,
  type ModelScopeAccount,
} from "@/utils/modelscopeAccountClient";

type Props = {
  organization: string;
};

function sourceLabel(source: ModelScopeAccount["source"], zh: boolean): string {
  if (source === "viewer") return zh ? "本机 Workbench" : "Local Workbench";
  if (source === "environment") return zh ? "环境变量" : "Environment";
  return zh ? "未配置" : "Not configured";
}

export default function WorkbenchModelScopeCredentials({
  organization,
}: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [account, setAccount] = useState<ModelScopeAccount | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    readModelScopeAccount(controller.signal, organization)
      .then(setAccount)
      .catch((reason: unknown) => {
        if ((reason as { name?: string })?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organization]);

  const save = async () => {
    const value = token.trim();
    if (!value) {
      setError(zh ? "请输入 ModelScope Token。" : "Enter a ModelScope token.");
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await saveModelScopeToken(value, undefined, organization);
      setAccount(next);
      setToken("");
      setMessage(
        zh
          ? "ModelScope Token 已保存到本机 Workbench。"
          : "ModelScope token saved to this local Workbench.",
      );
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await clearModelScopeToken(undefined, organization);
      setAccount(next);
      setMessage(
        zh
          ? "本机保存的 ModelScope Token 已清除。"
          : "The locally saved ModelScope token was cleared.",
      );
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-md border border-white/10 bg-[var(--surface-0)]/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <FiKey
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300"
          />
          <div className="min-w-0">
            <h5 className="text-xs font-semibold text-slate-200">
              {zh ? "ModelScope 凭据" : "ModelScope credentials"}
            </h5>
            <p className="mt-1 text-[11px] text-slate-500">
              {zh
                ? "仅保存到本机 Workbench，不写入共享配置。"
                : "Stored only on this Workbench machine, never in shared configuration."}
            </p>
          </div>
        </div>
        <span className="text-[10px] text-slate-500">
          {loading
            ? zh
              ? "读取中……"
              : "Loading…"
            : account
              ? `${account.tokenPresent ? (zh ? "已配置" : "Configured") : zh ? "未配置" : "Not configured"} · ${sourceLabel(account.source, zh)}`
              : zh
                ? "状态未知"
                : "Status unavailable"}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
          placeholder={zh ? "粘贴 ModelScope Token" : "Paste ModelScope token"}
          autoComplete="new-password"
          aria-label={zh ? "ModelScope Token" : "ModelScope token"}
          className="min-w-[16rem] flex-1 rounded-md border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !token.trim()}
          className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving
            ? zh
              ? "保存中……"
              : "Saving…"
            : zh
              ? "保存 Token"
              : "Save token"}
        </button>
        {account?.source === "viewer" && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={saving}
            aria-label={
              zh ? "清除本机 ModelScope Token" : "Clear local ModelScope token"
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:border-red-300/40 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
            {zh ? "清除" : "Clear"}
          </button>
        )}
      </div>
      {(error || message) && (
        <p
          role="status"
          className={`mt-2 text-[11px] ${
            error ? "text-amber-200" : "text-emerald-300"
          }`}
        >
          {error ?? message}
        </p>
      )}
    </section>
  );
}

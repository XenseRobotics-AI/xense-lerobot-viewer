"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  checkHfAccount,
  clearHfAccount,
  readHfAccount,
  type HfAccount,
} from "@/utils/hfAccountClient";

type HfWorkbenchToolbarProps = {
  /** Top-level local/Hugging Face org names, e.g. TacVerse. */
  sources?: string[];
  /** Compatibility name used by the homepage component. */
  organizations?: string[];
};

type Activity =
  | { kind: "idle" }
  | { kind: "refreshing" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

function isSafeSource(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export default function HfWorkbenchToolbar({
  sources,
  organizations,
}: HfWorkbenchToolbarProps) {
  const safeSources = useMemo(() => {
    // Keep the default Workbench source first and available even when the
    // local root is empty (there is no dataset prefix to infer yet).
    const discovered = [
      ...new Set([...(sources ?? []), ...(organizations ?? [])]),
    ]
      .filter((entry) => entry !== "TacVerse" && isSafeSource(entry))
      .sort();
    return ["TacVerse", ...discovered];
  }, [organizations, sources]);
  const [source, setSource] = useState(() => safeSources[0] ?? "");
  const [account, setAccount] = useState<HfAccount | null>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [activity, setActivity] = useState<Activity>({ kind: "idle" });
  const [accountBusy, setAccountBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!source && safeSources[0]) setSource(safeSources[0]);
    if (source && !safeSources.includes(source))
      setSource(safeSources[0] ?? "");
  }, [safeSources, source]);

  // This GET is local-only (it reports credential presence and never calls HF),
  // so it is safe during initial homepage rendering.
  useEffect(() => {
    const controller = new AbortController();
    readHfAccount(controller.signal)
      .then(setAccount)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const stopRequest = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /** Refresh the cached metadata catalog explicitly. Dataset transfer remains
   * in the Viewer's original per-source Sync panel below the corpus dashboard. */
  const refreshCatalog = useCallback(async () => {
    if (!source) {
      setActivity({ kind: "error", message: "请先选择数据源。" });
      return;
    }
    stopRequest();
    const controller = new AbortController();
    abortRef.current = controller;
    setActivity({ kind: "refreshing" });
    try {
      const response = await fetch("/api/hf/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: source }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error || `统计刷新失败（${response.status}）。`,
        );
      }
      if (!response.body) throw new Error("统计刷新没有返回结果流。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let catalogError: string | null = null;
      let catalogCount: number | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as {
              type?: string;
              error?: string;
              result?: { datasets?: unknown[] };
            };
            if (event.type === "error" && !catalogError) {
              catalogError = event.error || "统计刷新失败。";
            }
            if (
              event.type === "result" &&
              Array.isArray(event.result?.datasets)
            ) {
              catalogCount = event.result.datasets.length;
            }
          } catch {
            // Ignore malformed progress lines; the final error is authoritative.
          }
        }
      }
      if (catalogError) throw new Error(catalogError);
      setActivity({
        kind: "done",
        message:
          catalogCount === null
            ? "统计缓存已刷新。"
            : `统计缓存已刷新：${catalogCount} 个数据集。`,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setActivity({
          kind: "error",
          message: err instanceof Error ? err.message : "统计刷新失败。",
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [source, stopRequest]);

  const saveToken = useCallback(async () => {
    const value = token.trim();
    if (!value) {
      setActivity({ kind: "error", message: "请输入 Hugging Face token。" });
      return;
    }
    setAccountBusy(true);
    try {
      const next = await checkHfAccount(value, undefined, source);
      setAccount(next);
      setToken("");
      setShowToken(false);
      setActivity({ kind: "idle" });
    } catch (err) {
      setActivity({
        kind: "error",
        message: err instanceof Error ? err.message : "Token 验证失败。",
      });
    } finally {
      setAccountBusy(false);
    }
  }, [source, token]);

  const checkAccount = useCallback(async () => {
    setAccountBusy(true);
    try {
      const next = await checkHfAccount(undefined, undefined, source);
      setAccount(next);
      setActivity({ kind: "idle" });
    } catch (err) {
      setActivity({
        kind: "error",
        message: err instanceof Error ? err.message : "HF 账号检查失败。",
      });
    } finally {
      setAccountBusy(false);
    }
  }, [source]);

  const logout = useCallback(async () => {
    setAccountBusy(true);
    try {
      setAccount(await clearHfAccount());
      setActivity({ kind: "idle" });
    } catch (err) {
      setActivity({
        kind: "error",
        message: err instanceof Error ? err.message : "退出 HF 账号失败。",
      });
    } finally {
      setAccountBusy(false);
    }
  }, []);

  return (
    <section
      aria-label="Workbench Hugging Face controls"
      className="mb-8 rounded-lg border border-cyan-400/15 bg-[var(--surface-0)]/65 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
          Workbench
        </span>
        <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          数据源
          <select
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setActivity({ kind: "idle" });
            }}
            className="rounded-md border border-white/10 bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            {safeSources.length === 0 && <option value="">暂无数据源</option>}
            {safeSources.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">
            {account?.authenticated
              ? `已登录${account.username ? `：${account.username}` : ""}${
                  account.visibleDatasets === null ||
                  account.visibleDatasets === undefined
                    ? ""
                    : ` · 可见 ${account.visibleDatasets.toLocaleString()} 个数据集`
                }`
              : account?.tokenPresent
                ? "已配置 HF 凭据（点击检查账号）"
                : "未登录 HF"}
            {account?.source && account.source !== "none" && !account.username
              ? ` · ${account.source}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => setShowToken((value) => !value)}
            className="rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-primary)] hover:border-cyan-300/50"
          >
            {account?.authenticated ? "切换账号" : "HF token 登录"}
          </button>
          {account?.source === "viewer" && (
            <button
              type="button"
              disabled={accountBusy}
              onClick={logout}
              className="rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              清除本地 token
            </button>
          )}
        </div>
      </div>

      {showToken && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-white/10 bg-[var(--surface-1)]/60 p-3">
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveToken();
            }}
            placeholder="hf_…"
            autoComplete="new-password"
            className="min-w-[18rem] flex-1 rounded-md border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-cyan-300/60 focus:outline-none"
          />
          <button
            type="button"
            disabled={accountBusy}
            onClick={() => void saveToken()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
          >
            {accountBusy ? "验证中…" : "验证并保存"}
          </button>
          <p className="w-full text-[11px] text-[var(--text-faint)]">
            token 只保存到本机数据目录的 .xense-viewer/secrets，不会写入浏览器。
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-4">
        <button
          type="button"
          disabled={!source || activity.kind === "refreshing"}
          onClick={() => void refreshCatalog()}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
        >
          {activity.kind === "refreshing" ? "刷新中…" : "刷新统计"}
        </button>
        <span className="text-[11px] text-[var(--text-faint)]">
          数据集批量下载请使用下方原生 Source 面板中的 “Sync from Hugging
          Face”。
        </span>
        <button
          type="button"
          disabled={accountBusy || activity.kind === "refreshing"}
          onClick={() => void checkAccount()}
          className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          检查账号
        </button>
      </div>

      {activity.kind === "refreshing" && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          正在从 Hugging Face 刷新统计元数据…
        </p>
      )}
      {activity.kind === "done" && (
        <p className="mt-3 text-xs text-emerald-300">{activity.message}</p>
      )}
      {activity.kind === "error" && (
        <p role="alert" className="mt-3 text-xs text-red-300">
          {activity.message}
        </p>
      )}
    </section>
  );
}

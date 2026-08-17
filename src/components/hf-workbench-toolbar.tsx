"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  checkHfAccount,
  clearHfAccount,
  readHfAccount,
  type HfAccount,
} from "@/utils/hfAccountClient";
import {
  listSyncCandidates,
  runSync,
  type SyncListing,
  type SyncProgress,
} from "@/utils/syncClient";

type HfWorkbenchToolbarProps = {
  /** Top-level local/Hugging Face org names, e.g. TacVerse. */
  sources?: string[];
  /** Compatibility name used by the homepage component. */
  organizations?: string[];
};

type Activity =
  | { kind: "idle" }
  | { kind: "listing"; action: "refresh" | "new" | "all" }
  | { kind: "running"; progress: SyncProgress }
  | { kind: "done"; downloaded: number; skipped: number; failed: number }
  | { kind: "error"; message: string };

function isSafeSource(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function formatProgress(progress: SyncProgress): string {
  if (progress.phase === "preflight") return "正在检查 Hugging Face…";
  if (progress.phase === "downloading") {
    const repo = progress.repo ? ` ${progress.repo}` : "";
    const count =
      progress.index && progress.total
        ? ` (${progress.index}/${progress.total})`
        : "";
    return `正在下载${repo}${count} · ${Math.round(progress.percent ?? 0)}%`;
  }
  if (progress.phase === "complete") return "同步完成";
  return "正在准备…";
}

export default function HfWorkbenchToolbar({
  sources,
  organizations,
}: HfWorkbenchToolbarProps) {
  const router = useRouter();
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
  const [listing, setListing] = useState<SyncListing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  const loadListing = useCallback(
    async (action: "refresh" | "new" | "all") => {
      if (!source) {
        setActivity({ kind: "error", message: "请先选择数据源。" });
        return null;
      }
      stopRequest();
      const controller = new AbortController();
      abortRef.current = controller;
      setActivity({ kind: "listing", action });
      try {
        const result = await listSyncCandidates(source, controller.signal);
        setListing(result);
        const initial = new Set(result.pending);
        setSelected(initial);
        setActivity({ kind: "idle" });
        return result;
      } catch (err) {
        if (controller.signal.aborted) return null;
        setActivity({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "读取 Hugging Face 数据集失败。",
        });
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [source, stopRequest],
  );

  /** Refresh the cached metadata catalog explicitly, then run the normal
   * two-step sync listing. The cache request is never made during rendering. */
  const refreshCatalogAndListing = useCallback(async () => {
    if (!source) {
      setActivity({ kind: "error", message: "请先选择数据源。" });
      return;
    }
    stopRequest();
    const controller = new AbortController();
    abortRef.current = controller;
    setActivity({ kind: "listing", action: "refresh" });
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
            };
            if (event.type === "error" && !catalogError) {
              catalogError = event.error || "统计刷新失败。";
            }
          } catch {
            // Ignore malformed progress lines; the final error is authoritative.
          }
        }
      }
      if (catalogError) throw new Error(catalogError);
      if (abortRef.current === controller) abortRef.current = null;
      await loadListing("refresh");
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
  }, [loadListing, source, stopRequest]);

  const download = useCallback(
    async (repoIds: string[]) => {
      if (!source || repoIds.length === 0) {
        setActivity({ kind: "error", message: "请至少选择一个待下载数据集。" });
        return;
      }
      stopRequest();
      const controller = new AbortController();
      abortRef.current = controller;
      setActivity({ kind: "running", progress: { phase: "preflight" } });
      try {
        const result = await runSync(
          source,
          (progress) => setActivity({ kind: "running", progress }),
          { signal: controller.signal, repoIds },
        );
        setActivity({
          kind: "done",
          downloaded: result.downloaded,
          skipped: result.skipped,
          failed: result.failed.length,
        });
        router.refresh();
      } catch (err) {
        if (!controller.signal.aborted) {
          setActivity({
            kind: "error",
            message: err instanceof Error ? err.message : "下载失败。",
          });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [router, source, stopRequest],
  );

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

  const selectedCount = selected.size;
  const pending = listing?.pending ?? [];
  const allSelected =
    pending.length > 0 && pending.every((repo) => selected.has(repo));

  const toggleAll = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (allSelected) pending.forEach((repo) => next.delete(repo));
      else pending.forEach((repo) => next.add(repo));
      return next;
    });
  };

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
              setListing(null);
              setSelected(new Set());
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
          disabled={
            !source ||
            activity.kind === "listing" ||
            activity.kind === "running"
          }
          onClick={() => void refreshCatalogAndListing()}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
        >
          刷新统计
        </button>
        <button
          type="button"
          disabled={
            !source ||
            activity.kind === "listing" ||
            activity.kind === "running"
          }
          onClick={() => void loadListing("new")}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:border-cyan-300/50 disabled:opacity-50"
        >
          检查新增
        </button>
        <button
          type="button"
          disabled={
            !source ||
            activity.kind === "listing" ||
            activity.kind === "running"
          }
          onClick={() => void loadListing("all")}
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:border-cyan-300/50 disabled:opacity-50"
        >
          同步全部（先检查）
        </button>
        {listing && (
          <button
            type="button"
            disabled={selectedCount === 0 || activity.kind === "running"}
            onClick={() => void download([...selected])}
            className="rounded-md border border-emerald-400/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50"
          >
            下载选中（{selectedCount}）
          </button>
        )}
        <button
          type="button"
          disabled={
            accountBusy ||
            activity.kind === "listing" ||
            activity.kind === "running"
          }
          onClick={() => void checkAccount()}
          className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          检查账号
        </button>
      </div>

      {activity.kind === "listing" && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          {activity.action === "new"
            ? "正在检查新增数据集…"
            : "正在读取 Hugging Face 数据集…"}
        </p>
      )}
      {activity.kind === "running" && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-[var(--text-primary)]">
            {formatProgress(activity.progress)}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-emerald-400 transition-[width] duration-300"
              style={{
                width: `${Math.max(0, Math.min(100, activity.progress.percent ?? 0))}%`,
              }}
            />
          </div>
        </div>
      )}
      {activity.kind === "done" && (
        <p className="mt-3 text-xs text-emerald-300">
          已下载 {activity.downloaded} 个数据集 · 已跳过 {activity.skipped} 个
          {activity.failed > 0 ? ` · ${activity.failed} 个失败` : ""}
          。页面已刷新。
        </p>
      )}
      {activity.kind === "error" && (
        <p role="alert" className="mt-3 text-xs text-red-300">
          {activity.message}
        </p>
      )}

      {listing && (
        <div className="mt-4 rounded-md border border-white/10 bg-[var(--surface-1)]/35 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="text-[var(--text-primary)]">
              {source}：共 {listing.count} 个数据集，待更新{" "}
              {listing.pending.length} 个
            </p>
            <button
              type="button"
              onClick={toggleAll}
              className="text-[var(--accent)] hover:underline"
            >
              {allSelected ? "取消全选" : "全选待更新"}
            </button>
          </div>
          {listing.pending.length === 0 ? (
            <p className="mt-2 text-[11px] text-emerald-300">
              本地数据已经是最新。
            </p>
          ) : (
            <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
              {listing.pending.map((repo) => (
                <label
                  key={repo}
                  className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(repo)}
                    onChange={() =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (next.has(repo)) next.delete(repo);
                        else next.add(repo);
                        return next;
                      })
                    }
                    className="accent-cyan-400"
                  />
                  <span className="truncate font-mono">{repo}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

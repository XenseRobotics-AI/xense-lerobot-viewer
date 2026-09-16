"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/context/locale-context";
import {
  formatTransferRate,
  formatTransferred,
} from "@/components/sync-progress";
import {
  checkHfDownload,
  readHfDownloadRoot,
  startHfDownload,
} from "@/utils/hfDownloadClient";
import type {
  HfDownloadCheck,
  HfDownloadProgress,
  HfDownloadRequest,
  HfDownloadResult,
  HfDownloadScope,
} from "@/types/hf-download.types";

type HfDownloadQueueStatus =
  | "pending"
  | "checking"
  | "ready"
  | "downloading"
  | "done"
  | "skipped"
  | "failed";

type HfDownloadQueueItem = {
  source: string;
  status: HfDownloadQueueStatus;
  check: HfDownloadCheck | null;
  progress: HfDownloadProgress | null;
  result: HfDownloadResult | null;
  error: string | null;
};

type HfDownloadPanelProps = {
  endpoint: string;
  token: string;
  initialSource?: string;
};

const SOURCE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
const MIN_DOWNLOAD_CONCURRENCY = 1;
const MAX_DOWNLOAD_CONCURRENCY = 8;
const DEFAULT_QUEUE_CONCURRENCY = 2;
const MIN_QUEUE_CONCURRENCY = 1;
const MAX_QUEUE_CONCURRENCY = 3;

function parseQueueSources(value: string): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const raw of value.split(/[\r\n,]+/u)) {
    const source = raw.trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

function previewTarget(root: string, source: string): string | null {
  const cleanRoot = root.trim().replace(/\/+$/u, "");
  const cleanSource = source.trim();
  if (!cleanRoot || !SOURCE.test(cleanSource)) {
    return null;
  }
  return `${cleanRoot}/${cleanSource}`;
}

function queueStatusClass(status: HfDownloadQueueStatus): string {
  if (status === "done" || status === "skipped") {
    return "border-emerald-400/25 bg-emerald-500/10 text-emerald-200";
  }
  if (status === "failed") {
    return "border-amber-400/25 bg-amber-500/10 text-amber-200";
  }
  if (status === "checking" || status === "downloading") {
    return "border-cyan-400/25 bg-cyan-500/10 text-cyan-100";
  }
  return "border-white/10 bg-white/5 text-slate-300";
}

export default function HfDownloadPanel({
  endpoint,
  token,
  initialSource = "",
}: HfDownloadPanelProps) {
  const t = useT();
  const [source, setSource] = useState(initialSource);
  const [root, setRoot] = useState("");
  const [scope, setScope] = useState<HfDownloadScope>("all");
  const [concurrency, setConcurrency] = useState(DEFAULT_DOWNLOAD_CONCURRENCY);
  const [queueText, setQueueText] = useState("");
  const [queueConcurrency, setQueueConcurrency] = useState(
    DEFAULT_QUEUE_CONCURRENCY,
  );
  const [queueItems, setQueueItems] = useState<HfDownloadQueueItem[]>([]);
  const [queueConfirmed, setQueueConfirmed] = useState(false);
  const [queueChecking, setQueueChecking] = useState(false);
  const [queueRunning, setQueueRunning] = useState(false);
  const [check, setCheck] = useState<HfDownloadCheck | null>(null);
  const [checkedRequest, setCheckedRequest] =
    useState<HfDownloadRequest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<HfDownloadProgress | null>(null);
  const [result, setResult] = useState<HfDownloadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browseMessage, setBrowseMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const targetPreview = useMemo(
    () => previewTarget(root, source),
    [root, source],
  );
  const queueSources = useMemo(() => parseQueueSources(queueText), [queueText]);
  const queueCounts = useMemo(
    () =>
      queueItems.reduce(
        (counts, item) => {
          counts[item.status] += 1;
          return counts;
        },
        {
          pending: 0,
          checking: 0,
          ready: 0,
          downloading: 0,
          done: 0,
          skipped: 0,
          failed: 0,
        } satisfies Record<HfDownloadQueueStatus, number>,
      ),
    [queueItems],
  );
  const busy = checking || downloading || queueChecking || queueRunning;

  useEffect(() => {
    const controller = new AbortController();
    readHfDownloadRoot(controller.signal)
      .then(setRoot)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const abortOnPageExit = () => {
      abortRef.current?.abort();
    };
    // Keep downloads alive while the tab is merely backgrounded. pagehide
    // and beforeunload fire when the viewer is closed or navigated away.
    window.addEventListener("pagehide", abortOnPageExit);
    window.addEventListener("beforeunload", abortOnPageExit);
    return () => {
      window.removeEventListener("pagehide", abortOnPageExit);
      window.removeEventListener("beforeunload", abortOnPageExit);
    };
  }, []);

  useEffect(() => {
    setCheck(null);
    setCheckedRequest(null);
    setConfirmed(false);
    setResult(null);
    setProgress(null);
  }, [concurrency, endpoint, root, scope, source, token]);

  useEffect(() => {
    setQueueItems([]);
    setQueueConfirmed(false);
  }, [concurrency, endpoint, queueText, root, scope, token]);

  const request = (sourceOverride = source.trim()): HfDownloadRequest => ({
    source: sourceOverride,
    destinationRoot: root.trim(),
    scope,
    endpoint,
    concurrency,
    ...(token.trim() ? { token: token.trim() } : {}),
  });

  const browse = async () => {
    setBrowseMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/local-datasets/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDir: root,
          title: t("workbench.hfDownloadChooseRoot"),
        }),
      });
      const payload = (await response.json()) as {
        kind?: string;
        path?: string;
        reason?: string;
      };
      if (!response.ok)
        throw new Error(
          payload.reason || `Folder picker failed (${response.status}).`,
        );
      if (payload.kind === "picked" && payload.path) setRoot(payload.path);
      else if (payload.kind === "unavailable")
        setBrowseMessage(
          payload.reason || t("workbench.hfDownloadBrowseUnavailable"),
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const runCheck = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setChecking(true);
    setError(null);
    setResult(null);
    setConfirmed(false);
    try {
      const nextRequest = request();
      const nextCheck = await checkHfDownload(nextRequest, controller.signal);
      setCheckedRequest(nextRequest);
      setCheck(nextCheck);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const updateQueueItem = (
    itemSource: string,
    patch: Partial<HfDownloadQueueItem>,
  ) => {
    setQueueItems((current) =>
      current.map((item) =>
        item.source === itemSource ? { ...item, ...patch } : item,
      ),
    );
  };

  const runQueueCheck = async () => {
    const sources = queueSources;
    if (!sources.length) {
      setError(t("workbench.hfDownloadQueueEmpty"));
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setQueueChecking(true);
    setError(null);
    setQueueConfirmed(false);
    setQueueItems(
      sources.map((queuedSource) => ({
        source: queuedSource,
        status: "pending",
        check: null,
        progress: null,
        result: null,
        error: null,
      })),
    );
    try {
      for (const queuedSource of sources) {
        if (controller.signal.aborted) break;
        updateQueueItem(queuedSource, {
          status: "checking",
          check: null,
          progress: null,
          result: null,
          error: null,
        });
        try {
          const nextCheck = await checkHfDownload(
            request(queuedSource),
            controller.signal,
          );
          updateQueueItem(queuedSource, {
            status: "ready",
            check: nextCheck,
            error: null,
          });
        } catch (reason) {
          if (controller.signal.aborted) break;
          updateQueueItem(queuedSource, {
            status: "failed",
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      }
    } finally {
      if (controller.signal.aborted) {
        setError(t("workbench.hfDownloadCancelled"));
      }
      setQueueChecking(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const runDownload = async () => {
    if (!check || !checkedRequest || !confirmed) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setError(null);
    setResult(null);
    setProgress({ phase: "downloading", percent: 0 });
    let completed: HfDownloadResult | null = null;
    try {
      await startHfDownload(
        { ...checkedRequest, revisionSha: check.revisionSha },
        (event) => {
          if (event.type === "progress") setProgress(event.progress);
          else if (event.type === "result") {
            completed = event.result;
            setResult(event.result);
            setProgress((current) => ({
              ...(current ?? { phase: "promoting" }),
              percent: 100,
            }));
          } else if (event.type === "error") throw new Error(event.error);
        },
        controller.signal,
      );
      if (!completed) throw new Error(t("workbench.hfDownloadIncomplete"));
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDownloading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const runQueueDownload = async () => {
    if (!queueConfirmed) return;
    const planned = queueItems.filter(
      (item) => item.status === "ready" && item.check,
    );
    if (!planned.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setQueueRunning(true);
    setError(null);
    try {
      const runnable: HfDownloadQueueItem[] = [];
      for (const item of planned) {
        if (item.check?.matchesRevision && item.check.scopeExists) {
          updateQueueItem(item.source, {
            status: "skipped",
            progress: null,
            error: null,
          });
          continue;
        }
        runnable.push(item);
      }

      let cursor = 0;
      const downloadNext = async () => {
        for (;;) {
          if (controller.signal.aborted) break;
          const item = runnable[cursor];
          cursor += 1;
          if (!item) break;
          await downloadQueueItem(item, controller);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(queueConcurrency, runnable.length) },
          downloadNext,
        ),
      );
    } finally {
      if (controller.signal.aborted) {
        setError(t("workbench.hfDownloadCancelled"));
      }
      setQueueRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const downloadQueueItem = async (
    item: HfDownloadQueueItem,
    controller: AbortController,
  ) => {
    if (!item.check) return;
    if (controller.signal.aborted) return;
    try {
      updateQueueItem(item.source, {
        status: "downloading",
        progress: { phase: "downloading", percent: 0 },
        result: null,
        error: null,
      });
      let completed: HfDownloadResult | null = null;
      await startHfDownload(
        {
          ...request(item.source),
          revisionSha: item.check.revisionSha,
        },
        (event) => {
          if (event.type === "progress") {
            updateQueueItem(item.source, { progress: event.progress });
          } else if (event.type === "result") {
            completed = event.result;
            updateQueueItem(item.source, {
              status: "done",
              result: event.result,
              progress: { phase: "promoting", percent: 100 },
            });
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        },
        controller.signal,
      );
      if (!completed) throw new Error(t("workbench.hfDownloadIncomplete"));
      updateQueueItem(item.source, { status: "done", result: completed });
    } catch (reason) {
      if (controller.signal.aborted) return;
      updateQueueItem(item.source, {
        status: "failed",
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDownloading(false);
    setChecking(false);
    setQueueChecking(false);
    setQueueRunning(false);
    setError(t("workbench.hfDownloadCancelled"));
  };

  const queueStatusLabel = (status: HfDownloadQueueStatus): string => {
    if (status === "checking")
      return t("workbench.hfDownloadQueueCheckingStatus");
    if (status === "ready") return t("workbench.hfDownloadQueueReadyStatus");
    if (status === "downloading")
      return t("workbench.hfDownloadQueueDownloadingStatus");
    if (status === "done") return t("workbench.hfDownloadQueueDoneStatus");
    if (status === "skipped")
      return t("workbench.hfDownloadQueueSkippedStatus");
    if (status === "failed") return t("workbench.hfDownloadQueueFailedStatus");
    return t("workbench.hfDownloadQueuePendingStatus");
  };

  const percent = Math.max(
    0,
    Math.min(100, Math.round(progress?.percent ?? 0)),
  );
  const knownSize = check
    ? `${formatTransferred(check.sizeBytes)}${check.unknownSizeFiles ? ` + ${check.unknownSizeFiles.toLocaleString()} ${t("workbench.hfDownloadUnknownSizes")}` : ""}`
    : "";

  return (
    <section className="space-y-5 rounded-xl border border-cyan-400/20 bg-[var(--surface-1)]/30 p-4 sm:p-5">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">
          {t("workbench.hfDownloadTools")}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {t("workbench.hfDownloadDescription")}
        </p>
      </div>

      <div className="grid gap-4">
        <label className="grid gap-1.5 text-xs text-slate-300">
          <span>{t("workbench.hfDownloadRepoPath")}</span>
          <input
            value={source}
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
            placeholder="TacVerse/taccap-g1-flip-bound-document-0909"
            className="min-w-0 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-300/60 focus:outline-none disabled:opacity-50"
          />
          <span className="text-[11px] text-slate-500">
            {t("workbench.hfDownloadRepoHint")}
          </span>
        </label>

        <label className="grid gap-1.5 text-xs text-slate-300">
          <span>{t("workbench.hfDownloadRoot")}</span>
          <span className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              value={root}
              disabled={busy}
              onChange={(event) => setRoot(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-300/60 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void browse()}
              className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 hover:border-cyan-300/50 disabled:opacity-50"
            >
              {t("workbench.hfDownloadBrowse")}
            </button>
          </span>
          {browseMessage && (
            <span className="text-[11px] text-amber-200">{browseMessage}</span>
          )}
        </label>

        <fieldset className="rounded-lg border border-white/10 px-3 py-3">
          <legend className="px-1 text-xs text-slate-300">
            {t("workbench.hfDownloadScope")}
          </legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label className="inline-flex items-center gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name="hfDownloadScope"
                value="all"
                checked={scope === "all"}
                disabled={busy}
                onChange={() => setScope("all")}
                className="accent-cyan-400"
              />
              {t("workbench.hfDownloadAllFiles")}
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name="hfDownloadScope"
                value="meta"
                checked={scope === "meta"}
                disabled={busy}
                onChange={() => setScope("meta")}
                className="accent-cyan-400"
              />
              {t("workbench.hfDownloadMetaOnly")}
            </label>
          </div>
        </fieldset>

        <label className="grid gap-2 text-xs text-slate-300">
          <span className="flex items-center justify-between gap-3">
            <span>{t("workbench.hfDownloadConcurrency")}</span>
            <span className="tabular-nums text-cyan-200">
              {t("workbench.hfDownloadConcurrencyValue", {
                count: concurrency.toLocaleString(),
              })}
            </span>
          </span>
          <input
            type="range"
            min={MIN_DOWNLOAD_CONCURRENCY}
            max={MAX_DOWNLOAD_CONCURRENCY}
            step={1}
            value={concurrency}
            disabled={busy}
            onChange={(event) =>
              setConcurrency(Number.parseInt(event.target.value, 10))
            }
            className="accent-cyan-400"
          />
          <span className="text-[11px] leading-4 text-slate-500">
            {t("workbench.hfDownloadConcurrencyHint")}
          </span>
        </label>

        <div className="rounded-lg border border-white/10 bg-black/15 p-3 text-xs">
          <span className="text-slate-500">
            {t("workbench.hfDownloadFinalPath")}
          </span>
          <p className="mt-1 break-all font-mono text-slate-200">
            {check?.targetPath ||
              targetPreview ||
              t("workbench.hfDownloadInvalidPreview")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !targetPreview}
          onClick={() => void runCheck()}
          className="rounded-md bg-cyan-400/80 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking
            ? t("workbench.hfDownloadChecking")
            : t("workbench.hfDownloadCheck")}
        </button>
        {busy && (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 hover:text-white"
          >
            {t("workbench.hfDownloadCancel")}
          </button>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-white/10 bg-black/10 p-3 text-xs text-slate-300">
        <label className="grid gap-1.5">
          <span>{t("workbench.hfDownloadQueueSources")}</span>
          <textarea
            value={queueText}
            disabled={busy}
            onChange={(event) => setQueueText(event.target.value)}
            placeholder={t("workbench.hfDownloadQueuePlaceholder")}
            rows={4}
            className="min-w-0 resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-300/60 focus:outline-none disabled:opacity-50"
          />
          <span className="text-[11px] text-slate-500">
            {t("workbench.hfDownloadQueueHint")}
          </span>
        </label>
        <label className="grid gap-2">
          <span className="flex items-center justify-between gap-3">
            <span>{t("workbench.hfDownloadQueueConcurrency")}</span>
            <span className="tabular-nums text-cyan-200">
              {t("workbench.hfDownloadQueueConcurrencyValue", {
                count: queueConcurrency.toLocaleString(),
              })}
            </span>
          </span>
          <input
            type="range"
            min={MIN_QUEUE_CONCURRENCY}
            max={MAX_QUEUE_CONCURRENCY}
            step={1}
            value={queueConcurrency}
            disabled={busy}
            onChange={(event) =>
              setQueueConcurrency(Number.parseInt(event.target.value, 10))
            }
            className="accent-cyan-400"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !root.trim() || queueSources.length === 0}
            onClick={() => void runQueueCheck()}
            className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {queueChecking
              ? t("workbench.hfDownloadQueueChecking")
              : t("workbench.hfDownloadQueueCheck")}
          </button>
          {queueItems.length > 0 && (
            <span className="text-[11px] text-slate-500">
              {t("workbench.hfDownloadQueueSummary", {
                ready: queueCounts.ready.toLocaleString(),
                done: queueCounts.done.toLocaleString(),
                failed: queueCounts.failed.toLocaleString(),
                skipped: queueCounts.skipped.toLocaleString(),
              })}
            </span>
          )}
        </div>

        {queueItems.length > 0 && (
          <div className="space-y-3">
            <div className="max-h-72 overflow-auto rounded-md border border-white/10">
              {queueItems.map((item) => {
                const itemPercent = Math.max(
                  0,
                  Math.min(100, Math.round(item.progress?.percent ?? 0)),
                );
                return (
                  <div
                    key={item.source}
                    className="border-b border-white/5 px-3 py-2 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="break-all font-mono text-slate-200">
                        {item.source}
                      </span>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${queueStatusClass(item.status)}`}
                      >
                        {queueStatusLabel(item.status)}
                      </span>
                    </div>
                    {item.check && (
                      <p className="mt-1 break-all text-[11px] text-slate-500">
                        {item.check.fileCount.toLocaleString()} ·{" "}
                        {formatTransferred(item.check.sizeBytes)} ·{" "}
                        <span className="font-mono">
                          {item.check.revisionSha}
                        </span>{" "}
                        ·{" "}
                        {item.check.scopeExists
                          ? item.check.matchesRevision
                            ? t("workbench.hfDownloadAlreadyCurrent")
                            : t("workbench.hfDownloadWillReplace")
                          : t("workbench.hfDownloadMissing")}
                      </p>
                    )}
                    {item.progress && item.status === "downloading" && (
                      <div className="mt-2">
                        <div
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={itemPercent}
                          className="h-1 overflow-hidden rounded-full bg-white/10"
                        >
                          <div
                            className="h-full rounded-full bg-cyan-300"
                            style={{ width: `${itemPercent}%` }}
                          />
                        </div>
                        <p className="mt-1 break-all text-[11px] text-slate-500">
                          {item.progress.currentFile ||
                            t("workbench.hfDownloadPreparing")}
                        </p>
                        <p className="mt-1 text-[11px] tabular-nums text-cyan-200/80">
                          {t("workbench.hfDownloadQueueItemProgress", {
                            done: (
                              item.progress.filesDone ?? 0
                            ).toLocaleString(),
                            total: (
                              item.progress.filesTotal ??
                              item.check?.fileCount ??
                              0
                            ).toLocaleString(),
                          })}
                          {typeof item.progress.bytes === "number"
                            ? ` · ${formatTransferred(item.progress.bytes)}`
                            : ""}
                          {item.progress.bytesPerSecond
                            ? ` · ${formatTransferRate(item.progress.bytesPerSecond)}`
                            : ""}
                        </p>
                      </div>
                    )}
                    {item.result && (
                      <p className="mt-1 break-all text-[11px] text-emerald-200">
                        {t("workbench.hfDownloadSavedTo")}{" "}
                        <span className="font-mono">
                          {item.result.targetPath}
                        </span>
                      </p>
                    )}
                    {item.error && (
                      <p className="mt-1 break-all text-[11px] text-amber-200">
                        {item.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <label className="flex items-start gap-2 rounded-md border border-white/10 p-3">
              <input
                type="checkbox"
                checked={queueConfirmed}
                disabled={busy || queueCounts.ready === 0}
                onChange={(event) => setQueueConfirmed(event.target.checked)}
                className="mt-0.5 accent-cyan-400"
              />
              <span>{t("workbench.hfDownloadQueueConfirm")}</span>
            </label>
            <button
              type="button"
              disabled={!queueConfirmed || busy || queueCounts.ready === 0}
              onClick={() => void runQueueDownload()}
              className="rounded-md bg-emerald-400/80 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {queueRunning
                ? t("workbench.hfDownloadQueueRunning")
                : t("workbench.hfDownloadQueueStart")}
            </button>
          </div>
        )}
      </div>

      {check && !result && (
        <div className="space-y-3 rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-4 text-xs text-slate-300">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">
                {t("workbench.hfDownloadRevision")}
              </dt>
              <dd className="break-all font-mono">{check.revisionSha}</dd>
            </div>
            <div>
              <dt className="text-slate-500">
                {t("workbench.hfDownloadFilesAndSize")}
              </dt>
              <dd>
                {check.fileCount.toLocaleString()} · {knownSize}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">
                {t("workbench.hfDownloadLocalState")}
              </dt>
              <dd>
                {check.scopeExists
                  ? check.matchesRevision
                    ? t("workbench.hfDownloadAlreadyCurrent")
                    : t("workbench.hfDownloadWillReplace")
                  : t("workbench.hfDownloadMissing")}
              </dd>
            </div>
          </dl>
          <label className="flex items-start gap-2 rounded-md border border-white/10 p-3">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 accent-cyan-400"
            />
            <span>
              {check.scopeExists
                ? checkedRequest?.scope === "meta"
                  ? t("workbench.hfDownloadConfirmReplaceMeta")
                  : t("workbench.hfDownloadConfirmReplace")
                : t("workbench.hfDownloadConfirmNew")}
            </span>
          </label>
          <button
            type="button"
            disabled={!confirmed || busy}
            onClick={() => void runDownload()}
            className="rounded-md bg-emerald-400/80 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading
              ? t("workbench.hfDownloadDownloading")
              : check.scopeExists
                ? checkedRequest?.scope === "meta"
                  ? t("workbench.hfDownloadReplaceMeta")
                  : t("workbench.hfDownloadReplace")
                : t("workbench.hfDownloadStart")}
          </button>
        </div>
      )}

      {progress && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-cyan-400/15 bg-cyan-400/5 p-3 text-xs text-slate-300"
        >
          <div className="flex justify-between gap-3">
            <span>
              {progress.phase === "promoting"
                ? t("workbench.hfDownloadPromoting")
                : t("workbench.hfDownloadDownloading")}
            </span>
            <span className="tabular-nums text-cyan-200">{percent}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-cyan-300 transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 break-all text-[11px] text-slate-500">
            {progress.currentFile || t("workbench.hfDownloadPreparing")}
          </p>
          {progress.activeFiles && progress.activeFiles.length > 1 && (
            <p className="mt-1 break-all text-[11px] text-slate-500">
              {t("workbench.hfDownloadActiveFiles", {
                count: progress.activeFiles.length.toLocaleString(),
                total: (progress.concurrency ?? concurrency).toLocaleString(),
              })}{" "}
              {progress.activeFiles.join(", ")}
            </p>
          )}
          <p className="mt-1 text-[11px] tabular-nums text-cyan-200/80">
            {(progress.filesDone ?? 0).toLocaleString()} /{" "}
            {(progress.filesTotal ?? check?.fileCount ?? 0).toLocaleString()}
            {typeof progress.bytes === "number"
              ? ` · ${formatTransferred(progress.bytes)}`
              : ""}
            {typeof progress.currentFileBytes === "number" &&
            typeof progress.currentFileTotalBytes === "number"
              ? ` · ${formatTransferred(progress.currentFileBytes)} / ${formatTransferred(progress.currentFileTotalBytes)}`
              : ""}
            {progress.bytesPerSecond
              ? ` · ${formatTransferRate(progress.bytesPerSecond)}`
              : ""}
          </p>
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-4 text-xs text-emerald-200">
          <p className="font-semibold">{t("workbench.hfDownloadComplete")}</p>
          <p className="mt-2 break-all">
            {t("workbench.hfDownloadSavedTo")}{" "}
            <span className="font-mono">{result.targetPath}</span>
          </p>
          <p className="mt-1 break-all">
            SHA: <span className="font-mono">{result.revisionSha}</span>
          </p>
          <p className="mt-1">
            {t("workbench.hfDownloadCompletedConcurrency", {
              count: result.concurrency.toLocaleString(),
            })}
          </p>
          {result.backupPath && (
            <p className="mt-1 break-all">
              {t("workbench.hfDownloadBackupAt")}{" "}
              <span className="font-mono">{result.backupPath}</span>
            </p>
          )}
          {result.metaOnly && (
            <p className="mt-2">{t("workbench.hfDownloadMetaPreservedData")}</p>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3 text-xs text-amber-200"
        >
          {error}
        </div>
      )}
    </section>
  );
}

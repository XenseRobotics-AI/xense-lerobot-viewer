"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { browsePathCookieString } from "@/utils/browsePath";
import { useLocale } from "@/context/locale-context";

/**
 * Switch which directory the homepage scans.
 *
 * `LOCAL_DATASET_ROOT` is fixed at server start, so a dataset written anywhere
 * else on the machine used to need a restart to be seen. This sits next to the
 * "Browsing …" line as one small button: it opens the list of known paths to
 * switch between, and takes a new one either from the desktop's own folder
 * dialog or typed in.
 *
 * The choice is a cookie, read on the next server render. The default root
 * stays the anchor for the stores (locations list, corpus history, trash) —
 * only the scan follows the selection.
 *
 * **The switch has to show that it is working.** Applying it means a fresh
 * server scan of the chosen directory, and that is seconds-to-minutes on a big
 * archive over slow storage (a 612-dataset exFAT USB drive here measured 46 s
 * with a warm dentry cache). `router.refresh()` on its own paints nothing while
 * that runs: the popover closed, the old listing stayed, and the only honest
 * reading was that the button did nothing. So the refresh runs inside a
 * transition, the popover stays open until the new path lands, and a scan that
 * comes back on a *different* path than asked — an unlisted location the server
 * refuses, falling back to the root — says so instead of looking identical to
 * success.
 */

type Message = { tone: "ok" | "error"; text: string };

type PickResult =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: string };

export default function DatasetPathSwitcher({
  root,
  browsePath,
  locations,
}: {
  root: string;
  browsePath: string;
  locations: string[];
}) {
  const { t, tRich } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPending, startTransition] = useTransition();
  /** The path a refresh is currently in flight for, or null. */
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const sawPending = useRef(false);
  /** The target whose apparent failure has already been checked with the server. */
  const verified = useRef<string | null>(null);
  const locked = busy || isPending;

  // Close on Escape or a click elsewhere, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    // Dismissing mid-switch would hide the only progress there is.
    if (pendingTarget !== null) return;
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, pendingTarget]);

  const switchTo = useCallback(
    (target: string) => {
      document.cookie = browsePathCookieString(target);
      setMessage(null);
      setPendingTarget(target);
      // Inside a transition so `isPending` covers the server scan; the popover
      // is closed by the effect below, once the new path is actually rendered.
      startTransition(() => router.refresh());
    },
    [router],
  );

  useEffect(() => {
    if (isPending) sawPending.current = true;
  }, [isPending]);

  useEffect(() => {
    if (pendingTarget === null) return;
    if (browsePath === pendingTarget) {
      sawPending.current = false;
      verified.current = null;
      setPendingTarget(null);
      setOpen(false);
      return;
    }
    if (isPending || !sawPending.current) return;
    if (verified.current === pendingTarget) return;
    verified.current = pendingTarget;

    // The transition has settled on a path other than the one asked for, which
    // *looks* like `resolveBrowsePath` refusing the cookie and falling back to
    // the root — silent before, and indistinguishable from "the button does
    // nothing". But `isPending` is only as trustworthy as React keeping the
    // refresh's suspended tree inside this transition, so the refusal is
    // confirmed against the store rather than inferred: the root is always
    // accepted, and any other path is honoured exactly when it is still listed.
    // If it is listed, the refresh simply has not landed yet — keep waiting.
    const target = pendingTarget;
    void (async () => {
      if (target === root) return;
      try {
        const response = await fetch("/api/local-datasets/locations");
        const data = (await response.json()) as {
          locations?: { path?: string }[];
        };
        if (!response.ok) return;
        if (data.locations?.some((entry) => entry?.path === target)) return;
      } catch {
        return; // can't confirm a refusal, so don't claim one
      }
      sawPending.current = false;
      setPendingTarget((current) => (current === target ? null : current));
      setMessage({
        tone: "error",
        text: t("pathswitch.notSwitched", { path: target }),
      });
    })();
  }, [browsePath, isPending, pendingTarget, root, t]);

  /** Remember a path and switch to it in one go — that is why it was chosen. */
  const rememberAndSwitch = useCallback(
    async (value: string) => {
      const target = value.trim();
      if (!target) return;
      setBusy(true);
      setMessage(null);
      try {
        const response = await fetch("/api/local-datasets/locations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target }),
        });
        const data = (await response.json()) as {
          inspection?: { path: string };
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? response.statusText);
        setInput("");
        switchTo(data.inspection?.path ?? target);
      } catch (err) {
        setMessage({ tone: "error", text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [switchTo],
  );

  /**
   * Ask the server to open the desktop's folder dialog. Only a browser on the
   * same machine gets one — anywhere else it would appear on a screen the
   * person cannot see, and the answer is to type the path.
   */
  const chooseFolder = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/local-datasets/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDir: input.trim() || browsePath,
          title: t("pathswitch.dialogTitle"),
        }),
      });
      const result = (await response.json()) as PickResult & { error?: string };
      if (result.kind === "picked") {
        setInput(result.path);
        await rememberAndSwitch(result.path);
        return;
      }
      if (result.kind === "unavailable") {
        setMessage({
          tone: "error",
          text: t("pathswitch.dialogUnavailable", { reason: result.reason }),
        });
      }
    } catch (err) {
      setMessage({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }, [browsePath, input, t, rememberAndSwitch]);

  const remove = useCallback(
    async (target: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const response = await fetch("/api/local-datasets/locations", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target }),
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? response.statusText);
        // Removing the path in view would leave the page scanning something
        // the switcher no longer offers, so fall back to the root.
        if (target === browsePath) switchTo(root);
        else router.refresh();
      } catch (err) {
        setMessage({ tone: "error", text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [browsePath, root, router, switchTo],
  );

  const entries = [root, ...locations];

  return (
    <div ref={containerRef} className="relative inline-block align-middle">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        title={t("pathswitch.title")}
        className="ml-2 inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 align-middle text-[11px] font-medium text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path d="M3 5.5A1.5 1.5 0 014.5 4h3.19a1.5 1.5 0 011.06.44l.81.81h5.94A1.5 1.5 0 0117 6.75v7.75a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 14.5v-9z" />
        </svg>
        {t("pathswitch.button")}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("pathswitch.title")}
          className="absolute left-0 top-full z-30 mt-2 w-[28rem] max-w-[calc(100vw-3rem)] rounded-lg border border-white/10 bg-[var(--surface-1)] p-3 text-xs shadow-xl"
        >
          <p className="mb-2 text-[var(--text-muted)]">
            {t("pathswitch.hint")}
          </p>

          {pendingTarget !== null && (
            <p
              role="status"
              className="mb-2 flex items-start gap-1.5 rounded border border-cyan-400/25 bg-cyan-500/10 px-2 py-1.5 text-cyan-100"
            >
              <span
                aria-hidden
                className="mt-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-200"
              />
              <span className="min-w-0">
                {tRich("pathswitch.switching", {
                  path: (
                    <span className="font-mono break-all">{pendingTarget}</span>
                  ),
                })}
                <span className="mt-0.5 block text-cyan-200/60">
                  {t("pathswitch.switchingHint")}
                </span>
              </span>
            </p>
          )}

          <ul className="mb-3 space-y-0.5">
            {entries.map((entry) => {
              const active = entry === browsePath;
              return (
                <li key={entry} className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => switchTo(entry)}
                    aria-current={active}
                    className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left font-mono transition-colors ${
                      active
                        ? "bg-cyan-500/15 text-cyan-200"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                    title={entry}
                  >
                    {active && <span aria-hidden>✓ </span>}
                    {entry === pendingTarget && <span aria-hidden>⋯ </span>}
                    {entry}
                    {entry === root && (
                      <span className="ml-2 font-sans text-[10px] text-slate-500">
                        {t("pathswitch.defaultRoot")}
                      </span>
                    )}
                  </button>
                  {entry !== root && (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => remove(entry)}
                      aria-label={t("pathswitch.forgetAria", { path: entry })}
                      title={t("pathswitch.forget")}
                      className="rounded px-1.5 py-1 text-slate-500 transition-colors hover:bg-red-500/80 hover:text-white"
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={locked}
              onClick={() => void chooseFolder()}
              className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              {busy ? t("pathswitch.choosing") : t("pathswitch.choose")}
            </button>
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void rememberAndSwitch(input);
              }}
              placeholder={t("pathswitch.placeholder")}
              aria-label={t("pathswitch.inputAria")}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none"
            />
            <button
              type="button"
              disabled={locked || !input.trim()}
              onClick={() => void rememberAndSwitch(input)}
              className="shrink-0 rounded-md bg-cyan-500/90 px-2 py-1 text-[11px] font-semibold text-slate-900 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("pathswitch.use")}
            </button>
          </div>

          {message && (
            <p
              role="alert"
              className={`mt-2 ${message.tone === "error" ? "text-red-300" : "text-emerald-200"}`}
            >
              {message.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

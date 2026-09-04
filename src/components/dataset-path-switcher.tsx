"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
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
  const { t } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const switchTo = useCallback(
    (target: string) => {
      document.cookie = browsePathCookieString(target);
      setOpen(false);
      setMessage(null);
      router.refresh();
    },
    [router],
  );

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

          <ul className="mb-3 space-y-0.5">
            {entries.map((entry) => {
              const active = entry === browsePath;
              return (
                <li key={entry} className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
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
                      disabled={busy}
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
              disabled={busy}
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
              disabled={busy || !input.trim()}
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

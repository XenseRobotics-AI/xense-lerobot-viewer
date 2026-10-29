"use client";

import { useEffect } from "react";
import { claimChunkReload } from "@/utils/chunkRecovery";

/**
 * Self-heal for `ChunkLoadError`.
 *
 * When Next.js rebuilds (a dev recompile/restart, or a production redeploy) the
 * hashed `_next/static/chunks/*` filenames change. A browser tab opened against
 * the previous build still references the old chunk names, so the next lazy
 * chunk load (e.g. navigating into the heavy episode route) 404s and throws
 * `ChunkLoadError`. A single full reload fetches the current manifest and fixes
 * it. Guarded against reload loops by remembering the failed asset per tab so a
 * genuinely broken chunk surfaces the normal error UI instead of looping.
 */
function reloadOnce(error: unknown): void {
  try {
    if (claimChunkReload(error, window.sessionStorage))
      window.location.reload();
  } catch {
    /* A blocked sessionStorage getter must not trigger a reload loop. */
  }
}

export default function ChunkErrorReload() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      reloadOnce(e.error ?? e.message);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      reloadOnce(e.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}

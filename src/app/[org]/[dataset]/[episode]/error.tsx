"use client";

import React, { useEffect } from "react";
import { useT } from "@/context/locale-context";
import { claimChunkReload } from "@/utils/chunkRecovery";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  // A stale client chunk (after a rebuild/redeploy) can bubble to this
  // boundary during navigation. Recover with a single guarded reload rather
  // than showing a scary error for something a refresh fixes.
  useEffect(() => {
    try {
      if (claimChunkReload(error, window.sessionStorage))
        window.location.reload();
    } catch {
      /* Render the retry UI if storage is unavailable. */
    }
  }, [error]);

  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 text-red-400">
      <div className="max-w-xl p-8 rounded bg-slate-900 border border-red-500 shadow-lg">
        <h2 className="text-2xl font-bold mb-4">{t("err.title")}</h2>
        <p className="text-lg font-mono whitespace-pre-wrap mb-4">
          {error.message}
        </p>
        <button
          className="mt-4 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          onClick={() => reset()}
        >
          {t("err.retry")}
        </button>
      </div>
    </div>
  );
}

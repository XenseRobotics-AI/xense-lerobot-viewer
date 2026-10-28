"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useT } from "@/context/locale-context";

export default function EpisodeRedirectNotice({
  requestedEpisode,
  targetEpisode,
  metadataPaths,
}: {
  requestedEpisode?: number;
  targetEpisode: number;
  metadataPaths?: string[];
}) {
  const t = useT();
  const searchParams = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  const redirected =
    requestedEpisode !== undefined &&
    searchParams.get("redirectedFromEpisode") === String(requestedEpisode);
  const nonstandardShards = Boolean(metadataPaths?.length);

  if (dismissed || (!redirected && !nonstandardShards)) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("redirectedFromEpisode");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-xl rounded-lg border border-amber-400/40 bg-[var(--surface-0)] p-4 text-sm text-amber-100 shadow-xl max-sm:left-4"
    >
      <div className="flex items-start gap-4">
        <div>
          <p className="font-medium text-amber-300">
            {t(redirected ? "ep.redirectTitle" : "ep.metadataLayoutTitle")}
          </p>
          {redirected && (
            <>
              <p className="mt-1 leading-relaxed">
                {t("ep.redirectDescription", {
                  requested: requestedEpisode!,
                  target: targetEpisode,
                })}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                {t("ep.redirectHint")}
              </p>
            </>
          )}
          {nonstandardShards && (
            <>
              <p className="mt-2 leading-relaxed">
                {t("ep.metadataLayoutDescription")}
              </p>
              <details className="mt-2 text-xs text-slate-400">
                <summary className="cursor-pointer">
                  {t("ep.metadataLayoutFiles", {
                    count: metadataPaths!.length,
                  })}
                </summary>
                <ul className="mt-1 max-h-40 overflow-y-auto break-all font-mono">
                  {metadataPaths!.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded px-2 py-1 text-xs text-amber-200 transition-colors hover:bg-amber-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          {t("ep.dismissRedirect")}
        </button>
      </div>
    </aside>
  );
}

import EpisodeViewer from "@/app/[org]/[dataset]/[episode]/episode-viewer";
import { cookies } from "next/headers";
import { resolveBrowsePath } from "@/lib/dataset-locations-store";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { BROWSE_PATH_COOKIE } from "@/utils/browsePath";
import { Suspense } from "react";
import fs from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import {
  decodeLocalDatasetPath,
  resolveServerLocalDatasetPath,
} from "@/utils/datasetRoute";
import { richInterpolate } from "@/i18n/rich";
import { getServerLocale } from "@/i18n/locale-server";
import { MESSAGES, type MessageKey } from "@/i18n/messages";
import { interpolate, type InterpolationVars } from "@/i18n/format";

type Translate = (key: MessageKey, vars?: InterpolationVars) => string;

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ encodedPath: string; episode: string }>;
}) {
  const { encodedPath, episode } = await params;
  const datasetPath = resolveServerLocalDatasetPath(
    decodeLocalDatasetPath(encodedPath),
  );
  return {
    title: `${datasetPath} | episode ${episode}`,
  };
}

type IntegrityIssue = {
  status: "empty" | "incomplete";
  reason: string;
  details: string[];
  totalEpisodes: number;
};

async function probeDatasetHealth(
  datasetDir: string,
  t: Translate,
): Promise<IntegrityIssue | null> {
  let info: { total_episodes?: number } = {};
  try {
    const raw = await fs.readFile(
      path.join(datasetDir, "meta", "info.json"),
      "utf-8",
    );
    info = JSON.parse(raw);
  } catch {
    return {
      status: "incomplete",
      reason: t("err.infoMissing"),
      details: [
        t("err.expected", { path: path.join(datasetDir, "meta", "info.json") }),
      ],
      totalEpisodes: 0,
    };
  }

  const totalEpisodes = info.total_episodes ?? 0;
  const checkDir = async (rel: string): Promise<boolean> => {
    try {
      const entries = await fs.readdir(path.join(datasetDir, rel));
      return entries.length > 0;
    } catch {
      return false;
    }
  };

  const [hasData, hasVideos] = await Promise.all([
    checkDir("data"),
    checkDir("videos"),
  ]);

  if (totalEpisodes <= 0) {
    return {
      status: "empty",
      reason: t("err.noEpisodes"),
      details: [t("err.zeroEpisodes")],
      totalEpisodes,
    };
  }

  if (!hasData || !hasVideos) {
    const missing: string[] = [];
    if (!hasData) missing.push("data/");
    if (!hasVideos) missing.push("videos/");
    return {
      status: "incomplete",
      reason: t("err.payloadMissing"),
      details: [
        t("err.payloadDetail", { count: totalEpisodes }),
        ...missing.map((m) => `  • ${path.join(datasetDir, m)}`),
      ],
      totalEpisodes,
    };
  }

  return null;
}

function IntegrityErrorPage({
  datasetPath,
  issue,
  t,
}: {
  datasetPath: string;
  issue: IntegrityIssue;
  t: Translate;
}) {
  const isError = issue.status === "incomplete";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-4 py-16">
      <div
        className={`panel-raised w-full max-w-2xl p-8 ${
          isError ? "border-red-500/50" : "border-amber-500/50"
        }`}
      >
        <div
          className={`mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
            isError
              ? "bg-red-500/20 text-red-200"
              : "bg-amber-500/20 text-amber-200"
          }`}
        >
          {isError ? t("err.incompleteBadge") : t("err.emptyBadge")}
        </div>
        <h1 className="mb-2 text-xl font-semibold text-slate-100">
          {t("err.cannotOpen")}
        </h1>
        <p
          className="mb-4 font-mono text-sm text-slate-400"
          title={datasetPath}
        >
          {datasetPath}
        </p>
        <p
          className={`mb-3 text-base ${
            isError ? "text-red-200" : "text-amber-200"
          }`}
        >
          {issue.reason}
        </p>
        <ul className="mb-6 space-y-1 text-sm text-slate-300">
          {issue.details.map((line, i) => (
            <li
              key={i}
              className="whitespace-pre-wrap break-all font-mono text-slate-400"
            >
              {line}
            </li>
          ))}
        </ul>
        <div className="rounded-md border border-white/10 bg-[var(--surface-1)]/50 p-4 text-sm text-slate-300">
          <p className="mb-2 font-medium text-slate-200">{t("err.howToFix")}</p>
          <p className="text-xs text-slate-400">
            {richInterpolate(t("err.fixHint"), {
              cmd: (
                <code className="rounded bg-black/40 px-1 py-0.5 text-cyan-200">
                  huggingface-cli download
                </code>
              ),
              data: (
                <code className="rounded bg-black/40 px-1 py-0.5 text-cyan-200">
                  data/
                </code>
              ),
              videos: (
                <code className="rounded bg-black/40 px-1 py-0.5 text-cyan-200">
                  videos/
                </code>
              ),
            })}
          </p>
        </div>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-cyan-500/90 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-400"
        >
          {t("err.back")}
        </Link>
      </div>
    </div>
  );
}

export default async function LocalEpisodePage({
  params,
}: {
  params: Promise<{ encodedPath: string; episode: string }>;
}) {
  const { encodedPath, episode } = await params;
  const episodeNumber = Number(episode.replace(/^episode_/, ""));

  // Server component — no React context here, so the dictionary is looked up
  // directly from the request's locale cookie.
  const messages = MESSAGES[await getServerLocale()];
  const t: Translate = (key, vars) => interpolate(messages[key], vars);

  const datasetPath = resolveServerLocalDatasetPath(
    decodeLocalDatasetPath(encodedPath),
  );
  const issue = await probeDatasetHealth(datasetPath, t);
  if (issue) {
    return <IntegrityErrorPage datasetPath={datasetPath} issue={issue} t={t} />;
  }

  const reviewBrowsePath = await resolveBrowsePath(
    resolveLocalDatasetRoot(),
    (await cookies()).get(BROWSE_PATH_COOKIE)?.value,
  );

  return (
    <Suspense fallback={null}>
      <EpisodeViewer
        reviewBrowsePath={reviewBrowsePath}
        org="_local"
        dataset={encodedPath}
        episodeId={episodeNumber}
      />
    </Suspense>
  );
}

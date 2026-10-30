import type { EpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data-core";
import { EPISODE_CACHE_POLICY } from "./episodeCachePolicy";
import { WorkerTaskClient, WorkerUnavailableError } from "./workerTaskClient";

export type EpisodeDecodeInput = {
  org: string;
  dataset: string;
  episodeId: number;
};
const createChannel = (name: string) =>
  new WorkerTaskClient<EpisodeDecodeInput, EpisodeData>({
    create: () =>
      new Worker(
        new URL("../workers/episode-data.worker.ts", import.meta.url),
        { type: "module", name },
      ),
    idleMs: EPISODE_CACHE_POLICY.parquetIdleTtlMs,
  });
const background = createChannel("episode-background");

export function warmEpisodeDecoder(): void {
  if (typeof window !== "undefined" && typeof Worker !== "undefined")
    background.warm();
}

export function canUseBackgroundDecoder(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    background.available
  );
}

export async function decodeEpisode(
  input: EpisodeDecodeInput,
  priority: "foreground" | "background",
  fallback: () => Promise<EpisodeData>,
): Promise<EpisodeData> {
  // Cold foreground reads avoid a large structured clone and never queue behind preloads.
  if (priority === "foreground") return fallback();
  if (typeof window === "undefined" || typeof Worker === "undefined")
    throw new WorkerUnavailableError(
      "Background decoder unavailable; load on selection",
    );
  return background.run(input);
}

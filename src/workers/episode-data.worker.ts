import { getEpisodeData } from "@/app/[org]/[dataset]/[episode]/fetch-data-core";
import type { EpisodeDecodeInput } from "@/utils/episodeDecoder";
import { estimateEpisodeBytes } from "@/utils/episodeDataCache";
import { EPISODE_CACHE_POLICY } from "@/utils/episodeCachePolicy";

const scope = self as unknown as {
  onmessage:
    | ((event: MessageEvent<{ id: number; input: EpisodeDecodeInput }>) => void)
    | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (event) => {
  const { id, input } = event.data;
  void getEpisodeData(input.org, input.dataset, input.episodeId)
    .then(
      (data) => {
        // The UI already owns the lightweight index. Do not clone it per episode.
        data.episodes = [];
        if (estimateEpisodeBytes(data) > EPISODE_CACHE_POLICY.prefetchBytes) {
          scope.postMessage({
            id,
            error:
              "Speculative episode exceeds cache budget; load on selection",
          });
          return;
        }
        scope.postMessage({ id, data });
      },
      (error: unknown) =>
        scope.postMessage({
          id,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
    .catch((error: unknown) =>
      scope.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
};

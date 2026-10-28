import fs from "node:fs/promises";
import { parquetReadObjects } from "hyparquet/src/node.js";
import {
  resolveDatasetRoot,
  resolveInsideDataset,
} from "@/lib/local-dataset-paths";
import { listV3EpisodeMetadataFiles, openParquet } from "@/lib/parquet-server";
import { bigIntToNumber } from "@/utils/typeGuards";
import { toJsonSafe } from "@/utils/parquetBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ encodedPath: string; episodeIndex: string }> },
): Promise<Response> {
  const { encodedPath, episodeIndex: rawEpisodeIndex } = await ctx.params;
  const episodeIndex = /^\d+$/.test(rawEpisodeIndex)
    ? Number(rawEpisodeIndex)
    : NaN;

  if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 0) {
    return Response.json({ error: "Invalid episode index." }, { status: 400 });
  }

  const root = resolveDatasetRoot(encodedPath);
  if (!root) return new Response("Not found", { status: 404 });

  try {
    for (const relPath of await listV3EpisodeMetadataFiles(root)) {
      const absolutePath = resolveInsideDataset(root, relPath);
      if (!absolutePath) continue;

      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const handle = await openParquet(
        absolutePath,
        relPath,
        Number(stat.size),
        stat.mtimeMs,
      );
      const rows = (await parquetReadObjects({
        file: handle.file,
        metadata: handle.metadata,
      })) as Record<string, unknown>[];

      for (const row of rows) {
        if (bigIntToNumber(row["episode_index"], -1) !== episodeIndex) continue;
        return Response.json(
          { row: toJsonSafe(row) },
          { headers: { "cache-control": "no-store" } },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

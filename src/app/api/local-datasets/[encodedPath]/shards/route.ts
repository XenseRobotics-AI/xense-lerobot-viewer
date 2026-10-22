/**
 * Lists the physical v3 episode-metadata shards in dataset order.
 *
 * This is intentionally narrower than the Parquet browser's full inventory:
 * episode loading needs to discover the first existing file without assuming
 * that it is file-000.
 */

import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import { listV3EpisodeMetadataFiles } from "@/lib/parquet-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ encodedPath: string }> },
) {
  const { encodedPath } = await ctx.params;
  if (req.url && new URL(req.url).searchParams.get("kind") !== "episode-metadata") {
    return Response.json({ error: "Unsupported shard kind." }, { status: 400 });
  }

  const root = resolveDatasetRoot(encodedPath);
  if (!root) return new Response("Not found", { status: 404 });

  return Response.json(
    { paths: await listV3EpisodeMetadataFiles(root) },
    { headers: { "cache-control": "no-store" } },
  );
}

import { getEpisodeDataSafe } from "@/app/[org]/[dataset]/[episode]/fetch-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ encodedPath: string; episodeId: string }> },
): Promise<Response> {
  const { encodedPath, episodeId: rawEpisodeId } = await ctx.params;
  const episodeId = Number.parseInt(rawEpisodeId, 10);

  if (!Number.isSafeInteger(episodeId) || episodeId < 0) {
    return Response.json({ error: "Invalid episode id." }, { status: 400 });
  }

  try {
    const result = await getEpisodeDataSafe("_local", encodedPath, episodeId);
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

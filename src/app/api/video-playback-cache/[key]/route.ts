import { NextRequest } from "next/server";
import { releaseLosslessPlaybackLease } from "@/lib/lossless-video-cache";

export const runtime = "nodejs";
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ key: string }> },
) {
  const { key } = await ctx.params;
  const lease = req.nextUrl.searchParams.get("lease") ?? "";
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{32}$/.test(lease))
    return new Response(null, { status: 400 });
  await releaseLosslessPlaybackLease(key, lease);
  return new Response(null, { status: 204 });
}

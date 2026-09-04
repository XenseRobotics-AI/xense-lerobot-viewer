import { NextRequest } from "next/server";
import { browseDirectory } from "@/lib/dataset-locations-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One directory level for the path picker. With no `path`, starts at the
 * server's home directory, which is where a person's data usually is.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const requested = request.nextUrl.searchParams.get("path")?.trim() ?? "";
  const start = requested || process.env.HOME?.trim() || "/";
  try {
    return Response.json(await browseDirectory(start));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Cannot browse path" },
      { status: 400 },
    );
  }
}

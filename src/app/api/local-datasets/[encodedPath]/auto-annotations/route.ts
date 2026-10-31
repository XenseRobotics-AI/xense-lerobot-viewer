import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { loadAutoAnnotation } from "@/lib/auto-annotations";
import {
  decodeLocalDatasetPath,
  resolveServerLocalDatasetPath,
} from "@/utils/datasetRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET `?episode=N` → TacFlow's ④ automatic annotation of that episode (read-only).
 * 404 with `{ reason }` when the dataset has no registry, no annotate result, or a malformed report.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ encodedPath: string }> },
) {
  const { encodedPath } = await params;
  const episode = Number(request.nextUrl.searchParams.get("episode"));
  if (!Number.isInteger(episode) || episode < 0) {
    return Response.json(
      { reason: "episode must be a non-negative integer" },
      { status: 400 },
    );
  }
  let datasetDir: string;
  try {
    datasetDir = path.resolve(
      resolveServerLocalDatasetPath(decodeLocalDatasetPath(encodedPath)),
    );
    if (!(await fs.stat(datasetDir)).isDirectory())
      throw new Error("not a directory");
  } catch {
    return Response.json({ reason: "dataset not found" }, { status: 404 });
  }
  const found = await loadAutoAnnotation(datasetDir, episode);
  if (found.status === "none")
    return Response.json({ reason: found.reason }, { status: 404 });
  return Response.json(found.body);
}

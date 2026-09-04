import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { pickFolder } from "@/lib/native-folder-dialog";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function startDirectory(requested: string | null): Promise<string> {
  for (const candidate of [requested?.trim(), process.env.HOME?.trim()]) {
    if (!candidate) continue;
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // fall through to the next candidate
    }
  }
  try {
    return resolveLocalDatasetRoot();
  } catch {
    return "/";
  }
}

/**
 * Open the desktop's folder dialog and answer with what was chosen.
 *
 * The window appears on the machine running the server — the one holding the
 * datasets — whichever address the browser used to get here. That is the point:
 * a browser cannot hand a page an absolute path, and this viewer is normally
 * opened by its LAN address even from the host itself. `pickFolder` allows one
 * dialog at a time, and every failure comes back as `unavailable` with a
 * reason, because the fallback (type the path) is the same for all of them.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { startDir?: unknown; title?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // an empty body is fine; the defaults below apply
  }
  const start = await startDirectory(
    typeof body.startDir === "string" ? body.startDir : null,
  );
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "Choose a dataset folder";

  return Response.json(await pickFolder(start, title));
}

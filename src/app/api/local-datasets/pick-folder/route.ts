import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { isLoopbackHost, pickFolder } from "@/lib/native-folder-dialog";
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

export async function POST(request: NextRequest): Promise<Response> {
  if (!isLoopbackHost(request.headers.get("host"))) {
    return Response.json(
      {
        kind: "unavailable",
        reason:
          "The folder dialog opens on the machine running the server, so it is only offered to a browser on that machine. Type the path instead.",
      },
      { status: 200 },
    );
  }

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

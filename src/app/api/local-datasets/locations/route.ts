import { NextRequest } from "next/server";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  addLocation,
  readLocations,
  removeLocation,
} from "@/lib/dataset-locations-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rootOrError(): { root: string } | { error: string } {
  try {
    return { root: resolveLocalDatasetRoot() };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Cannot resolve dataset root",
    };
  }
}

async function pathFromBody(request: NextRequest): Promise<string | null> {
  try {
    const body = (await request.json()) as { path?: unknown };
    return typeof body.path === "string" ? body.path : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const resolved = rootOrError();
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: 500 });
  }
  const locations = await readLocations(resolved.root);
  return Response.json({ root: resolved.root, locations });
}

export async function POST(request: NextRequest): Promise<Response> {
  const resolved = rootOrError();
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: 500 });
  }
  const value = await pathFromBody(request);
  if (!value) {
    return Response.json({ error: "Body must carry a path" }, { status: 400 });
  }
  try {
    const result = await addLocation(resolved.root, value);
    return Response.json({ root: resolved.root, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to add location" },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const resolved = rootOrError();
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: 500 });
  }
  const value = await pathFromBody(request);
  if (!value) {
    return Response.json({ error: "Body must carry a path" }, { status: 400 });
  }
  try {
    const locations = await removeLocation(resolved.root, value);
    return Response.json({ root: resolved.root, locations });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Failed to remove location",
      },
      { status: 400 },
    );
  }
}

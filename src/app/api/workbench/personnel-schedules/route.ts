import type { NextRequest } from "next/server";
import {
  readWorkbenchPersonnelConfig,
  WorkbenchPersonnelStoreError,
  writeWorkbenchPersonnelConfig,
} from "@/lib/workbench-personnel-store";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import { recordWorkbenchSharedEvent } from "@/lib/workbench-shared-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function organizationFromRequest(request: Request): string | null {
  return new URL(request.url).searchParams.get("org")?.trim() || null;
}

function errorResponse(
  error: unknown,
  fallback: string,
  status = 500,
): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : fallback },
    { status, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request): Promise<Response> {
  const org = organizationFromRequest(request);
  if (!org) {
    return errorResponse(
      new Error("Personnel mapping requires a dataset organization."),
      "Invalid organization.",
      400,
    );
  }
  try {
    return Response.json(await readWorkbenchPersonnelConfig(org), {
      headers: noStoreHeaders(),
    });
  } catch (error: unknown) {
    return errorResponse(error, "Unable to load personnel mapping.");
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return errorResponse(
      new Error("Cross-origin personnel mapping changes are not allowed."),
      "Origin rejected.",
      403,
    );
  }
  const org = organizationFromRequest(request);
  if (!org) {
    return errorResponse(
      new Error("Personnel mapping requires a dataset organization."),
      "Invalid organization.",
      400,
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      new Error("Invalid JSON body."),
      "Invalid JSON body.",
      400,
    );
  }
  try {
    const input =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "config" in body
        ? (body as { config: unknown }).config
        : body;
    const config = await writeWorkbenchPersonnelConfig(org, input);
    await recordWorkbenchSharedEvent({
      org,
      source: "workbench",
      kind: "config.personnel-mapping.updated",
      outcome: "success",
      details: {
        updatedAt: config.updatedAt,
        people: config.people,
        schedules: config.schedules,
      },
    }).catch(() => undefined);
    return Response.json(config, {
      headers: noStoreHeaders(),
    });
  } catch (error: unknown) {
    return errorResponse(
      error,
      "Unable to save personnel mapping.",
      error instanceof WorkbenchPersonnelStoreError ? 500 : 400,
    );
  }
}

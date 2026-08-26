import { NextRequest } from "next/server";
import {
  defaultWorkbenchWorkstationMappings,
  readWorkbenchWorkstationMappings,
  writeWorkbenchWorkstationMappings,
} from "@/lib/workbench-config-store";
import { isSameOriginRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function organizationFromRequest(request: Request): string | null {
  return new URL(request.url).searchParams.get("org")?.trim() || null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const org = organizationFromRequest(request);
    if (!org) {
      return Response.json(
        { error: "Workbench mappings require a dataset organization." },
        { status: 400 },
      );
    }
    const config = await readWorkbenchWorkstationMappings(org);
    return Response.json({
      ...config,
      defaults: defaultWorkbenchWorkstationMappings(org),
    });
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load Workbench workstation mappings.",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      {
        error: "Cross-origin workstation mapping changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      { status: 403 },
    );
  }

  try {
    const org = organizationFromRequest(request);
    if (!org) {
      return Response.json(
        { error: "Workbench mappings require a dataset organization." },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const mappings =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { mappings?: unknown }).mappings
        : null;
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
      return Response.json(
        { error: "A mappings object is required." },
        { status: 400 },
      );
    }

    const config = await writeWorkbenchWorkstationMappings(
      org,
      mappings as Record<string, string>,
    );
    return Response.json({
      ...config,
      defaults: defaultWorkbenchWorkstationMappings(org),
    });
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to save Workbench workstation mappings.",
      },
      { status: 500 },
    );
  }
}

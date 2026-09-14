import { readWorkbenchConfiguration } from "@/lib/workbench-configuration-store";
import { noStoreHeaders } from "@/lib/request-security";
import { legacyPersonnelConfigFromConfiguration } from "@/utils/workbenchConfiguration";

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
    const configuration = await readWorkbenchConfiguration(org);
    return Response.json(
      legacyPersonnelConfigFromConfiguration(
        org,
        configuration.config,
        configuration.updatedAt,
      ),
      { headers: noStoreHeaders() },
    );
  } catch (error: unknown) {
    return errorResponse(error, "Unable to load personnel mapping.");
  }
}

export async function PUT(): Promise<Response> {
  return Response.json(
    {
      error:
        "Personnel schedules are read-only. Save the unified configuration instead.",
      code: "LEGACY_CONFIGURATION_READ_ONLY",
      configurationEndpoint: "/api/workbench/configuration",
    },
    { status: 410, headers: noStoreHeaders() },
  );
}

import { readWorkbenchConfiguration } from "@/lib/workbench-configuration-store";
import { noStoreHeaders } from "@/lib/request-security";
import { workbenchMappingsFromConfiguration } from "@/utils/workbenchConfiguration";

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
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const configuration = await readWorkbenchConfiguration(org);
    const derived = workbenchMappingsFromConfiguration(configuration.config);
    return Response.json(
      {
        org,
        mappings: { ...derived.legacyMappings, ...derived.mappings },
        legacyMappings: derived.legacyMappings,
        source:
          configuration.source === "stored"
            ? "stored"
            : (configuration.legacySource ?? "defaults"),
        updatedAt: configuration.updatedAt,
        defaults: { ...derived.legacyMappings, ...derived.mappings },
        legacyDefaults: derived.legacyMappings,
        readOnly: true,
        configurationEndpoint: "/api/workbench/configuration",
      },
      { headers: noStoreHeaders() },
    );
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load Workbench workstation mappings.",
      },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

export async function PUT(): Promise<Response> {
  return Response.json(
    {
      error:
        "Workstation mappings are read-only. Save the unified configuration instead.",
      code: "LEGACY_CONFIGURATION_READ_ONLY",
      configurationEndpoint: "/api/workbench/configuration",
    },
    { status: 410, headers: noStoreHeaders() },
  );
}

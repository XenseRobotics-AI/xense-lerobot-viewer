import type { NextRequest } from "next/server";
import { discoverLocalDatasets } from "@/lib/local-datasets-discovery";
import {
  WorkbenchConfigurationConflictError,
  WorkbenchConfigurationValidationError,
  readWorkbenchConfiguration,
  writeWorkbenchConfiguration,
} from "@/lib/workbench-configuration-store";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import { recordWorkbenchSharedEvent } from "@/lib/workbench-shared-sync";
import { getDatasetPrefix } from "@/utils/datasetGrouping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: noStoreHeaders() });
}

function organizationFromRequest(request: Request): string | null {
  return new URL(request.url).searchParams.get("org")?.trim() || null;
}

async function organizationDatasets(org: string) {
  const discovery = await discoverLocalDatasets();
  return {
    root: discovery.root,
    datasets: discovery.datasets.filter(
      (dataset) => getDatasetPrefix(dataset.relativePath) === org,
    ),
  };
}

export async function GET(request: Request): Promise<Response> {
  const org = organizationFromRequest(request);
  if (!org) {
    return json({ error: "Configuration requires an organization." }, 400);
  }
  try {
    const observed = await organizationDatasets(org);
    return json(
      await readWorkbenchConfiguration(org, observed.root, observed.datasets),
    );
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load Workbench configuration.",
      },
      500,
    );
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return json(
      {
        error: "Cross-origin Workbench configuration changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      403,
    );
  }
  const org = organizationFromRequest(request);
  if (!org) {
    return json({ error: "Configuration requires an organization." }, 400);
  }
  const revision = request.headers.get("if-match")?.trim();
  if (!revision) {
    return json(
      {
        error: "If-Match is required when saving Workbench configuration.",
        code: "REVISION_REQUIRED",
      },
      428,
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const config =
    body && typeof body === "object" && !Array.isArray(body) && "config" in body
      ? (body as { config: unknown }).config
      : body;
  try {
    const observed = await organizationDatasets(org);
    const saved = await writeWorkbenchConfiguration(
      org,
      config,
      revision,
      observed.root,
      observed.datasets,
    );
    await recordWorkbenchSharedEvent(
      {
        org,
        source: "workbench",
        kind: "config.configuration.updated",
        outcome: "success",
        details: {
          updatedAt: saved.updatedAt,
          revision: saved.revision,
          workstations: saved.config.workstations.length,
          devices: saved.config.devices.length,
          people: saved.config.people.length,
          staffingRecords: saved.config.staffingHistory.length,
        },
      },
      observed.root,
    ).catch(() => undefined);
    return json(saved);
  } catch (error: unknown) {
    if (error instanceof WorkbenchConfigurationConflictError) {
      return json(
        {
          error: error.message,
          code: error.code,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
        409,
      );
    }
    if (error instanceof WorkbenchConfigurationValidationError) {
      return json(
        {
          error: error.message,
          code: error.code,
          diagnostics: error.diagnostics,
        },
        400,
      );
    }
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to save Workbench configuration.",
      },
      500,
    );
  }
}

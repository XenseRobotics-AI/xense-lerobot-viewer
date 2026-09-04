import { NextRequest } from "next/server";
import {
  defaultWorkbenchRewardRules,
  readWorkbenchRewardRules,
  writeWorkbenchRewardRules,
} from "@/lib/workbench-reward-store";
import { isSameOriginRequest } from "@/lib/request-security";
import { recordWorkbenchSharedEvent } from "@/lib/workbench-shared-sync";

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
        { error: "Workbench reward rules require a dataset organization." },
        { status: 400 },
      );
    }
    const config = await readWorkbenchRewardRules(org);
    return Response.json({
      ...config,
      defaults: defaultWorkbenchRewardRules(org),
    });
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load Workbench reward rules.",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      {
        error: "Cross-origin reward rule changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      { status: 403 },
    );
  }

  try {
    const org = organizationFromRequest(request);
    if (!org) {
      return Response.json(
        { error: "Workbench reward rules require a dataset organization." },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const rules =
      body && typeof body === "object" && !Array.isArray(body)
        ? ((body as { rules?: unknown }).rules ?? body)
        : null;
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
      return Response.json(
        { error: "A rules object is required." },
        { status: 400 },
      );
    }

    const config = await writeWorkbenchRewardRules(org, rules);
    await recordWorkbenchSharedEvent({
      org,
      source: "workbench",
      kind: "config.reward-rules.updated",
      outcome: "success",
      details: {
        updatedAt: config.updatedAt,
        enabled: config.enabled,
        dailyTargetHours: config.dailyTargetHours,
        levels: config.levels,
        qualityBonusByGrade: config.qualityBonusByGrade,
      },
    }).catch(() => undefined);
    return Response.json({
      ...config,
      defaults: defaultWorkbenchRewardRules(org),
    });
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to save Workbench reward rules.",
      },
      { status: 500 },
    );
  }
}

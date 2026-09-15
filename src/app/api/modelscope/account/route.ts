import { NextRequest } from "next/server";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  clearViewerModelScopeToken,
  resolveModelScopeToken,
  writeViewerModelScopeToken,
  type ModelScopeTokenSource,
} from "@/lib/modelscope-token-store";
import { isSameOriginRequest } from "@/lib/request-security";
import { normalizeHfSource } from "@/utils/hfValidation";
import {
  MODELSCOPE_DEFAULT_NAME,
  resolveModelScopeTarget,
} from "@/utils/modelscopeValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_ORG = "TacVerse";
const MAX_TOKEN_LENGTH = 4096;

type AccountRequestBody = {
  token?: unknown;
  org?: unknown;
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store, no-transform" },
  });
}

function requestOrg(request: NextRequest, body?: AccountRequestBody): string {
  const value =
    body?.org ??
    request.nextUrl.searchParams.get("org") ??
    process.env.MODELSCOPE_DATASET_REPO ??
    MODELSCOPE_DEFAULT_NAME;
  return (
    resolveModelScopeTarget(value)?.logicalOrg ??
    normalizeHfSource(value) ??
    DEFAULT_ORG
  );
}

function accountPayload(
  org: string,
  source: ModelScopeTokenSource,
  tokenPresent: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    org,
    tokenPresent,
    source: tokenPresent ? source : "none",
    ...extra,
  };
}

async function parseBody(
  request: NextRequest,
): Promise<{ body: AccountRequestBody; response?: Response }> {
  try {
    const raw = await request.text();
    if (!raw.trim()) return { body: {} };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        body: {},
        response: json(
          { error: "Expected an object body.", code: "INVALID_BODY" },
          400,
        ),
      };
    }
    return { body: value as AccountRequestBody };
  } catch {
    return {
      body: {},
      response: json(
        { error: "Expected a JSON body.", code: "INVALID_JSON" },
        400,
      ),
    };
  }
}

function rootOrError(): { root?: string; response?: Response } {
  try {
    return { root: resolveLocalDatasetRoot() };
  } catch (error: unknown) {
    return {
      response: json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Local dataset root unavailable.",
          code: "LOCAL_ROOT_UNAVAILABLE",
        },
        500,
      ),
    };
  }
}

async function saveToken(request: NextRequest): Promise<Response> {
  const parsed = await parseBody(request);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return json(
      {
        error: "A non-empty ModelScope token is required.",
        code: "INVALID_TOKEN",
      },
      400,
    );
  }
  const rootResult = rootOrError();
  if (rootResult.response) return rootResult.response;
  try {
    await writeViewerModelScopeToken(token, rootResult.root);
    return json({
      ...accountPayload(requestOrg(request, body), "viewer", true),
      saved: true,
    });
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to save ModelScope token.",
        code: "TOKEN_STORE_FAILED",
      },
      500,
    );
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const rootResult = rootOrError();
  if (rootResult.response) return rootResult.response;
  try {
    const credential = await resolveModelScopeToken(rootResult.root);
    return json(
      accountPayload(
        requestOrg(request),
        credential.source,
        Boolean(credential.token),
      ),
    );
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to read ModelScope token status.",
      },
      500,
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return json(
      {
        error: "Cross-origin account changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      403,
    );
  }
  return saveToken(request);
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return json(
      {
        error: "Cross-origin account changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      403,
    );
  }
  return saveToken(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return json(
      {
        error: "Cross-origin account changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
      403,
    );
  }
  const rootResult = rootOrError();
  if (rootResult.response) return rootResult.response;
  try {
    await clearViewerModelScopeToken(rootResult.root);
    const credential = await resolveModelScopeToken(rootResult.root);
    return json(
      accountPayload(
        requestOrg(request),
        credential.source,
        Boolean(credential.token),
        { cleared: true },
      ),
    );
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear ModelScope token.",
        code: "TOKEN_STORE_FAILED",
      },
      500,
    );
  }
}

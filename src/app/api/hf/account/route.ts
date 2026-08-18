import { NextRequest } from "next/server";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  clearViewerHfToken,
  resolveHfToken,
  writeViewerHfToken,
  type HfTokenSource,
  type ResolvedHfToken,
} from "@/lib/hf-token-store";
import {
  HF_DEFAULT_ENDPOINT,
  HfIdentityError,
  redactHfSecrets,
  runHfIdentity,
  type HfIdentityResult,
} from "@/lib/hf-identity";
import { isSameOriginRequest } from "@/lib/request-security";
import { normalizeHfSource, normalizeHfToken } from "@/utils/hfValidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_ORG = "TacVerse";

type AccountRequestBody = {
  token?: unknown;
  org?: unknown;
  whoamiOnly?: unknown;
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store, no-transform",
    },
  });
}

function defaultOrg(): string {
  return normalizeHfSource(process.env.HF_DEFAULT_ORG) ?? DEFAULT_ORG;
}

function requestOrg(request: NextRequest, body?: unknown): string | null {
  const fromBody =
    body && typeof body === "object" && "org" in body
      ? (body as AccountRequestBody).org
      : undefined;
  const fromQuery = request.nextUrl.searchParams.get("org");
  return normalizeHfSource(fromBody ?? fromQuery ?? defaultOrg());
}

function endpoint(identity?: HfIdentityResult): string {
  return (
    identity?.endpoint ||
    process.env.HF_IDENTITY_ENDPOINT?.trim() ||
    HF_DEFAULT_ENDPOINT
  );
}

/**
 * Keep account responses deliberately flat. The client toolbar reads
 * `source`/`authenticated` directly; `tokenSource` remains a compatibility
 * alias for callers that used the first API draft.
 */
function accountFromIdentity(
  org: string,
  source: HfTokenSource,
  identity: HfIdentityResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const publicSource: HfTokenSource = identity.tokenPresent ? source : "none";
  return {
    authenticated: identity.tokenValid === true,
    tokenPresent: identity.tokenPresent,
    tokenValid: identity.tokenValid,
    source: publicSource,
    tokenSource: publicSource,
    username: identity.username,
    org,
    visibleDatasets: identity.visibleDatasets,
    endpoint: endpoint(identity),
    listingError: identity.listingError ?? null,
    identityError: identity.identityError ?? null,
    ...extra,
  };
}

/** GET stays local-only; checking a token is an explicit user action. */
function accountFromCredential(
  org: string,
  credential: ResolvedHfToken,
): Record<string, unknown> {
  const source: HfTokenSource = credential.token ? credential.source : "none";
  return {
    authenticated: false,
    tokenPresent: Boolean(credential.token),
    tokenValid: null,
    source,
    tokenSource: source,
    username: null,
    org,
    visibleDatasets: null,
    endpoint: endpoint(),
    listingError: null,
    identityError: null,
  };
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

async function parseBody(
  request: NextRequest,
  allowEmpty = false,
): Promise<{ body: AccountRequestBody; response?: Response }> {
  try {
    const raw = await request.text();
    if (!raw.trim()) {
      if (allowEmpty) return { body: {} };
      return {
        body: {},
        response: json(
          { error: "Expected a JSON body.", code: "INVALID_JSON" },
          400,
        ),
      };
    }
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

function identityErrorResponse(
  error: unknown,
  secrets: readonly string[],
): Response {
  const message = redactHfSecrets(
    error instanceof HfIdentityError || error instanceof Error
      ? error.message
      : String(error),
    secrets,
  );
  return json({ error: message, code: "HF_IDENTITY_UNAVAILABLE" }, 502);
}

/**
 * Verify a credential and optionally persist an explicitly supplied token.
 * Environment/CLI credentials are usable for sync but are never copied into
 * the viewer-owned token file unless the user submits them explicitly.
 */
async function verifyAccount(
  request: NextRequest,
  persistExplicitToken: boolean,
  requireExplicitToken = false,
): Promise<Response> {
  const parsed = await parseBody(request, true);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  const hasTokenField = Object.prototype.hasOwnProperty.call(body, "token");
  if (requireExplicitToken && !hasTokenField) {
    return json(
      {
        error: "A non-empty Hugging Face token is required.",
        code: "INVALID_TOKEN",
      },
      400,
    );
  }

  const org = requestOrg(request, body);
  if (!org) {
    return json(
      { error: "Invalid Hugging Face organization name.", code: "INVALID_ORG" },
      400,
    );
  }

  const suppliedToken = normalizeHfToken(body.token);
  // Distinguish an omitted token from an explicitly malformed/blank token.
  if (hasTokenField && !suppliedToken) {
    return json(
      {
        error: "A non-empty Hugging Face token is required.",
        code: "INVALID_TOKEN",
      },
      400,
    );
  }

  const rootResult = rootOrError();
  if (rootResult.response) return rootResult.response;
  const root = rootResult.root as string;

  let credential: ResolvedHfToken;
  try {
    credential = suppliedToken
      ? { token: suppliedToken, source: "viewer" }
      : await resolveHfToken(root);
  } catch (error: unknown) {
    return identityErrorResponse(error, [
      suppliedToken ?? "",
      process.env.HF_TOKEN ?? "",
    ]);
  }

  if (!credential.token) {
    // No network request is useful without a credential. Return a normal
    // account payload so the toolbar can render the issue inline.
    return json({
      ...accountFromCredential(org, credential),
      error: "No Hugging Face token is configured.",
      code: "HF_NOT_AUTHENTICATED",
    });
  }

  let identity: HfIdentityResult;
  try {
    identity = await runHfIdentity({
      org,
      token: credential.token,
      // Token login should be quick and deterministic; the potentially large
      // organization listing belongs to the explicit "刷新统计" action.
      whoamiOnly: body.whoamiOnly === true || Boolean(suppliedToken),
    });
  } catch (error: unknown) {
    return identityErrorResponse(error, [
      credential.token,
      process.env.HF_TOKEN ?? "",
    ]);
  }

  const account = accountFromIdentity(org, credential.source, identity);
  if (identity.tokenValid !== true) {
    const detail = identity.identityError
      ? redactHfSecrets(identity.identityError, [credential.token])
      : "Hugging Face rejected this token.";
    return json({ ...account, error: detail, code: "HF_UNAUTHORIZED" }, 401);
  }

  if (persistExplicitToken && suppliedToken) {
    try {
      await writeViewerHfToken(suppliedToken, root);
    } catch (error: unknown) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to save Hugging Face token.",
          code: "TOKEN_STORE_FAILED",
        },
        500,
      );
    }
  }

  return json({
    ...account,
    saved: Boolean(persistExplicitToken && suppliedToken),
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const org = requestOrg(request);
  if (!org) {
    return json(
      { error: "Invalid Hugging Face organization name.", code: "INVALID_ORG" },
      400,
    );
  }

  const rootResult = rootOrError();
  if (rootResult.response) return rootResult.response;
  try {
    const credential = await resolveHfToken(rootResult.root as string);
    return json(accountFromCredential(org, credential));
  } catch (error: unknown) {
    return identityErrorResponse(error, [process.env.HF_TOKEN ?? ""]);
  }
}

/** Explicit account check/login used by the Workbench toolbar. */
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
  return verifyAccount(request, true);
}

/** PUT is the standards-friendly alias for POST: validate then save token. */
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
  return verifyAccount(request, true, true);
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

  const org = requestOrg(request);
  if (!org) {
    return json(
      { error: "Invalid Hugging Face organization name.", code: "INVALID_ORG" },
      400,
    );
  }
  const rootResult = rootOrError();
  if (rootResult.response) return rootResult.response;
  const root = rootResult.root as string;
  try {
    await clearViewerHfToken(root);
    const credential = await resolveHfToken(root);
    return json({ cleared: true, ...accountFromCredential(org, credential) });
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear Hugging Face token.",
        code: "TOKEN_STORE_FAILED",
      },
      500,
    );
  }
}

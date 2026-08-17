export type HfTokenSource = "viewer" | "environment" | "cache" | "none";

export type HfAccount = {
  authenticated: boolean;
  tokenPresent?: boolean;
  tokenValid?: boolean | null;
  source: HfTokenSource;
  username: string | null;
  endpoint: string | null;
  visibleDatasets?: number | null;
};

const ACCOUNT_URL = "/api/hf/account";

async function readPayload(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function accountFromPayload(payload: Record<string, unknown>): HfAccount {
  const source = payload.source;
  return {
    authenticated: payload.authenticated === true,
    tokenPresent: payload.tokenPresent === true,
    tokenValid:
      payload.tokenValid === true
        ? true
        : payload.tokenValid === false
          ? false
          : null,
    source:
      source === "viewer" || source === "environment" || source === "cache"
        ? source
        : "none",
    username: typeof payload.username === "string" ? payload.username : null,
    endpoint: typeof payload.endpoint === "string" ? payload.endpoint : null,
    visibleDatasets:
      typeof payload.visibleDatasets === "number"
        ? payload.visibleDatasets
        : null,
  };
}

/** Read local credential status; this endpoint intentionally performs no Hub request. */
export async function readHfAccount(signal?: AbortSignal): Promise<HfAccount> {
  const response = await fetch(ACCOUNT_URL, {
    method: "GET",
    signal,
    cache: "no-store",
  });
  const payload = await readPayload(response);
  if (!response.ok)
    throw new Error(String(payload.error || "Unable to read HF account."));
  return accountFromPayload(payload);
}

/** Validate an explicitly supplied token, or the configured token when omitted. */
export async function checkHfAccount(
  token?: string,
  signal?: AbortSignal,
  org?: string,
): Promise<HfAccount> {
  const response = await fetch(ACCOUNT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(token === undefined ? {} : { token }),
      ...(org ? { org } : {}),
    }),
    signal,
    cache: "no-store",
  });
  const payload = await readPayload(response);
  if (!response.ok || typeof payload.error === "string")
    throw new Error(String(payload.error || "HF account check failed."));
  return accountFromPayload(payload);
}

/** Forget only the viewer-owned token; environment/CLI credentials remain available. */
export async function clearHfAccount(signal?: AbortSignal): Promise<HfAccount> {
  const response = await fetch(ACCOUNT_URL, {
    method: "DELETE",
    signal,
    cache: "no-store",
  });
  const payload = await readPayload(response);
  if (!response.ok)
    throw new Error(String(payload.error || "Unable to clear HF token."));
  return accountFromPayload(payload);
}

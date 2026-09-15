export type ModelScopeAccount = {
  tokenPresent: boolean;
  source: "viewer" | "environment" | "none";
  saved?: boolean;
};

const ACCOUNT_URL = "/api/modelscope/account";

async function readPayload(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function accountFromPayload(
  payload: Record<string, unknown>,
): ModelScopeAccount {
  const source = payload.source;
  return {
    tokenPresent: payload.tokenPresent === true,
    source: source === "viewer" || source === "environment" ? source : "none",
    saved: payload.saved === true,
  };
}

export async function readModelScopeAccount(
  signal?: AbortSignal,
  org?: string,
): Promise<ModelScopeAccount> {
  const url = org
    ? `${ACCOUNT_URL}?org=${encodeURIComponent(org)}`
    : ACCOUNT_URL;
  const response = await fetch(url, {
    method: "GET",
    signal,
    cache: "no-store",
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(
      String(payload.error || "Unable to read ModelScope account."),
    );
  }
  return accountFromPayload(payload);
}

export async function saveModelScopeToken(
  token: string,
  signal?: AbortSignal,
  org?: string,
): Promise<ModelScopeAccount> {
  const response = await fetch(
    org ? `${ACCOUNT_URL}?org=${encodeURIComponent(org)}` : ACCOUNT_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...(org ? { org } : {}) }),
      signal,
      cache: "no-store",
    },
  );
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(
      String(payload.error || "Unable to save ModelScope token."),
    );
  }
  return accountFromPayload(payload);
}

export async function clearModelScopeToken(
  signal?: AbortSignal,
  org?: string,
): Promise<ModelScopeAccount> {
  const url = org
    ? `${ACCOUNT_URL}?org=${encodeURIComponent(org)}`
    : ACCOUNT_URL;
  const response = await fetch(url, {
    method: "DELETE",
    signal,
    cache: "no-store",
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(
      String(payload.error || "Unable to clear ModelScope token."),
    );
  }
  return accountFromPayload(payload);
}

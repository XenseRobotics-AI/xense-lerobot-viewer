import type { NextRequest } from "next/server";

/**
 * Mutating local APIs are intentionally usable from curl/tests (no Origin),
 * but reject browser requests initiated by another origin. This is a useful
 * CSRF boundary for the token and filesystem-writing endpoints without adding
 * a second user-authentication system to the local app.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export function noStoreHeaders(contentType = "application/json"): Headers {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, no-transform");
  return headers;
}

import type { NextRequest } from "next/server";

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  return first || null;
}

function normalizedProtocol(value: string | null): "http:" | "https:" | null {
  const protocol = firstHeaderValue(value)?.replace(/:$/u, "").toLowerCase();
  if (protocol === "http" || protocol === "https") return `${protocol}:`;
  return null;
}

function originForHost(
  protocol: "http:" | "https:",
  value: string | null,
): string | null {
  const host = firstHeaderValue(value);
  if (!host) return null;
  try {
    const parsed = new URL(`${protocol}//${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

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
    const parsedOrigin = new URL(origin);
    const fetchSite = request.headers
      .get("sec-fetch-site")
      ?.trim()
      .toLowerCase();

    // Sec-Fetch-Site is supplied by browsers and cannot be changed by page
    // JavaScript. It keeps the CSRF boundary accurate when a reverse proxy,
    // SSH tunnel, or Next dev server rewrites the request URL internally.
    if (fetchSite === "cross-site") return false;
    if (fetchSite === "same-origin") return true;
    if (parsedOrigin.origin === request.nextUrl.origin) return true;

    const forwardedProtocol = normalizedProtocol(
      request.headers.get("x-forwarded-proto"),
    );
    const requestProtocol = normalizedProtocol(request.nextUrl.protocol);
    const protocol = forwardedProtocol ?? requestProtocol;
    if (!protocol) return false;

    // Host is set by the HTTP server and cannot be changed by browser page
    // JavaScript. Do not use X-Forwarded-Host as an authentication signal here:
    // deployments that trust it must first have their ingress overwrite any
    // client-supplied forwarding headers. Modern browsers behind such an
    // ingress are already handled by Sec-Fetch-Site: same-origin above.
    return (
      originForHost(protocol, request.headers.get("host")) ===
      parsedOrigin.origin.toLowerCase()
    );
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

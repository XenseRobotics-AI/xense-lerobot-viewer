/**
 * The cookie naming which directory the homepage scans.
 *
 * Kept apart from `@/lib/dataset-locations-store` — that module reads the
 * filesystem, and the switcher that writes this cookie is a client component,
 * so importing the store there would drag `node:fs` into the browser bundle.
 * Same split as `@/i18n/config` versus `@/i18n/locale-server`.
 */

export const BROWSE_PATH_COOKIE = "xense-browse-path";
export const BROWSE_PATH_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function browsePathCookieString(browsePath: string): string {
  return `${BROWSE_PATH_COOKIE}=${encodeURIComponent(browsePath)}; path=/; max-age=${BROWSE_PATH_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * The cookie naming which directory the homepage scans.
 *
 * Kept apart from `@/lib/dataset-locations-store` — that module reads the
 * filesystem, and the switcher that writes this cookie is a client component,
 * so importing the store there would drag `node:fs` into the browser bundle.
 * Same split as `@/i18n/config` versus `@/i18n/locale-server`.
 */

/**
 * How many browsed directories the switcher remembers, besides the default
 * root. The list is a recency history, not an inventory: it exists so the
 * couple of paths you move between are one click away, and past three the
 * popover is a wall of absolute paths to read through instead.
 *
 * Lives here rather than in the store so the switcher can name the number in
 * its own hint without pulling `node:fs` into the browser bundle.
 */
export const MAX_REMEMBERED_LOCATIONS = 3;

export const BROWSE_PATH_COOKIE = "xense-browse-path";
export const BROWSE_PATH_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function browsePathCookieString(browsePath: string): string {
  return `${BROWSE_PATH_COOKIE}=${encodeURIComponent(browsePath)}; path=/; max-age=${BROWSE_PATH_COOKIE_MAX_AGE}; SameSite=Lax`;
}

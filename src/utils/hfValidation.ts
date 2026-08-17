/** Pure validation helpers shared by the Hugging Face account and sync routes. */

/** Hugging Face org/user names are used as a directory segment under the root. */
export const HF_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** A repo name is deliberately narrower than a full Hub URL/path. */
export const HF_REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const MAX_HF_TOKEN_LENGTH = 4096;
export const MAX_HF_REPOS_PER_REQUEST = 500;

export function isValidHfSource(value: string): boolean {
  return HF_SOURCE_PATTERN.test(value);
}

export function normalizeHfSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  return source && isValidHfSource(source) ? source : null;
}

export function normalizeHfToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > MAX_HF_TOKEN_LENGTH) return null;
  return token;
}

/**
 * Validate a selected repo list and return it in stable, duplicate-free order.
 * The route passes only repo names belonging to `source` to the Python script;
 * this prevents `repo_id.split("/").at(-1)` from becoming a path escape.
 */
export function normalizeHfRepoIds(
  value: unknown,
  source: string,
): { repoIds: string[]; error: string | null } {
  if (value === undefined) return { repoIds: [], error: null };
  if (!Array.isArray(value)) {
    return { repoIds: [], error: "`repoIds` must be an array of repo IDs." };
  }
  if (value.length > MAX_HF_REPOS_PER_REQUEST) {
    return {
      repoIds: [],
      error: `At most ${MAX_HF_REPOS_PER_REQUEST} repo IDs may be selected at once.`,
    };
  }

  const repoIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      return { repoIds: [], error: "Every repo ID must be a string." };
    }
    const repoId = raw.trim();
    const prefix = `${source}/`;
    if (!repoId.startsWith(prefix)) {
      return {
        repoIds: [],
        error: `Repo ID ${JSON.stringify(repoId)} does not belong to ${source}.`,
      };
    }
    const name = repoId.slice(prefix.length);
    if (!HF_REPO_NAME_PATTERN.test(name)) {
      return {
        repoIds: [],
        error: `Invalid repo name in ${JSON.stringify(repoId)}.`,
      };
    }
    if (!seen.has(repoId)) {
      seen.add(repoId);
      repoIds.push(repoId);
    }
  }
  return { repoIds, error: null };
}

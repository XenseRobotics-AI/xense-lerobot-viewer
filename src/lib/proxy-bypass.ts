/**
 * Merge proxy-bypass entries without discarding the user's existing rules.
 *
 * Both spellings are needed in practice: Node commonly exposes `NO_PROXY`,
 * while Python HTTP clients and proxy launchers may inspect `no_proxy`.
 */
export function mergeNoProxyValues(
  ...values: Array<string | null | undefined>
): string {
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const rawEntry of value?.split(",") ?? []) {
      const entry = rawEntry.trim();
      const key = entry.toLowerCase();
      if (!entry || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }

  return entries.join(",");
}

/**
 * hf-mirror redirects file requests to the official Hub when it sees traffic
 * arriving through some foreign proxy exits. Keep only mirror traffic direct;
 * the rest of the application's proxy configuration remains untouched.
 */
export function addHfMirrorProxyBypass(
  env: NodeJS.ProcessEnv,
  endpoint: string,
): NodeJS.ProcessEnv {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return env;
  }

  if (hostname !== "hf-mirror.com" && !hostname.endsWith(".hf-mirror.com")) {
    return env;
  }

  const noProxy = mergeNoProxyValues(
    env.NO_PROXY,
    env.no_proxy,
    "hf-mirror.com",
    ".hf-mirror.com",
  );
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

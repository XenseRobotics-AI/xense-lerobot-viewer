const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk [^\s]+ failed|Loading CSS chunk [^\s]+ failed|Failed to fetch dynamically imported module/i;
const STORAGE_KEY = "__chunk_reload_attempts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function chunkErrorKey(error: unknown): string | null {
  const entry =
    error && typeof error === "object"
      ? (error as { name?: unknown; message?: unknown; request?: unknown })
      : null;
  const message =
    typeof error === "string"
      ? error
      : typeof entry?.message === "string"
        ? entry.message
        : "";
  if (entry?.name !== "ChunkLoadError" && !CHUNK_ERROR_RE.test(message))
    return null;
  const request =
    typeof entry?.request === "string"
      ? entry.request
      : message.match(/(?:https?:\/\/[^\s)]+|\/_next\/[^\s)]+)/)?.[0];
  // Query timestamps change on every dev reload; they are the same failed asset.
  return (request ?? message).replace(/\?[^\s)]*/g, "");
}

/** One automatic reload per failed asset per tab, even if compilation is slow. */
export function claimChunkReload(error: unknown, storage: Storage): boolean {
  const key = chunkErrorKey(error);
  if (!key) return false;
  try {
    const saved = storage.getItem(STORAGE_KEY);
    let attempts: string[] = [];
    try {
      const parsed: unknown = JSON.parse(saved ?? "[]");
      if (Array.isArray(parsed))
        attempts = parsed.filter(
          (value): value is string => typeof value === "string",
        );
    } catch {
      /* Replace malformed recovery state. */
    }
    if (attempts.includes(key)) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify([...attempts, key]));
    return true;
  } catch {
    // Without persistent state a full reload cannot be protected from loops.
    return false;
  }
}

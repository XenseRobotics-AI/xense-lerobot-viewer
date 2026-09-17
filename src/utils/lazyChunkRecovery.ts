import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const CHUNK_RELOAD_KEY = "xense:chunk-reload";
const CHUNK_RELOAD_WINDOW_MS = 5 * 60 * 1000;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bChunkLoadError\b/i.test(message) ||
    /Failed to load chunk/i.test(message) ||
    /\/_next\/static\/chunks\//i.test(message)
  );
}

export function reloadOnceForChunkError(id: string, error: unknown): boolean {
  if (isChunkLoadError(error) && shouldReloadForChunkError(id)) {
    window.location.reload();
    return true;
  }
  return false;
}

function shouldReloadForChunkError(id: string): boolean {
  if (typeof window === "undefined") return false;

  const now = Date.now();
  const href = window.location.href;
  const raw = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
  if (raw) {
    try {
      const previous = JSON.parse(raw) as {
        id?: string;
        href?: string;
        ts?: number;
      };
      if (
        previous.id === id &&
        previous.href === href &&
        typeof previous.ts === "number" &&
        now - previous.ts < CHUNK_RELOAD_WINDOW_MS
      ) {
        return false;
      }
    } catch {
      // Ignore malformed state and replace it below.
    }
  }

  window.sessionStorage.setItem(
    CHUNK_RELOAD_KEY,
    JSON.stringify({ id, href, ts: now }),
  );
  return true;
}

export function lazyWithChunkRecovery<P>(
  id: string,
  loader: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    loader()
      .then((module) => {
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        }
        return module;
      })
      .catch((error: unknown) => {
        if (reloadOnceForChunkError(id, error)) {
          return new Promise<never>(() => undefined);
        }
        throw error;
      }),
  );
}

"use client";

import { useSyncExternalStore } from "react";

// All thumbnails and players share one document listener.
const subscribers = new Set<() => void>();
const changed = () => subscribers.forEach((notify) => notify());
function subscribe(notify: () => void) {
  if (!subscribers.size) document.addEventListener("visibilitychange", changed);
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (!subscribers.size)
      document.removeEventListener("visibilitychange", changed);
  };
}
export function useDocumentVisible() {
  return useSyncExternalStore(
    subscribe,
    () => !document.hidden,
    () => true,
  );
}

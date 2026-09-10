export type DatasetWriteLease = {
  id: symbol;
  kind: "hf-download" | "metadata-sync";
  label: string;
  key: string;
  startedAt: number;
};

const active = new Map<string, DatasetWriteLease>();

function normalizedKey(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function keysConflict(left: string, right: string): boolean {
  const a = normalizedKey(left);
  const b = normalizedKey(right);
  if (a === b) return true;
  if (a.endsWith("/*")) return b.startsWith(a.slice(0, -1));
  if (b.endsWith("/*")) return a.startsWith(b.slice(0, -1));
  // Legacy callers pass an org/repo label rather than an absolute target.
  // Treat it as a path prefix so metadata sync still protects its datasets.
  if (!a.startsWith("/") && (b.startsWith(`${a}/`) || b.includes(`/${a}/`))) {
    return true;
  }
  if (!b.startsWith("/") && (a.startsWith(`${b}/`) || a.includes(`/${b}/`))) {
    return true;
  }
  return false;
}

export function activeDatasetWrite(
  key?: string,
): Omit<DatasetWriteLease, "id"> | null {
  const lease = key
    ? [...active.values()].find((candidate) => keysConflict(candidate.key, key))
    : active.values().next().value;
  if (!lease) return null;
  return {
    kind: lease.kind,
    label: lease.label,
    key: lease.key,
    startedAt: lease.startedAt,
  };
}

export function beginDatasetWrite(
  kind: DatasetWriteLease["kind"],
  label: string,
  key = label,
): DatasetWriteLease | null {
  if (activeDatasetWrite(key)) return null;
  const lease = { id: Symbol(label), kind, label, key, startedAt: Date.now() };
  active.set(key, lease);
  return lease;
}

export function finishDatasetWrite(lease: DatasetWriteLease | null): void {
  if (!lease) return;
  const current = active.get(lease.key);
  if (current?.id === lease.id) active.delete(lease.key);
}

/** Test-only reset for route tests that simulate a prematurely closed stream. */
export function resetDatasetWriteLockForTests(): void {
  if (process.env.NODE_ENV === "test") active.clear();
}

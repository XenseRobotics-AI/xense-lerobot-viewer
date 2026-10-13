// Missing values must remain distinct from null for deletion detection.
const MISSING = Symbol("missing");
type Value = unknown | typeof MISSING;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: Value): string | undefined {
  if (value === MISSING) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (record(value)) {
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return JSON.stringify(value);
}

function entryKey(value: unknown, collection: string): string | null {
  if (!record(value)) return null;
  if (collection === "staffingHistory") {
    return typeof value.workstationId === "string" &&
      typeof value.effectiveDate === "string"
      ? JSON.stringify([value.workstationId, value.effectiveDate])
      : null;
  }
  const field =
    collection === "assignmentHistory" || collection === "roleHistory"
      ? "effectiveDate"
      : collection === "members"
        ? "personId"
        : "id";
  return typeof value[field] === "string" ? value[field] : null;
}

function indexEntries(values: unknown[], collection: string) {
  const entries = new Map<string, unknown>();
  for (const value of values) {
    const key = entryKey(value, collection);
    if (key === null || entries.has(key)) return null;
    entries.set(key, value);
  }
  return entries;
}

export type WorkbenchMergePreference = "local" | "remote";

/** Merge fields and keyed records against the last observed remote snapshot. */
export function mergeWorkbenchSharedData(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  base: Record<string, unknown> | null,
  preference?: WorkbenchMergePreference,
): { data: Record<string, unknown>; conflicts: string[] } {
  const conflicts: string[] = [];
  const merge = (
    localValue: Value,
    remoteValue: Value,
    baseValue: Value,
    path: string,
    field: string,
  ): Value => {
    if (canonical(localValue) === canonical(remoteValue)) return localValue;
    if (canonical(localValue) === canonical(baseValue)) return remoteValue;
    if (canonical(remoteValue) === canonical(baseValue)) return localValue;

    if (
      record(localValue) &&
      record(remoteValue) &&
      (record(baseValue) || baseValue === MISSING)
    ) {
      const ancestor = record(baseValue) ? baseValue : {};
      const keys = new Set([
        ...Object.keys(ancestor),
        ...Object.keys(localValue),
        ...Object.keys(remoteValue),
      ]);
      const output: Record<string, unknown> = {};
      for (const key of keys) {
        // workstationId is a derived legacy snapshot when history exists.
        if (
          key === "workstationId" &&
          ((Array.isArray(localValue.assignmentHistory) &&
            localValue.assignmentHistory.length > 0) ||
            (Array.isArray(remoteValue.assignmentHistory) &&
              remoteValue.assignmentHistory.length > 0))
        ) {
          output[key] = null;
          continue;
        }
        const value = merge(
          Object.prototype.hasOwnProperty.call(localValue, key)
            ? localValue[key]
            : MISSING,
          Object.prototype.hasOwnProperty.call(remoteValue, key)
            ? remoteValue[key]
            : MISSING,
          Object.prototype.hasOwnProperty.call(ancestor, key)
            ? ancestor[key]
            : MISSING,
          path ? `${path}.${key}` : key,
          key,
        );
        if (value !== MISSING) output[key] = value;
      }
      return output;
    }

    if (
      Array.isArray(localValue) &&
      Array.isArray(remoteValue) &&
      (Array.isArray(baseValue) || baseValue === MISSING)
    ) {
      const localEntries = indexEntries(localValue, field);
      const remoteEntries = indexEntries(remoteValue, field);
      const baseEntries = indexEntries(
        Array.isArray(baseValue) ? baseValue : [],
        field,
      );
      if (localEntries && remoteEntries && baseEntries) {
        const output: unknown[] = [];
        const keys = new Set([
          ...baseEntries.keys(),
          ...localEntries.keys(),
          ...remoteEntries.keys(),
        ]);
        for (const key of [...keys].sort()) {
          const value = merge(
            localEntries.has(key) ? localEntries.get(key) : MISSING,
            remoteEntries.has(key) ? remoteEntries.get(key) : MISSING,
            baseEntries.has(key) ? baseEntries.get(key) : MISSING,
            `${path}[${JSON.stringify(key)}]`,
            field,
          );
          if (value !== MISSING) output.push(value);
        }
        return output;
      }
    }

    conflicts.push(path);
    return preference === "remote" ? remoteValue : localValue;
  };
  return {
    data: merge(local, remote, base ?? MISSING, "", "") as Record<
      string,
      unknown
    >,
    conflicts,
  };
}

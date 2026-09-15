import { HF_SOURCE_PATTERN } from "@/utils/hfValidation";

export const MODELSCOPE_DEFAULT_REPO = "XenseRobotics/TacVerse";
export const MODELSCOPE_DEFAULT_OWNER = "XenseRobotics";
export const MODELSCOPE_DEFAULT_NAME = "TacVerse";

export type ModelScopeDatasetTarget = {
  owner: string;
  name: string;
  repoId: string;
  logicalOrg: string;
};

function validSegment(value: string): boolean {
  return HF_SOURCE_PATTERN.test(value);
}

export function normalizeModelScopeRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("/");
  if (
    parts.length !== 2 ||
    !parts.every((part) => validSegment(part)) ||
    !parts[0] ||
    !parts[1]
  ) {
    return null;
  }
  return `${parts[0]}/${parts[1]}`;
}

/**
 * The Workbench keeps `TacVerse` as its logical organization. ModelScope
 * stores the corpus in the nested repository `XenseRobotics/TacVerse`.
 */
export function resolveModelScopeTarget(
  value: unknown,
): ModelScopeDatasetTarget | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const configured = normalizeModelScopeRepo(
    typeof process !== "undefined"
      ? process.env.MODELSCOPE_DATASET_REPO
      : undefined,
  );
  const repoId =
    normalizeModelScopeRepo(raw) ??
    (raw === "" || raw === MODELSCOPE_DEFAULT_NAME
      ? (configured ?? MODELSCOPE_DEFAULT_REPO)
      : null);
  if (!repoId) return null;
  const [owner, name] = repoId.split("/");
  return { owner, name, repoId, logicalOrg: name };
}

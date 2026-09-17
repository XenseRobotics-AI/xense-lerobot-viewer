import { HF_SOURCE_PATTERN } from "@/utils/hfValidation";

export const MODELSCOPE_DEFAULT_REPO = "XenseRobotics/TacVerse-Raw";
export const MODELSCOPE_LEGACY_REPO = "XenseRobotics/TacVerse";
export const MODELSCOPE_DEFAULT_OWNER = "XenseRobotics";
export const MODELSCOPE_DEFAULT_NAME = "TacVerse";
export const MODELSCOPE_DEFAULT_PHYSICAL_NAME = "TacVerse-Raw";

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

function logicalOrgForRepo(owner: string, name: string): string {
  if (
    owner === MODELSCOPE_DEFAULT_OWNER &&
    (name === MODELSCOPE_DEFAULT_NAME ||
      name === MODELSCOPE_DEFAULT_PHYSICAL_NAME)
  ) {
    return MODELSCOPE_DEFAULT_NAME;
  }
  return name;
}

/**
 * The Workbench keeps `TacVerse` as its logical organization. ModelScope
 * stores the corpus in a nested repository; the current default is
 * `XenseRobotics/TacVerse-Raw`, while `XenseRobotics/TacVerse` remains a
 * supported legacy explicit target.
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
  const usesDefaultRepo =
    raw === "" ||
    raw === MODELSCOPE_DEFAULT_NAME ||
    raw === MODELSCOPE_DEFAULT_PHYSICAL_NAME;
  const repoId =
    normalizeModelScopeRepo(raw) ??
    (usesDefaultRepo ? (configured ?? MODELSCOPE_DEFAULT_REPO) : null);
  if (!repoId) return null;
  const [owner, name] = repoId.split("/");
  return { owner, name, repoId, logicalOrg: logicalOrgForRepo(owner, name) };
}

import { bucketOf } from "@/lib/dataset-facets";

export type TacverseHubCategory =
  | "taccap-g1"
  | "xtac-umi-g1"
  | "taccap-g1-merged"
  | "folder"
  | "other";
export type TacverseHubCategoryFilter = "all" | TacverseHubCategory;

export type TacverseHubCategoryCounts = Readonly<
  Record<TacverseHubCategory, number>
>;

export type TacverseHubClassificationInput = {
  repoId: string;
  robotType?: string | null;
  layout?: string | null;
  children?: readonly unknown[] | null;
};

export type TacverseHubClassification = {
  category: TacverseHubCategory;
  warning: string | null;
};

export const TACVERSE_HUB_CATEGORY_FILTERS: readonly TacverseHubCategoryFilter[] =
  Object.freeze([
    "all",
    "taccap-g1",
    "xtac-umi-g1",
    "taccap-g1-merged",
    "folder",
    "other",
  ]);

export const EMPTY_TACVERSE_HUB_CATEGORY_COUNTS: TacverseHubCategoryCounts =
  Object.freeze({
    "taccap-g1": 0,
    "xtac-umi-g1": 0,
    "taccap-g1-merged": 0,
    folder: 0,
    other: 0,
  });

const WORKBENCH_TACFLOW_DATASET_NAMES = new Set([
  "taccap-g1-insert-hook-assembly",
  "taccap-g1-press-remote-buttons",
]);
const XTAC_ROBOT_TYPES = new Set(["xtac_umi_g1", "bi_taccap_gripper"]);

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/u).filter(Boolean);
}

/** True when the final path segment ends in a real 2026 MMDD date. */
export function hasValidWorkbenchMonthDaySuffix(value: string): boolean {
  const leaf = pathSegments(value).at(-1) ?? "";
  const match = /-(\d{2})(\d{2})$/u.exec(leaf);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const candidate = new Date(Date.UTC(2026, month - 1, day));
  return (
    candidate.getUTCFullYear() === 2026 &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/** Accept only canonical `<organization>/<name>` Hub repository ids. */
export function canonicalHubRepoId(
  repoId: string,
  organization: string,
): string | null {
  const value = repoId.trim();
  const segments = value.split("/");
  if (segments.length !== 2 || segments[0] !== organization || !segments[1]) {
    return null;
  }
  return value;
}

/** Accept only canonical `TacVerse/<name>` Hub repository ids. */
export function canonicalTacverseRepoId(repoId: string): string | null {
  return canonicalHubRepoId(repoId, "TacVerse");
}

function isFolderLayout(input: TacverseHubClassificationInput): boolean {
  return input.layout === "folder" && Array.isArray(input.children);
}

/**
 * Classify a Hub repository by layout/name. Robot type is diagnostic only and
 * never changes the selected category.
 */
export function classifyTacverseHubRepository(
  input: TacverseHubClassificationInput,
): TacverseHubClassification {
  const canonical = canonicalTacverseRepoId(input.repoId);
  if (!canonical) return { category: "other", warning: null };
  const name = canonical.slice("TacVerse/".length);

  if (isFolderLayout(input)) return { category: "folder", warning: null };
  if (WORKBENCH_TACFLOW_DATASET_NAMES.has(name)) {
    return { category: "other", warning: null };
  }
  if (name.startsWith("taccap-g1-") && hasValidWorkbenchMonthDaySuffix(name)) {
    return { category: "taccap-g1", warning: null };
  }
  if (name === "xtac-umi-g1" || name.startsWith("xtac-umi-g1-")) {
    const robotType = input.robotType?.trim() || null;
    return {
      category: "xtac-umi-g1",
      warning: !XTAC_ROBOT_TYPES.has(robotType ?? "")
        ? `Expected robot_type xtac_umi_g1 or bi_taccap_gripper; found ${robotType ?? "missing robot_type"}.`
        : null,
    };
  }
  if (name.startsWith("taccap-g1-") && !/-\d{4}$/u.test(name)) {
    const robotType = input.robotType?.trim() || null;
    return {
      category: "taccap-g1-merged",
      warning:
        robotType !== "bi_taccap_gripper"
          ? `Expected robot_type bi_taccap_gripper; found ${robotType ?? "missing robot_type"}.`
          : null,
    };
  }
  return { category: "other", warning: null };
}

export function tacverseHubCategory(
  repoId: string,
  input: Omit<TacverseHubClassificationInput, "repoId"> = {},
): TacverseHubCategory {
  return classifyTacverseHubRepository({ repoId, ...input }).category;
}

export function isTacverseHubCategoryFilter(
  value: string | null | undefined,
): value is TacverseHubCategoryFilter {
  return (
    typeof value === "string" &&
    (TACVERSE_HUB_CATEGORY_FILTERS as readonly string[]).includes(value)
  );
}

/** URL state is forgiving: absent and invalid values both mean All. */
export function parseTacverseHubCategoryFilter(
  value: string | null | undefined,
): TacverseHubCategoryFilter {
  return isTacverseHubCategoryFilter(value) ? value : "all";
}

export function matchesTacverseHubCategory(
  input: string | TacverseHubClassificationInput,
  filter: TacverseHubCategoryFilter,
): boolean {
  if (filter === "all") return true;
  const classification =
    typeof input === "string"
      ? classifyTacverseHubRepository({ repoId: input })
      : classifyTacverseHubRepository(input);
  return classification.category === filter;
}

export function countTacverseHubCategories(
  inputs: readonly (string | TacverseHubClassificationInput)[],
): TacverseHubCategoryCounts {
  const counts: Record<TacverseHubCategory, number> = {
    ...EMPTY_TACVERSE_HUB_CATEGORY_COUNTS,
  };
  for (const input of inputs) {
    const classification =
      typeof input === "string"
        ? classifyTacverseHubRepository({ repoId: input })
        : classifyTacverseHubRepository(input);
    counts[classification.category] += 1;
  }
  return counts;
}

/**
 * Map direct, workflow-bucketed, and known Folder child paths to their parent
 * canonical Hub repository id.
 */
export function hubRepoIdForLocalDatasetPath(
  relativePath: string,
  organization = "TacVerse",
  folderRepoIds: ReadonlySet<string> = new Set(),
): string | null {
  const segments = pathSegments(relativePath);
  if (segments[0] !== organization) return null;
  if (segments.length === 2) return `${organization}/${segments[1]}`;
  if (segments.length >= 3 && bucketOf(relativePath) !== null) {
    return `${organization}/${segments.at(-1)}`;
  }
  if (segments.length === 3) {
    const parent = `${organization}/${segments[1]}`;
    return folderRepoIds.has(parent) ? parent : null;
  }
  return null;
}

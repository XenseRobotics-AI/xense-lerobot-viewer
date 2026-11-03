import path from "node:path";
import fs from "node:fs/promises";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  normalizeLocationInput,
  resolveBrowsePath,
} from "@/lib/dataset-locations-store";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import {
  REVIEWER_ROLES,
  MAX_REVIEWER_LENGTH,
  type ReviewerProfile,
  type ReviewerRole,
} from "@/types/episode-review.types";

/** Pin the selection; stale paths must never silently redirect writes. */
export async function resolveReviewBrowsePath(
  requested?: string,
): Promise<string> {
  const root = resolveLocalDatasetRoot();
  const selected = await resolveBrowsePath(root, requested);
  if (
    requested &&
    normalizeLocationInput(requested) !== path.resolve(selected)
  ) {
    throw new Error(
      "Selected browse directory is no longer registered; reopen the dataset from the dataset list",
    );
  }
  return selected;
}

/** Read the current work directory on every call; no cached/global roster. */
export async function readReviewerProfiles(
  browsePath: string,
): Promise<ReviewerProfile[]> {
  const root = await fs.realpath(browsePath);
  const config = path.join(root, ".xense-viewer", "reviewers.json");
  let raw: unknown;
  try {
    if (!isInsideRoot(root, await fs.realpath(config)))
      throw new Error("Reviewer configuration escapes browse directory");
    raw = JSON.parse(await fs.readFile(config, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
  if (!Array.isArray(raw))
    throw new Error(
      "reviewers.json must be an array of names or {name, role} entries",
    );
  const profiles = new Map<string, ReviewerProfile>();
  for (const entry of raw) {
    const name = typeof entry === "string" ? entry : entry?.name;
    const role = typeof entry === "string" ? "inspector" : entry?.role;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > MAX_REVIEWER_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !REVIEWER_ROLES.includes(role as ReviewerRole)
    )
      throw new Error("Invalid reviewer name or role in reviewers.json");
    const profile = { name: name.trim(), role: role as ReviewerRole };
    if (profiles.has(profile.name) && profiles.get(profile.name)?.role !== role)
      throw new Error("Conflicting roles for the same reviewer");
    profiles.set(profile.name, profile);
  }
  return [...profiles.values()];
}

export async function readReviewers(browsePath: string): Promise<string[]> {
  return (await readReviewerProfiles(browsePath)).map(
    (profile) => profile.name,
  );
}

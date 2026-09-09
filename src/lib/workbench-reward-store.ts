import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import defaultWorkbenchRewardRulesByOrg from "@/config/workbench-reward-rules.json";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
  DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE,
  evaluateWorkbenchRewardRules as evaluateRewardRules,
  normalizeWorkbenchQualityBonusByGrade,
  type WorkbenchEpisodeDurationLevel,
  type WorkbenchQualityBonusByGrade,
} from "@/utils/workbenchRewards";

const STORE_DIR = ".xense-viewer";
const WORKBENCH_DIR = "workbench";
const MAX_ORG_LENGTH = 128;
const MAX_LEVEL_ID_LENGTH = 64;
const MAX_LEVEL_LABEL_LENGTH = 64;
const MAX_LEVELS = 12;
const MAX_DURATION_LEVELS = 12;

export type WorkbenchRewardRulesSource = "stored" | "defaults";

export type WorkbenchRewardRuleLevel = {
  id: string;
  label: string;
  minPercent: number;
  maxPercent: number | null;
  amount: number;
};

export type WorkbenchRewardRules = {
  org: string;
  enabled: boolean;
  dailyTargetHours: number;
  levels: WorkbenchRewardRuleLevel[];
  episodeDurationLevels: WorkbenchEpisodeDurationLevel[];
  qualityBonusByGrade: WorkbenchQualityBonusByGrade;
  source: WorkbenchRewardRulesSource;
  updatedAt: string | null;
};

type WorkbenchRewardRulesFile = {
  org?: unknown;
  enabled?: unknown;
  dailyTargetHours?: unknown;
  levels?: unknown;
  episodeDurationLevels?: unknown;
  qualityBonusByGrade?: unknown;
  qualityBonus?: unknown;
  qualityBonuses?: unknown;
  updatedAt?: unknown;
};

const DEFAULT_LEVELS: WorkbenchRewardRuleLevel[] = [
  {
    id: "below-80",
    label: "不达标",
    minPercent: 0,
    maxPercent: 80,
    amount: -160,
  },
  { id: "80-90", label: "接近", minPercent: 80, maxPercent: 90, amount: -60 },
  { id: "90-100", label: "临界", minPercent: 90, maxPercent: 100, amount: 0 },
  {
    id: "100-plus",
    label: "达标",
    minPercent: 100,
    maxPercent: null,
    amount: 200,
  },
];

function normalizeOrg(value: string): string {
  const org = value.trim();
  if (!org) throw new Error("A non-empty organization is required.");
  if (org.length > MAX_ORG_LENGTH) {
    throw new Error("Organization is too long.");
  }
  return org;
}

function rewardRulesPath(root: string, org: string): string {
  return path.join(
    root,
    STORE_DIR,
    WORKBENCH_DIR,
    `${encodeURIComponent(org)}.reward-rules.json`,
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cloneLevels<T extends object>(levels: readonly T[]): T[] {
  return levels.map((level) => ({ ...level }));
}

function defaultRewardRulesForOrg(
  org: string,
): Omit<WorkbenchRewardRules, "source" | "updatedAt"> {
  const normalizedOrg = normalizeOrg(org);
  const defaults = (
    defaultWorkbenchRewardRulesByOrg as Record<string, unknown>
  )[normalizedOrg];
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    const parsed = normalizeWorkbenchRewardRulesInput({
      org: normalizedOrg,
      ...defaults,
    });
    return {
      org: normalizedOrg,
      enabled: parsed.enabled,
      dailyTargetHours: parsed.dailyTargetHours,
      levels: parsed.levels,
      episodeDurationLevels: parsed.episodeDurationLevels,
      qualityBonusByGrade: parsed.qualityBonusByGrade,
    };
  }
  return {
    org: normalizedOrg,
    enabled: true,
    dailyTargetHours: 6,
    levels: cloneLevels(DEFAULT_LEVELS),
    episodeDurationLevels: cloneLevels(
      DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
    ),
    qualityBonusByGrade: { ...DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE },
  };
}

export function normalizeWorkbenchRewardRuleLevels(
  input: unknown,
): WorkbenchRewardRuleLevel[] {
  if (!Array.isArray(input)) return [];
  const levels = input
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return null;
      const raw = entry as Record<string, unknown>;
      const id = cleanString(raw.id) ?? `level-${index + 1}`;
      const label = cleanString(raw.label) ?? `Level ${index + 1}`;
      const minPercent = asNumber(raw.minPercent);
      const maxPercentRaw = raw.maxPercent;
      const maxPercent =
        maxPercentRaw === null || maxPercentRaw === undefined
          ? null
          : asNumber(maxPercentRaw);
      const amount = asNumber(raw.amount);
      if (minPercent === null || amount === null) return null;
      if (minPercent < 0) return null;
      if (maxPercent !== null && maxPercent <= minPercent) return null;
      return {
        id: id.slice(0, MAX_LEVEL_ID_LENGTH),
        label: label.slice(0, MAX_LEVEL_LABEL_LENGTH),
        minPercent,
        maxPercent,
        amount,
      } satisfies WorkbenchRewardRuleLevel;
    })
    .filter((value): value is WorkbenchRewardRuleLevel => Boolean(value))
    .sort((left, right) => left.minPercent - right.minPercent);

  return levels.slice(0, MAX_LEVELS);
}

export function normalizeWorkbenchEpisodeDurationLevels(
  input: unknown,
): WorkbenchEpisodeDurationLevel[] {
  if (input === undefined) {
    return cloneLevels(DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS);
  }
  if (!Array.isArray(input)) return [];
  return input
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return null;
      const raw = entry as Record<string, unknown>;
      const minSeconds = asNumber(raw.minSeconds);
      const maxSeconds =
        raw.maxSeconds === null || raw.maxSeconds === undefined
          ? null
          : asNumber(raw.maxSeconds);
      const multiplier = asNumber(raw.multiplier);
      if (
        minSeconds === null ||
        minSeconds < 0 ||
        multiplier === null ||
        multiplier <= 0 ||
        (maxSeconds !== null && maxSeconds <= minSeconds)
      )
        return null;
      return {
        id: (cleanString(raw.id) ?? `duration-${index + 1}`).slice(
          0,
          MAX_LEVEL_ID_LENGTH,
        ),
        label: (cleanString(raw.label) ?? `Duration ${index + 1}`).slice(
          0,
          MAX_LEVEL_LABEL_LENGTH,
        ),
        minSeconds,
        maxSeconds,
        multiplier,
      } satisfies WorkbenchEpisodeDurationLevel;
    })
    .filter((value): value is WorkbenchEpisodeDurationLevel => Boolean(value))
    .sort((left, right) => left.minSeconds - right.minSeconds)
    .slice(0, MAX_DURATION_LEVELS);
}

export function normalizeWorkbenchRewardRulesInput(
  input: unknown,
): Omit<WorkbenchRewardRules, "source" | "updatedAt"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A reward rules object is required.");
  }
  const raw = input as WorkbenchRewardRulesFile & { org?: unknown };
  const org = cleanString(raw.org);
  if (!org) throw new Error("A non-empty organization is required.");
  const normalizedOrg = normalizeOrg(org);
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  const dailyTargetHours = asNumber(raw.dailyTargetHours);
  if (dailyTargetHours === null || dailyTargetHours <= 0) {
    throw new Error("Daily target hours must be a positive number.");
  }
  const levels = normalizeWorkbenchRewardRuleLevels(raw.levels);
  if (levels.length === 0) {
    throw new Error("At least one reward rule level is required.");
  }
  if (levels[0].minPercent !== 0) {
    throw new Error("The first reward level must start at 0%.");
  }
  const episodeDurationLevels = normalizeWorkbenchEpisodeDurationLevels(
    raw.episodeDurationLevels,
  );
  if (episodeDurationLevels.length === 0) {
    throw new Error("At least one episode duration level is required.");
  }
  if (episodeDurationLevels[0].minSeconds !== 0) {
    throw new Error(
      "The first episode duration level must start at 0 seconds.",
    );
  }
  for (let index = 1; index < episodeDurationLevels.length; index += 1) {
    const previous = episodeDurationLevels[index - 1];
    const current = episodeDurationLevels[index];
    if (previous.maxSeconds === null) {
      throw new Error(
        "Only the last episode duration level may be open-ended.",
      );
    }
    if (Math.abs(previous.maxSeconds - current.minSeconds) > 1e-9) {
      throw new Error("Episode duration level ranges must be continuous.");
    }
  }
  if (episodeDurationLevels.at(-1)?.maxSeconds !== null) {
    throw new Error("The last episode duration level must be open-ended.");
  }
  const qualityBonusByGrade = normalizeWorkbenchQualityBonusByGrade(
    raw.qualityBonusByGrade ?? raw.qualityBonus ?? raw.qualityBonuses,
  );
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1];
    const current = levels[index];
    if (previous.maxPercent === null) {
      throw new Error("Only the last reward level may be open-ended.");
    }
    if (Math.abs(previous.maxPercent - current.minPercent) > 1e-9) {
      throw new Error("Reward level ranges must be continuous.");
    }
  }
  return {
    org: normalizedOrg,
    enabled,
    dailyTargetHours,
    levels,
    episodeDurationLevels,
    qualityBonusByGrade,
  };
}

export function evaluateWorkbenchRewardRules(
  hours: number,
  targetHours: number,
  rules: Pick<
    WorkbenchRewardRules,
    "enabled" | "levels" | "episodeDurationLevels"
  >,
  totalEpisodes?: number | null,
) {
  return evaluateRewardRules(hours, targetHours, rules, totalEpisodes);
}

export async function readWorkbenchRewardRules(
  org: string,
  root = resolveLocalDatasetRoot(),
): Promise<WorkbenchRewardRules> {
  const normalizedOrg = normalizeOrg(org);
  try {
    const parsed = JSON.parse(
      await fs.readFile(rewardRulesPath(root, normalizedOrg), "utf8"),
    ) as WorkbenchRewardRulesFile;
    const normalized = normalizeWorkbenchRewardRulesInput({
      org: normalizedOrg,
      ...parsed,
    });
    return {
      ...normalized,
      source: "stored",
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : null,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    return {
      ...defaultRewardRulesForOrg(normalizedOrg),
      source: "defaults",
      updatedAt: null,
    };
  }
}

export async function writeWorkbenchRewardRules(
  org: string,
  rules: unknown,
  root = resolveLocalDatasetRoot(),
  updatedAtOverride?: string | null,
): Promise<WorkbenchRewardRules> {
  const normalizedOrg = normalizeOrg(org);
  const normalized = normalizeWorkbenchRewardRulesInput({
    ...(rules as Record<string, unknown>),
    org: normalizedOrg,
  });
  const updatedAt =
    typeof updatedAtOverride === "string" && updatedAtOverride.trim()
      ? updatedAtOverride.trim()
      : new Date().toISOString();
  const workbenchDir = path.join(root, STORE_DIR, WORKBENCH_DIR);
  await fs.mkdir(workbenchDir, { recursive: true });

  const destination = rewardRulesPath(root, normalizedOrg);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(
    {
      org: normalizedOrg,
      enabled: normalized.enabled,
      dailyTargetHours: normalized.dailyTargetHours,
      levels: normalized.levels,
      episodeDurationLevels: normalized.episodeDurationLevels,
      qualityBonusByGrade: normalized.qualityBonusByGrade,
      updatedAt,
    },
    null,
    2,
  )}
`;

  try {
    await fs.writeFile(temporary, payload, "utf8");
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }

  return {
    ...normalized,
    source: "stored",
    updatedAt,
  };
}

export function workbenchRewardRulesPath(
  org: string,
  root = resolveLocalDatasetRoot(),
): string {
  return rewardRulesPath(root, normalizeOrg(org));
}

export function defaultWorkbenchRewardRules(
  org: string,
): Omit<WorkbenchRewardRules, "source" | "updatedAt"> {
  return defaultRewardRulesForOrg(org);
}

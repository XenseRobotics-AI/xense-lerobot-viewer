import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import defaultWorkbenchRewardRulesByOrg from "@/config/workbench-reward-rules.json";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";

const STORE_DIR = ".xense-viewer";
const WORKBENCH_DIR = "workbench";
const MAX_ORG_LENGTH = 128;
const MAX_LEVEL_ID_LENGTH = 64;
const MAX_LEVEL_LABEL_LENGTH = 64;
const MAX_LEVELS = 12;

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
  source: WorkbenchRewardRulesSource;
  updatedAt: string | null;
};

type WorkbenchRewardRulesFile = {
  org?: unknown;
  enabled?: unknown;
  dailyTargetHours?: unknown;
  levels?: unknown;
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

function cloneLevels(
  levels: WorkbenchRewardRuleLevel[],
): WorkbenchRewardRuleLevel[] {
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
    };
  }
  return {
    org: normalizedOrg,
    enabled: true,
    dailyTargetHours: 6,
    levels: cloneLevels(DEFAULT_LEVELS),
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
  };
}

export function evaluateWorkbenchRewardRules(
  hours: number,
  targetHours: number,
  rules: Pick<WorkbenchRewardRules, "enabled" | "levels">,
): {
  percent: number | null;
  level: WorkbenchRewardRuleLevel | null;
  amount: number;
  symbol: "✅" | "❌" | "…" | "—";
} {
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    targetHours <= 0
  ) {
    return { percent: null, level: null, amount: 0, symbol: "—" };
  }
  const percent = (hours / targetHours) * 100;
  if (!rules.enabled) {
    return { percent, level: null, amount: 0, symbol: "—" };
  }
  const level =
    [...rules.levels]
      .sort((left, right) => left.minPercent - right.minPercent)
      .find((entry) => {
        const upperBound = entry.maxPercent;
        if (percent < entry.minPercent) return false;
        if (upperBound === null) return true;
        return percent < upperBound;
      }) ??
    rules.levels.at(-1) ??
    null;
  const amount = level?.amount ?? 0;
  const symbol = amount > 0 ? "✅" : amount < 0 ? "❌" : "…";
  return { percent, level, amount, symbol };
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
): Promise<WorkbenchRewardRules> {
  const normalizedOrg = normalizeOrg(org);
  const normalized = normalizeWorkbenchRewardRulesInput({
    ...(rules as Record<string, unknown>),
    org: normalizedOrg,
  });
  const updatedAt = new Date().toISOString();
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

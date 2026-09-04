export type WorkbenchRewardRuleLevel = {
  id: string;
  label: string;
  minPercent: number;
  maxPercent: number | null;
  amount: number;
};

export type WorkbenchQualityGrade = "A" | "B" | "C" | "D";

export type WorkbenchQualityBonusByGrade = Record<
  WorkbenchQualityGrade,
  number
>;

export type WorkbenchRewardRulesConfig = {
  enabled: boolean;
  dailyTargetHours: number;
  levels: WorkbenchRewardRuleLevel[];
  /** Quality pool amount per scored dataset. Kept optional for old configs. */
  qualityBonusByGrade?: WorkbenchQualityBonusByGrade;
};

export type WorkbenchRewardPreview = {
  percent: number | null;
  level: WorkbenchRewardRuleLevel | null;
  amount: number;
  symbol: "✅" | "❌" | "…" | "—";
};

export const DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE = {
  A: 20,
  B: 10,
  C: 0,
  D: -10,
} as const satisfies WorkbenchQualityBonusByGrade;

export function normalizeWorkbenchQualityBonusByGrade(
  input: unknown,
): WorkbenchQualityBonusByGrade {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const output: WorkbenchQualityBonusByGrade = {
    ...DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE,
  };
  for (const grade of ["A", "B", "C", "D"] as const) {
    const value = raw[grade];
    if (typeof value === "number" && Number.isFinite(value)) {
      output[grade] = Math.round(value * 100) / 100;
    }
  }
  return output;
}

export function qualityBonusForGrade(
  grade: WorkbenchQualityGrade | null | undefined,
  bonuses?: WorkbenchQualityBonusByGrade,
): number {
  if (!grade) return 0;
  return (bonuses ?? DEFAULT_WORKBENCH_QUALITY_BONUS_BY_GRADE)[grade] ?? 0;
}

/** Largest-remainder allocation in integer RMB cents. */
export function allocateWorkbenchCents(
  totalCents: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) return [];
  const normalizedTotalCents = Number.isFinite(totalCents)
    ? Math.round(totalCents)
    : 0;
  const normalized = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : 0,
  );
  const weightSum = normalized.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) return normalized.map(() => 0);
  const exact = normalized.map(
    (weight) => (normalizedTotalCents * weight) / weightSum,
  );
  const base = exact.map((value) =>
    normalizedTotalCents >= 0 ? Math.floor(value) : Math.ceil(value),
  );
  let remainder =
    normalizedTotalCents - base.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({
      index,
      fraction: Math.abs(value - base[index]),
    }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index,
    );
  const step = remainder >= 0 ? 1 : -1;
  remainder = Math.abs(remainder);
  for (let index = 0; index < remainder; index += 1) {
    base[order[index % order.length].index] += step;
  }
  return base;
}

export function roundWorkbenchMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function matchWorkbenchRewardPreview(
  hours: number,
  targetHours: number,
  levels: readonly WorkbenchRewardRuleLevel[],
): WorkbenchRewardPreview {
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    targetHours <= 0
  ) {
    return { percent: null, level: null, amount: 0, symbol: "—" };
  }
  const percent = (hours / targetHours) * 100;
  const level =
    [...levels]
      .sort((left, right) => left.minPercent - right.minPercent)
      .find((entry) => {
        if (percent < entry.minPercent) return false;
        if (entry.maxPercent === null) return true;
        return percent < entry.maxPercent;
      }) ??
    levels.at(-1) ??
    null;
  const amount = level?.amount ?? 0;
  const symbol = amount > 0 ? "✅" : amount < 0 ? "❌" : "…";
  return { percent, level, amount, symbol };
}

export function countWorkbenchRewardTargetHours(
  days: number | null,
  dailyTargetHours: number,
): number | null {
  if (
    days === null ||
    !Number.isFinite(dailyTargetHours) ||
    dailyTargetHours <= 0
  ) {
    return null;
  }
  return days * dailyTargetHours;
}

export function previewWorkbenchRewardRules(
  hours: number,
  targetHours: number,
  levels: readonly WorkbenchRewardRuleLevel[],
): WorkbenchRewardPreview {
  return matchWorkbenchRewardPreview(hours, targetHours, levels);
}

export function evaluateWorkbenchRewardRules(
  hours: number,
  targetHours: number,
  rules: Pick<WorkbenchRewardRulesConfig, "enabled" | "levels">,
): WorkbenchRewardPreview {
  const preview = matchWorkbenchRewardPreview(hours, targetHours, rules.levels);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    targetHours <= 0
  ) {
    return preview;
  }
  if (!rules.enabled) {
    return { ...preview, amount: 0, symbol: "—" };
  }
  return preview;
}

export function formatWorkbenchRewardAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  const coin = value > 0 ? " 🪙" : "";
  const formatted = Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return `¥${prefix}${formatted}${coin}`;
}

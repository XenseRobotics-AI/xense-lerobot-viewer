export type WorkbenchRewardRuleLevel = {
  id: string;
  label: string;
  minPercent: number;
  maxPercent: number | null;
  amount: number;
};

export type WorkbenchRewardRulesConfig = {
  enabled: boolean;
  dailyTargetHours: number;
  levels: WorkbenchRewardRuleLevel[];
};

export type WorkbenchRewardPreview = {
  percent: number | null;
  level: WorkbenchRewardRuleLevel | null;
  amount: number;
  symbol: "✅" | "❌" | "…" | "—";
};

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
  if (!Number.isFinite(value) || value === 0) return "0";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toLocaleString("en-US")}`;
}

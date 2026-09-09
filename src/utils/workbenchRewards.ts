export type WorkbenchRewardRuleLevel = {
  id: string;
  label: string;
  minPercent: number;
  maxPercent: number | null;
  amount: number;
};

export type WorkbenchEpisodeDurationLevel = {
  id: string;
  label: string;
  minSeconds: number;
  maxSeconds: number | null;
  multiplier: number;
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
  /** Optional only for source compatibility; normalization always supplies it. */
  episodeDurationLevels?: WorkbenchEpisodeDurationLevel[];
  /** Quality pool amount per scored dataset. Kept optional for old configs. */
  qualityBonusByGrade?: WorkbenchQualityBonusByGrade;
};

export type WorkbenchRewardPreview = {
  percent: number | null;
  level: WorkbenchRewardRuleLevel | null;
  baseAmount: number;
  averageEpisodeSeconds: number | null;
  episodeDurationLevel: WorkbenchEpisodeDurationLevel | null;
  multiplier: number;
  amount: number;
  symbol: "✅" | "❌" | "…" | "—";
};

export const DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS = Object.freeze([
  {
    id: "under-20s",
    label: "Short",
    minSeconds: 0,
    maxSeconds: 20,
    multiplier: 1.2,
  },
  {
    id: "20-40s",
    label: "Medium",
    minSeconds: 20,
    maxSeconds: 40,
    multiplier: 1.1,
  },
  {
    id: "40s-plus",
    label: "Standard",
    minSeconds: 40,
    maxSeconds: null,
    multiplier: 1,
  },
] satisfies WorkbenchEpisodeDurationLevel[]);

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
  episodeDurationLevels: readonly WorkbenchEpisodeDurationLevel[] = DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
  totalEpisodes?: number | null,
): WorkbenchRewardPreview {
  const validPerformance =
    Number.isFinite(hours) && Number.isFinite(targetHours) && targetHours > 0;
  const averageEpisodeSeconds =
    Number.isFinite(hours) &&
    hours >= 0 &&
    typeof totalEpisodes === "number" &&
    Number.isFinite(totalEpisodes) &&
    totalEpisodes > 0
      ? (hours * 3600) / totalEpisodes
      : null;
  const durationLevel =
    averageEpisodeSeconds === null
      ? null
      : ([...episodeDurationLevels]
          .sort((left, right) => left.minSeconds - right.minSeconds)
          .find(
            (entry) =>
              averageEpisodeSeconds >= entry.minSeconds &&
              (entry.maxSeconds === null ||
                averageEpisodeSeconds < entry.maxSeconds),
          ) ?? null);
  const multiplier = durationLevel?.multiplier ?? 1;
  if (!validPerformance) {
    return {
      percent: null,
      level: null,
      baseAmount: 0,
      averageEpisodeSeconds,
      episodeDurationLevel: durationLevel,
      multiplier,
      amount: 0,
      symbol: "—",
    };
  }
  const percent = (hours / targetHours) * 100;
  const level =
    [...levels]
      .sort((left, right) => left.minPercent - right.minPercent)
      .find((entry) => {
        if (percent < entry.minPercent) return false;
        return entry.maxPercent === null || percent < entry.maxPercent;
      }) ??
    levels.at(-1) ??
    null;
  const baseAmount = level?.amount ?? 0;
  const amount = roundWorkbenchMoney(
    baseAmount > 0 ? baseAmount * multiplier : baseAmount,
  );
  const symbol = amount > 0 ? "✅" : amount < 0 ? "❌" : "…";
  return {
    percent,
    level,
    baseAmount,
    averageEpisodeSeconds,
    episodeDurationLevel: durationLevel,
    multiplier,
    amount,
    symbol,
  };
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
  rules: Pick<
    WorkbenchRewardRulesConfig,
    "enabled" | "levels" | "episodeDurationLevels"
  >,
  totalEpisodes?: number | null,
): WorkbenchRewardPreview {
  const preview = matchWorkbenchRewardPreview(
    hours,
    targetHours,
    rules.levels,
    rules.episodeDurationLevels ?? DEFAULT_WORKBENCH_EPISODE_DURATION_LEVELS,
    totalEpisodes,
  );
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(targetHours) ||
    targetHours <= 0
  ) {
    return preview;
  }
  if (!rules.enabled) {
    return { ...preview, baseAmount: 0, amount: 0, symbol: "—" };
  }
  return preview;
}

export function formatWorkbenchAverageEpisode(
  preview: Pick<WorkbenchRewardPreview, "averageEpisodeSeconds" | "multiplier">,
): string {
  return preview.averageEpisodeSeconds === null
    ? "—"
    : `${preview.averageEpisodeSeconds.toFixed(1)}s · ×${preview.multiplier.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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

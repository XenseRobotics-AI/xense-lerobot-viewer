export type WorkbenchTrendSourceRow = {
  day: string;
  hours: number;
  datasets: number;
};

export type WorkbenchTrendChartRow = {
  day: string;
  dayOffset: number;
  label: string;
  hours: number;
  cumulativeHours: number;
  datasets: number;
  hasActivity: boolean;
};

export type WorkbenchTrendTick = {
  offset: number;
  day: string;
  label: string;
};

const DAY_MS = 86_400_000;
const TREND_TARGET_PIXELS_PER_LABEL = 100;
export const WORKBENCH_TREND_START_DATE = "2026-07-01";

function parseDayKey(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

function dayKeyFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function roundHours(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function workbenchDateOffset(
  startDate: string,
  date: string,
): number | null {
  const start = parseDayKey(startDate);
  const target = parseDayKey(date);
  if (start === null || target === null) return null;
  return Math.floor((target - start) / DAY_MS);
}

export function workbenchDateAtOffset(
  startDate: string,
  offset: number,
): string | null {
  const start = parseDayKey(startDate);
  if (start === null || !Number.isInteger(offset) || offset < 0) return null;
  return dayKeyFromTimestamp(start + offset * DAY_MS);
}

/**
 * Aggregate daily additions onto a real calendar axis without inventing
 * rows for dates that have no activity.
 * `endDateExclusive` follows the Workbench half-open range convention.
 */
export function buildWorkbenchTrendRows(
  rows: readonly WorkbenchTrendSourceRow[],
  options: {
    startDate?: string | null;
    endDateExclusive?: string | null;
  } = {},
): {
  startDate: string | null;
  endDateExclusive: string | null;
  rows: WorkbenchTrendChartRow[];
} {
  const daily = new Map<string, { hours: number; datasets: number }>();
  for (const row of rows) {
    const dayTimestamp = parseDayKey(row.day);
    if (dayTimestamp === null) continue;
    if (
      options.startDate &&
      parseDayKey(options.startDate) !== null &&
      row.day < options.startDate
    )
      continue;
    if (
      options.endDateExclusive &&
      parseDayKey(options.endDateExclusive) !== null &&
      row.day >= options.endDateExclusive
    )
      continue;
    const current = daily.get(row.day) ?? { hours: 0, datasets: 0 };
    const hours = Number(row.hours);
    const datasets = Number(row.datasets);
    current.hours += Number.isFinite(hours) && hours > 0 ? hours : 0;
    current.datasets +=
      Number.isFinite(datasets) && datasets > 0 ? Math.trunc(datasets) : 0;
    daily.set(row.day, current);
  }

  const activeDays = Array.from(daily.entries())
    .map(([day, values]) => ({
      day,
      hours: roundHours(values.hours),
      datasets: values.datasets,
    }))
    .filter((row) => row.hours > 0 || row.datasets > 0)
    .sort((left, right) => left.day.localeCompare(right.day));
  const firstDay = activeDays[0]?.day;
  const lastDay = activeDays.at(-1)?.day;
  if (!firstDay || !lastDay) {
    return { startDate: null, endDateExclusive: null, rows: [] };
  }

  let cumulativeHours = 0;
  const chartRows = activeDays.flatMap((current) => {
    const dayOffset = workbenchDateOffset(firstDay, current.day);
    if (dayOffset === null) return [];
    cumulativeHours = roundHours(cumulativeHours + current.hours);
    return [
      {
        day: current.day,
        dayOffset,
        label: current.day.slice(5),
        hours: current.hours,
        cumulativeHours,
        datasets: current.datasets,
        hasActivity: true,
      },
    ];
  });

  return {
    startDate: firstDay,
    endDateExclusive: dayKeyFromTimestamp(parseDayKey(lastDay)! + DAY_MS),
    rows: chartRows,
  };
}

/**
 * Select readable date ticks from actual data rows while preserving both ends.
 */
export function getWorkbenchTrendTicks(
  rows: readonly Pick<WorkbenchTrendChartRow, "day" | "dayOffset">[],
  widthPx = 0,
): WorkbenchTrendTick[] {
  if (rows.length === 0) return [];

  const width = Math.max(1, widthPx);
  const maxLabels = Math.max(
    7,
    Math.min(12, Math.floor(width / TREND_TARGET_PIXELS_PER_LABEL)),
  );
  const labelCount = Math.min(rows.length, maxLabels);
  const indexes =
    rows.length <= labelCount
      ? Array.from({ length: rows.length }, (_, index) => index)
      : Array.from({ length: labelCount }, (_, index) =>
          Math.round((index * (rows.length - 1)) / (labelCount - 1)),
        );

  return indexes.map((index) => {
    const row = rows[index];
    return {
      offset: row.dayOffset,
      day: row.day,
      label: row.day.slice(5),
    };
  });
}

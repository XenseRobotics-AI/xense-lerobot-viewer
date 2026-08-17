/**
 * Pure, local quality checks used by the Workbench-style dataset summary.
 *
 * The checks deliberately know nothing about the filesystem, LeRobot loader,
 * or React.  A caller supplies the small summary record below and can tune
 * thresholds with a partial config object.  Keeping this module independent
 * means it can be used by the homepage as well as by tests or another client.
 */

export const DATASET_QUALITY_PROVIDER = "custom" as const;

export const DATASET_QUALITY_STATUSES = ["ok", "warn", "fail", "skip"] as const;

export type DatasetQualityStatus = (typeof DATASET_QUALITY_STATUSES)[number];
export type DatasetQualityAggregateStatus = Exclude<
  DatasetQualityStatus,
  "skip"
>;

/** A row from meta/tasks.parquet (or the equivalent inline summary field). */
export interface DatasetPrompt {
  index?: number | string | null;
  task?: string | null;
}

/**
 * The intentionally small input contract for the custom rules.
 *
 * `duration_hours` is the Workbench summary's derived duration.  The viewer
 * can calculate it from frames/fps before calling these checks; the checks do
 * not make assumptions about how that value was obtained.
 */
export interface DatasetQualityDataset {
  dataset_name?: string | null;
  total_episodes?: number | null;
  duration_hours?: number | null;
  tasks?: readonly DatasetPrompt[] | null;
}

export interface NameFormatThresholds {
  /** JavaScript regular-expression source, or a RegExp supplied by a caller. */
  regex: string | RegExp;
}

export interface AverageDurationThresholds {
  min_sec: number;
  max_sec: number;
}

export interface PromptQualityThresholds {
  min_words: number;
  max_words: number;
  illegal_chars: readonly string[];
}

export interface DatasetQualityConfig {
  name_format?: Partial<NameFormatThresholds> | null;
  avg_duration?: Partial<AverageDurationThresholds> | null;
  prompt?: Partial<PromptQualityThresholds> | null;
}

/** Defaults copied from tacverse-workbench/checks.py. */
export const DEFAULT_DATASET_QUALITY_THRESHOLDS: {
  readonly name_format: Readonly<NameFormatThresholds>;
  readonly avg_duration: Readonly<AverageDurationThresholds>;
  readonly prompt: Readonly<PromptQualityThresholds>;
} = {
  name_format: {
    regex: "^TacVerse/taccap-g1-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\\d{4}$",
  },
  avg_duration: { min_sec: 20, max_sec: 600 },
  prompt: {
    min_words: 10,
    max_words: 50,
    illegal_chars: [
      "_",
      "-",
      "，",
      "。",
      "、",
      "；",
      "：",
      "？",
      "！",
      "（",
      "）",
      "“",
      "”",
      "‘",
      "’",
      "《",
      "》",
      "—",
      "·",
    ],
  },
};

/**
 * Full, ready-to-pass config (the naming used by the Workbench adapter).
 * Keep this separate from the threshold constant so callers can safely pass
 * it around as a normal `DatasetQualityConfig` and override one subsection.
 */
export const DEFAULT_DATASET_QUALITY_CONFIG: DatasetQualityConfig = {
  name_format: {
    regex: DEFAULT_DATASET_QUALITY_THRESHOLDS.name_format.regex,
  },
  avg_duration: {
    min_sec: DEFAULT_DATASET_QUALITY_THRESHOLDS.avg_duration.min_sec,
    max_sec: DEFAULT_DATASET_QUALITY_THRESHOLDS.avg_duration.max_sec,
  },
  prompt: {
    min_words: DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt.min_words,
    max_words: DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt.max_words,
    illegal_chars: [...DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt.illegal_chars],
  },
};

export interface DatasetQualityResult {
  id: DatasetQualityCheckId;
  title: string;
  provider: typeof DATASET_QUALITY_PROVIDER;
  status: DatasetQualityStatus;
  message: string;
  details: string[];
}

/** Backwards-compatible names used by the API adapter and homepage client. */
export type DatasetQualityCheckResult = DatasetQualityResult;
export type DatasetQualityTask = DatasetPrompt;

export type DatasetQualityCheckId =
  | "name_format"
  | "avg_duration"
  | "prompt_quality";

export interface DatasetQualityAggregate {
  worst: DatasetQualityAggregateStatus;
  n_fail: number;
  n_warn: number;
}

export interface DatasetQualityRun {
  results: DatasetQualityResult[];
  aggregate: DatasetQualityAggregate;
}

const CHECK_TITLES: Record<DatasetQualityCheckId, string> = {
  name_format: "名称规范",
  avg_duration: "均时长",
  prompt_quality: "Prompt 规范",
};

const CHECK_IDS: readonly DatasetQualityCheckId[] = [
  "name_format",
  "avg_duration",
  "prompt_quality",
];

function mergedNameFormatConfig(
  config?: DatasetQualityConfig | null,
): NameFormatThresholds {
  return {
    ...DEFAULT_DATASET_QUALITY_THRESHOLDS.name_format,
    ...(config?.name_format ?? {}),
  };
}

function mergedAverageDurationConfig(
  config?: DatasetQualityConfig | null,
): AverageDurationThresholds {
  return {
    ...DEFAULT_DATASET_QUALITY_THRESHOLDS.avg_duration,
    ...(config?.avg_duration ?? {}),
  };
}

function mergedPromptConfig(
  config?: DatasetQualityConfig | null,
): PromptQualityThresholds {
  return {
    ...DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt,
    ...(config?.prompt ?? {}),
    // Do not let a caller mutate the module-level default array through a
    // result/config object.  It also gives each run a stable snapshot.
    illegal_chars: [
      ...(config?.prompt?.illegal_chars ??
        DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt.illegal_chars),
    ],
  };
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatOneDecimal(value: number): string {
  return value.toFixed(1);
}

/** Execute the name-format rule and return its Workbench-compatible result. */
export function checkDatasetNameFormat(
  dataset: DatasetQualityDataset,
  config?: DatasetQualityConfig | null,
): DatasetQualityResult {
  const name = dataset.dataset_name ?? "";
  if (!name) {
    return result("name_format", "skip", "无数据集名");
  }

  const source = mergedNameFormatConfig(config).regex;
  // Constructing a RegExp is intentionally allowed to throw.  The runner
  // catches a malformed user-supplied pattern and turns it into SKIP, just as
  // Workbench's registry does for a broken rule.
  const pattern =
    source instanceof RegExp
      ? new RegExp(source.source, source.flags)
      : new RegExp(source);
  if (pattern.test(name)) {
    return result("name_format", "ok", "符合命名规范");
  }
  return result(
    "name_format",
    "fail",
    "不符合 TacVerse/taccap-g1-<动词-名词>-<日期>",
  );
}

/** Derive the mean episode duration in seconds, or null when unavailable. */
export function averageEpisodeSeconds(
  dataset: DatasetQualityDataset,
): number | null {
  const episodes = finiteOr(dataset.total_episodes, 0);
  if (!episodes) return null;
  const hours = finiteOr(dataset.duration_hours, 0);
  return (hours * 3600) / episodes;
}

/** Execute the average-duration rule and return its Workbench-compatible result. */
export function checkDatasetAverageDuration(
  dataset: DatasetQualityDataset,
  config?: DatasetQualityConfig | null,
): DatasetQualityResult {
  const average = averageEpisodeSeconds(dataset);
  if (average === null) {
    return result("avg_duration", "skip", "无 episodes，无法计算");
  }

  const thresholds = mergedAverageDurationConfig(config);
  const min = thresholds.min_sec;
  const max = thresholds.max_sec;
  if (average < min) {
    return result(
      "avg_duration",
      "fail",
      `均时长 ${formatOneDecimal(average)}s 偏短(<${min}s)`,
    );
  }
  if (average > max) {
    return result(
      "avg_duration",
      "fail",
      `均时长 ${formatOneDecimal(average)}s 偏长(>${max}s)`,
    );
  }
  return result(
    "avg_duration",
    "ok",
    `均时长 ${formatOneDecimal(average)}s，在 ${min}-${max}s 内`,
  );
}

function isAlphabeticFirstCharacter(text: string): boolean {
  const first = Array.from(text)[0];
  // Python's str.isalpha() is Unicode-aware.  Unicode property escapes keep
  // the same behavior for Chinese and other non-ASCII prompts in modern JS.
  return first !== undefined && /^\p{L}$/u.test(first);
}

function promptFindings(
  row: DatasetPrompt,
  config: PromptQualityThresholds,
): { status: Exclude<DatasetQualityStatus, "ok" | "skip">; line: string }[] {
  const text = textOrEmpty(row.task);
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/u) : [];
  const findings: {
    status: Exclude<DatasetQualityStatus, "ok" | "skip">;
    line: string;
  }[] = [];
  const index = row.index ?? "?";
  const count = words.length;

  if (count < config.min_words || count > config.max_words) {
    findings.push({
      status: "warn",
      line: `[${index}] 词数 ${count}(需 ${config.min_words}-${config.max_words})`,
    });
  }

  const bad = config.illegal_chars.filter((character, position, all) => {
    // The Python implementation emits each configured character once even if
    // the prompt contains it repeatedly, and dict.fromkeys removes duplicate
    // entries from a customized config while retaining their order.
    return (
      character !== "" &&
      text.includes(character) &&
      all.indexOf(character) === position
    );
  });
  if (bad.length > 0) {
    findings.push({
      status: "fail",
      line: `[${index}] 含非法字符: ${bad.join(" ")}`,
    });
  }

  // This is deliberately the same heuristic placeholder as Workbench: a
  // passing prompt is not asserted to be grammatically correct.
  if (count < 3 || !isAlphabeticFirstCharacter(words[0] ?? "")) {
    findings.push({
      status: "warn",
      line: `[${index}] 结构可能不符合公式(待细化)`,
    });
  }

  return findings;
}

/** Execute the Prompt-quality rule and return its Workbench-compatible result. */
export function checkDatasetPromptQuality(
  dataset: DatasetQualityDataset,
  config?: DatasetQualityConfig | null,
): DatasetQualityResult {
  const tasks = dataset.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return result("prompt_quality", "skip", "无 Prompt(先统计/拉取)");
  }

  const thresholds = mergedPromptConfig(config);
  const findings = tasks.flatMap((row) => promptFindings(row, thresholds));
  if (findings.length === 0) {
    return result("prompt_quality", "ok", "符合规范");
  }

  const hasFailure = findings.some((finding) => finding.status === "fail");
  return result(
    "prompt_quality",
    hasFailure ? "fail" : "warn",
    `${findings.length} 项待改`,
    findings.map((finding) => finding.line),
  );
}

/**
 * Run all three custom rules.  A malformed custom rule/config produces a SKIP
 * result for that rule rather than breaking the rest of the dashboard.
 */
export function runDatasetChecks(
  dataset: DatasetQualityDataset,
  config?: DatasetQualityConfig | null,
): DatasetQualityRun {
  const checks: Record<
    DatasetQualityCheckId,
    (
      input: DatasetQualityDataset,
      cfg?: DatasetQualityConfig | null,
    ) => DatasetQualityResult
  > = {
    name_format: checkDatasetNameFormat,
    avg_duration: checkDatasetAverageDuration,
    prompt_quality: checkDatasetPromptQuality,
  };

  const results = CHECK_IDS.map((id) => {
    try {
      return checks[id](dataset, config);
    } catch (error) {
      return result(
        id,
        "skip",
        `检查出错: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return { results, aggregate: aggregateDatasetChecks(results) };
}

export function aggregateDatasetChecks(
  results: readonly DatasetQualityResult[],
): DatasetQualityAggregate {
  const n_fail = results.filter((entry) => entry.status === "fail").length;
  const n_warn = results.filter((entry) => entry.status === "warn").length;
  return {
    worst: n_fail > 0 ? "fail" : n_warn > 0 ? "warn" : "ok",
    n_fail,
    n_warn,
  };
}

function result(
  id: DatasetQualityCheckId,
  status: DatasetQualityStatus,
  message: string,
  details: string[] = [],
): DatasetQualityResult {
  return {
    id,
    title: CHECK_TITLES[id],
    provider: DATASET_QUALITY_PROVIDER,
    status,
    message,
    details,
  };
}

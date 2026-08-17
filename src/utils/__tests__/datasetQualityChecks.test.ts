import { describe, expect, test } from "bun:test";
import {
  aggregateDatasetChecks,
  averageEpisodeSeconds,
  checkDatasetAverageDuration,
  checkDatasetNameFormat,
  checkDatasetPromptQuality,
  DEFAULT_DATASET_QUALITY_THRESHOLDS,
  runDatasetChecks,
} from "@/utils/datasetQualityChecks";

describe("name_format", () => {
  test("accepts the TacVerse task/date format", () => {
    const result = checkDatasetNameFormat({
      dataset_name: "TacVerse/taccap-g1-place-egg-into-egg-tray-0816",
    });
    expect(result.status).toBe("ok");
    expect(result.message).toBe("符合命名规范");
  });

  test("rejects missing prefix, task, or four-digit date", () => {
    for (const dataset_name of [
      "tacverse/taccap-g1-place-egg-into-egg-tray-0816",
      "TacVerse/taccap-g1-place-egg-into-egg-tray",
      "TacVerse/taccap-g1-place_egg-into-egg-tray-0816",
    ]) {
      expect(checkDatasetNameFormat({ dataset_name }).status).toBe("fail");
    }
  });

  test("skips when the name is unavailable", () => {
    expect(checkDatasetNameFormat({}).status).toBe("skip");
  });

  test("allows a caller-supplied regex", () => {
    const result = checkDatasetNameFormat(
      { dataset_name: "example-dataset" },
      { name_format: { regex: /^example-/ } },
    );
    expect(result.status).toBe("ok");
  });
});

describe("avg_duration", () => {
  test("derives seconds per episode from hours", () => {
    expect(
      averageEpisodeSeconds({ total_episodes: 12, duration_hours: 1 }),
    ).toBe(300);
  });

  test("skips datasets without episodes", () => {
    expect(checkDatasetAverageDuration({ duration_hours: 1 }).status).toBe(
      "skip",
    );
  });

  test("fails below and above the default bounds, including useful messages", () => {
    const short = checkDatasetAverageDuration({
      total_episodes: 100,
      duration_hours: 0.1,
    });
    const long = checkDatasetAverageDuration({
      total_episodes: 1,
      duration_hours: 1,
    });
    expect(short.status).toBe("fail");
    expect(short.message).toContain("偏短");
    expect(long.status).toBe("fail");
    expect(long.message).toContain("偏长");
  });

  test("uses inclusive configurable bounds", () => {
    const result = checkDatasetAverageDuration(
      { total_episodes: 2, duration_hours: 1 },
      { avg_duration: { min_sec: 1, max_sec: 1_800 } },
    );
    expect(result.status).toBe("ok");
    expect(result.message).toContain("1-1800s");
  });
});

describe("prompt_quality", () => {
  const goodPrompt =
    "Place the egg into an empty slot of the egg tray after lifting it from the table";

  test("passes a normal 10–50 word prompt", () => {
    const result = checkDatasetPromptQuality({
      tasks: [{ index: 0, task: goodPrompt }],
    });
    expect(result.status).toBe("ok");
    expect(result.details).toEqual([]);
  });

  test("warns for word count and structure, and fails illegal characters", () => {
    const result = checkDatasetPromptQuality({
      tasks: [
        { index: 4, task: "123" },
        { index: 5, task: "place_the_egg" },
      ],
    });
    expect(result.status).toBe("fail");
    expect(result.message).toBe("5 项待改");
    expect(result.details).toEqual([
      "[4] 词数 1(需 10-50)",
      "[4] 结构可能不符合公式(待细化)",
      "[5] 词数 1(需 10-50)",
      "[5] 含非法字符: _",
      "[5] 结构可能不符合公式(待细化)",
    ]);
  });

  test("treats Unicode alphabetic prompts as structurally valid", () => {
    const result = checkDatasetPromptQuality({
      tasks: [
        {
          index: 1,
          task: "放置 这个 物体 到 空的 位置 然后 从 桌面 抬起 它",
        },
      ],
    });
    expect(result.status).toBe("ok");
  });

  test("skips when no task prompts are available", () => {
    expect(checkDatasetPromptQuality({}).status).toBe("skip");
    expect(checkDatasetPromptQuality({ tasks: [] }).message).toBe(
      "无 Prompt(先统计/拉取)",
    );
  });

  test("supports configurable word and illegal-character rules", () => {
    const result = checkDatasetPromptQuality(
      { tasks: [{ index: 0, task: "one two three" }] },
      { prompt: { min_words: 3, max_words: 3, illegal_chars: [] } },
    );
    expect(result.status).toBe("ok");
  });
});

describe("runDatasetChecks", () => {
  test("runs the three custom checks in registry order and aggregates severity", () => {
    const run = runDatasetChecks({
      dataset_name: "not-a-TacVerse-name",
      total_episodes: 1,
      duration_hours: 1,
      tasks: [],
    });
    expect(run.results.map((entry) => entry.id)).toEqual([
      "name_format",
      "avg_duration",
      "prompt_quality",
    ]);
    expect(run.aggregate).toEqual({ worst: "fail", n_fail: 2, n_warn: 0 });
  });

  test("isolates malformed custom rules as SKIP", () => {
    const run = runDatasetChecks(
      { dataset_name: "anything" },
      { name_format: { regex: "[" } },
    );
    expect(run.results[0].status).toBe("skip");
    expect(run.results[0].message).toContain("检查出错");
    expect(run.results[1].status).toBe("skip");
    expect(run.results[2].status).toBe("skip");
    expect(run.aggregate).toEqual({ worst: "ok", n_fail: 0, n_warn: 0 });
  });

  test("does not expose a mutable default illegal-character list", () => {
    const before = DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt.illegal_chars;
    const result = checkDatasetPromptQuality(
      {
        tasks: [
          {
            task: "one two three four five six seven eight nine ten-eleven",
          },
        ],
      },
      { prompt: { illegal_chars: [] } },
    );
    expect(result.status).toBe("ok");
    expect(DEFAULT_DATASET_QUALITY_THRESHOLDS.prompt.illegal_chars).toEqual(
      before,
    );
  });
});

describe("aggregateDatasetChecks", () => {
  test("counts fail and warn while ignoring skipped checks", () => {
    const aggregate = aggregateDatasetChecks([
      {
        id: "name_format",
        title: "名称规范",
        provider: "custom",
        status: "skip",
        message: "—",
        details: [],
      },
      {
        id: "avg_duration",
        title: "均时长",
        provider: "custom",
        status: "warn",
        message: "—",
        details: [],
      },
      {
        id: "prompt_quality",
        title: "Prompt 规范",
        provider: "custom",
        status: "fail",
        message: "—",
        details: [],
      },
    ]);
    expect(aggregate).toEqual({ worst: "fail", n_fail: 1, n_warn: 1 });
  });
});

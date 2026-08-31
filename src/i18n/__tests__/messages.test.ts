import { describe, expect, it } from "bun:test";
import { LOCALES } from "../config";
import { MESSAGES, en, zh } from "../messages";

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}

describe("dictionaries", () => {
  it("covers every locale", () => {
    for (const locale of LOCALES) {
      expect(MESSAGES[locale]).toBeDefined();
    }
  });

  it("has the same key set in every locale", () => {
    // tsc already enforces this via `Record<MessageKey, string>`; this catches a
    // dictionary that gets loosened or built dynamically later.
    const base = Object.keys(en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(base);
    }
  });

  it("has no empty or whitespace-only entries", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(`${locale}:${key}:${value.trim().length > 0}`).toBe(
          `${locale}:${key}:true`,
        );
      }
    }
  });

  it("keeps the same placeholders in every translation", () => {
    // A dropped `{count}` silently loses the number from the sentence.
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(`${key}:${placeholders(zh[key]).join(",")}`).toBe(
        `${key}:${placeholders(en[key]).join(",")}`,
      );
    }
  });
});

describe("plural pairs", () => {
  const keys = Object.keys(en);

  it("pairs every _one with an _other", () => {
    for (const key of keys) {
      if (key.endsWith("_one")) {
        expect(keys).toContain(`${key.slice(0, -4)}_other`);
      }
    }
  });

  it("pairs every _other with a _one", () => {
    for (const key of keys) {
      if (key.endsWith("_other")) {
        expect(keys).toContain(`${key.slice(0, -6)}_one`);
      }
    }
  });

  it("has at least one plural pair to guard", () => {
    expect(keys.some((k) => k.endsWith("_one"))).toBe(true);
  });
});

describe("zh translation coverage", () => {
  // The exhaustive list of entries that are byte-identical in both dictionaries,
  // and why. Anything else identical is an untranslated leftover.
  const KEPT_IN_ENGLISH = [
    // The switcher's own two labels.
    "lang.en",
    "lang.zh",
    // Each switcher tooltip is written in the language it switches TO, so both
    // dictionaries carry the same text on purpose.
    "lang.switchToEn",
    "lang.switchToZh",
    // Pure composition — both halves are translated separately.
    "home.groupTitle",
    // Everything about an episode is written in English — the term matches the
    // URL (`episode_12`), the parquet columns and info.json.
    "common.epShort",
    "common.episodes",
    "ep.episodeLabel",
    "nav.episodeItem",
    "insights.thEpisode",
    "insights.svScope",
    "home.groupEpisodes",
    "grid.epCount",
    "tape.epSuffix",
    "tape.perEp",
    "source.perEpisode",
    "stats.totalEpisodes",
    "stats.episodeCount_other",
    // Tool names the user also meets as a tab, a CLI and a file extension.
    "viewer.tab.doctor",
    "viewer.tab.parquet",
    "viewer.tab.workbench",
    // Pure formula — symbols and units only, nothing to translate.
    "doctor.speedFormula",
    // Value + unit, and units render in English in both languages (see the
    // "writes units in English" test below), so these come out identical.
    "doctor.checksWord",
    "doctor.distBins",
    "grid.framesSuffix",
    "home.groupFrames",
    "pq.columns",
    "pq.jumpTitle",
    "pq.rowGroups",
    "pq.rows",
    "source.filesDetail",
    "stats.bins_other",
    "subtask.frame",
    "subtask.frameOf",
  ].sort();

  it("keeps exactly the intended terms in English", () => {
    // Asserting equality (not membership) in both directions at once: a new
    // untranslated string fails, and so does a stale exemption.
    const identical = Object.keys(en)
      .filter(
        (key) => zh[key as keyof typeof en] === en[key as keyof typeof en],
      )
      .sort();
    expect(identical).toEqual(KEPT_IN_ENGLISH);
  });
});

describe("zh terminology", () => {
  it("never uses 条 as a measure word for episodes", () => {
    // 条 survives only inside unrelated words (过滤条件, 每行一条, 空条目) —
    // never straight after a number or as the count noun 条数.
    const EPISODE_MEASURE_WORD = /(\{\w+\}\s*条|[0-9]\s*条|条数)/;
    for (const [key, value] of Object.entries(zh)) {
      expect(`${key}:${EPISODE_MEASURE_WORD.test(value)}`).toBe(`${key}:false`);
    }
  });

  it("writes units in English when they follow a number", () => {
    // Bare labels (帧数 / 任务数) are nouns and stay Chinese; this only guards
    // the "value + unit" shape.
    const CHINESE_UNIT = /\{\w+\}\s*(帧|步|秒|天|小时|字节|行|列|倍|次)/;
    for (const [key, value] of Object.entries(zh)) {
      expect(`${key}:${CHINESE_UNIT.test(value)}`).toBe(`${key}:false`);
    }
  });

  it("uses the Chinese brand name wherever the brand is spelled out", () => {
    expect(zh["brand.part1"] + zh["brand.part2"]).toBe("千觉机器人");
    for (const key of ["app.title", "app.description", "viewer.brandTitle"]) {
      expect(
        `${key}:${zh[key as keyof typeof en].includes("千觉机器人")}`,
      ).toBe(`${key}:true`);
    }
  });
});

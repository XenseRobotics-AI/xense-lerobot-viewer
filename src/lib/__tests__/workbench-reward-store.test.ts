import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultWorkbenchRewardRules,
  evaluateWorkbenchRewardRules,
  readWorkbenchRewardRules,
  workbenchRewardRulesPath,
  writeWorkbenchRewardRules,
} from "@/lib/workbench-reward-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "xense-workbench-reward-"),
  );
  temporaryRoots.push(root);
  return root;
}

describe("workbench reward rules store", () => {
  test("returns default TacVerse reward rules when no config exists", async () => {
    const root = await temporaryRoot();
    const config = await readWorkbenchRewardRules("TacVerse", root);

    expect(config.source).toBe("defaults");
    expect(config.updatedAt).toBeNull();
    expect(config.enabled).toBe(true);
    expect(config.dailyTargetHours).toBe(6);
    expect(config.levels.at(-1)?.maxPercent).toBeNull();
  });

  test("writes sanitized rules below the dataset root", async () => {
    const root = await temporaryRoot();
    const config = await writeWorkbenchRewardRules(
      "TacVerse",
      {
        enabled: true,
        dailyTargetHours: 7,
        levels: [
          { id: "a", label: "A", minPercent: 0, maxPercent: 100, amount: 0 },
          {
            id: "b",
            label: "B",
            minPercent: 100,
            maxPercent: null,
            amount: 200,
          },
        ],
      },
      root,
    );

    expect(config.source).toBe("stored");
    expect(config.dailyTargetHours).toBe(7);
    await expect(
      fs.readFile(workbenchRewardRulesPath("TacVerse", root), "utf8"),
    ).resolves.toContain('"dailyTargetHours": 7');
  });

  test("evaluates reward levels by completion percentage", () => {
    const preview = evaluateWorkbenchRewardRules(7, 6, {
      enabled: true,
      levels: [
        {
          id: "warn",
          label: "Warn",
          minPercent: 0,
          maxPercent: 100,
          amount: -10,
        },
        {
          id: "ok",
          label: "OK",
          minPercent: 100,
          maxPercent: null,
          amount: 20,
        },
      ],
    });

    expect(preview.symbol).toBe("✅");
    expect(preview.level?.id).toBe("ok");
    expect(preview.amount).toBe(20);
  });

  test("keeps organization defaults isolated", () => {
    expect(defaultWorkbenchRewardRules("TacVerse").dailyTargetHours).toBe(6);
    expect(defaultWorkbenchRewardRules("OtherOrg").levels).toEqual([
      {
        id: "below-80",
        label: "不达标",
        minPercent: 0,
        maxPercent: 80,
        amount: -160,
      },
      {
        id: "80-90",
        label: "接近",
        minPercent: 80,
        maxPercent: 90,
        amount: -60,
      },
      {
        id: "90-100",
        label: "临界",
        minPercent: 90,
        maxPercent: 100,
        amount: 0,
      },
      {
        id: "100-plus",
        label: "达标",
        minPercent: 100,
        maxPercent: null,
        amount: 200,
      },
    ]);
  });
});

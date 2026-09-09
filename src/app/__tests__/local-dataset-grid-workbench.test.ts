import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "src/app/local-dataset-grid.tsx"),
    "utf8",
  );
}

describe("Workbench entry locale contract", () => {
  test("exposes the language switcher and translates the entry controls", async () => {
    const content = await source();

    expect(content).toContain(
      'import LanguageSwitcher from "@/components/language-switcher";',
    );
    expect(content).toContain("<LanguageSwitcher />");
    expect(content).toContain('t("workbench.backToCategories")');
    expect(content).toContain('t("workbench.datasetsView")');
    expect(content).toContain('t("workbench.panelTitle")');
  });

  test("keeps organization identity data rendered as values", async () => {
    const content = await source();

    expect(content).toContain("{selectedPrefix}");
    expect(content).not.toContain('t("workbench.robotId")');
    expect(content).not.toContain('t("workbench.robotType")');
    expect(content).not.toContain("translateDataset");
  });
});

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function componentSource(file: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), "src/components", file), "utf8");
}

describe("Workbench unified Configuration UI", () => {
  test("has one entry and keeps reward rules separate", async () => {
    const panel = await componentSource("workbench-grouping-panel.tsx");
    expect(panel).toContain('t("workbench.configuration")');
    expect(panel).toContain("<WorkbenchConfigurationEditor");
    expect(panel).not.toContain("<WorkbenchPersonnelMappingEditor");
    expect(panel).toContain('t("workbench.rewardRules")');
    expect(panel).toContain("aria-pressed={mappingEditorOpen}");
    expect(panel).toContain('t("workbench.settingsModeActive"');
  });

  test("shares one draft across three tabs and protects unsaved changes", async () => {
    const editor = await componentSource("workbench-configuration-editor.tsx");
    expect(editor).toContain('"devices" | "people" | "staffing"');
    expect(editor).toContain('"Devices & Workstations"');
    expect(editor).toContain('"Personnel Directory"');
    expect(editor).toContain('"Date Staffing"');
    expect(editor).toContain("useState<WorkbenchConfigurationV2 | null>");
    expect(editor).toContain('"beforeunload"');
    expect(editor).toContain('"if-match": loaded.revision');
    expect(editor).toContain("/api/workbench/configuration?org=");
  });

  test("uses text workstations, static roles, collector slots, inheritance, and removal", async () => {
    const editor = await componentSource("workbench-configuration-editor.tsx");
    expect(editor).toContain("loaded.observedDevices");
    expect(editor).toContain("<WorkstationInput");
    expect(editor).not.toContain('title={zh ? "工位主数据" : "Workstations"}');
    expect(editor).not.toContain("Legacy left_gripper_sn aliases");
    expect(editor).not.toContain("Role effective date");
    expect(editor).not.toContain('zh ? "历史" : "History"');
    expect(editor).toContain("nextWorkbenchPersonId");
    expect(editor).toContain("removeWorkbenchPerson");
    expect(editor).toContain("resolveWorkbenchStaffing");
    expect(editor).toContain("resolveWorkbenchDeviceWorkstationId");
    expect(editor).toContain("setWorkbenchDeviceWorkstation(");
    expect(editor).toContain('"inactive"');
    expect(editor).toContain("originalCollectors");
    expect(editor).toContain("collector-");
    expect(editor).not.toContain('aria-label="quality weight"');
  });
});

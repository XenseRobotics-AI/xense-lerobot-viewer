import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkbenchPersonnelMappingEditor, {
  buildWorkbenchPersonnelConfigFromMapping,
  buildWorkbenchPersonnelMappingRows,
  DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
} from "@/components/workbench-personnel-mapping-editor";
import type { WorkbenchPersonnelConfig } from "@/types/workbench-personnel.types";
import { resolveWorkbenchPersonnelSchedule } from "@/utils/workbenchPersonnel";

function config(): WorkbenchPersonnelConfig {
  return {
    org: "TacVerse",
    updatedAt: null,
    people: [
      { id: "zhang", displayName: "张三", email: "zhang@example.com" },
      { id: "li", displayName: "李四", email: "" },
    ],
    schedules: {
      "2026-09-03": [
        {
          workstation: "A2",
          members: [
            { personId: "zhang", creditFactor: 1 },
            { personId: "li", creditFactor: 1 },
          ],
        },
      ],
    },
  };
}

describe("WorkbenchPersonnelMappingEditor", () => {
  test("renders one editable row per workstation-person relationship", () => {
    const html = renderToStaticMarkup(
      <WorkbenchPersonnelMappingEditor
        organization="TacVerse"
        config={config()}
        workstationSuggestions={["A2", "A5", "B2"]}
        defaultDay="2026-09-04"
        onSaved={() => undefined}
      />,
    );

    expect(html).toContain("Personnel mapping");
    expect(html).toContain('aria-label="Personnel mapping date"');
    expect(html).toContain('value="2026-09-04"');
    expect(html).toContain("Inherited from 2026-09-03");
    expect(html).toContain(">Personnel</th>");
    expect(html).toContain(">Email</th>");
    expect(html).toContain(">Action</th>");
    expect(html).toContain('value="张三"');
    expect(html).toContain('value="李四"');
    expect(html).toContain('value="匿名"');
    expect(html).toContain(`value="${DEFAULT_WORKBENCH_PERSONNEL_EMAIL}"`);
    expect(html.match(/value="A2"/gu)).toHaveLength(3);
    expect(html).toContain(">Add mapping</button>");
    expect(html).not.toContain("Personnel directory");
  });

  test("adds one anonymous row for each unmapped workstation", () => {
    expect(
      buildWorkbenchPersonnelMappingRows(
        config(),
        ["A2", "A5", "B2"],
        "2026-09-04",
      ),
    ).toEqual([
      {
        workstation: "A2",
        personnel: "张三",
        email: "zhang@example.com",
      },
      {
        workstation: "A2",
        personnel: "李四",
        email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
      },
      {
        workstation: "A5",
        personnel: "匿名",
        email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
      },
      {
        workstation: "B2",
        personnel: "匿名",
        email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
      },
    ]);
  });

  test("groups repeated workstations while preserving people IDs and emails", () => {
    const result = buildWorkbenchPersonnelConfigFromMapping(
      config(),
      [
        { workstation: "A2", personnel: "张三", email: "zhang@example.com" },
        {
          workstation: "A2",
          personnel: "匿名",
          email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
        },
        { workstation: "A5", personnel: "王五", email: "wang@example.com" },
      ],
      ["A2", "A5", "B2"],
      "2026-09-04",
    );

    expect(Object.keys(result.schedules)).toEqual(["2026-09-03", "2026-09-04"]);
    expect(result.people).toEqual([
      { id: "zhang", displayName: "张三", email: "zhang@example.com" },
      { id: "li", displayName: "李四", email: "" },
      {
        id: "anonymous",
        displayName: "匿名",
        email: DEFAULT_WORKBENCH_PERSONNEL_EMAIL,
      },
      { id: "person-1", displayName: "王五", email: "wang@example.com" },
    ]);
    expect(
      result.schedules["2026-09-04"].map((assignment) => [
        assignment.workstation,
        assignment.members.length,
      ]),
    ).toEqual([
      ["A2", 2],
      ["A5", 1],
      ["B2", 1],
    ]);
    expect(result.schedules["2026-09-04"][2].members[0].personId).toBe(
      "anonymous",
    );
    expect(
      resolveWorkbenchPersonnelSchedule(result.schedules, "2026-09-05"),
    ).toMatchObject({
      sourceDate: "2026-09-04",
      isExplicit: false,
    });
  });

  test("requires one consistent email for the same person", () => {
    expect(() =>
      buildWorkbenchPersonnelConfigFromMapping(config(), [
        { workstation: "A2", personnel: "张三", email: "one@example.com" },
        { workstation: "A5", personnel: "张三", email: "two@example.com" },
      ]),
    ).toThrow("Email for 张三 must be consistent across mappings.");
  });
});

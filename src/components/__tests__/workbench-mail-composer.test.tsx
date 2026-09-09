import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkbenchMailComposer from "@/components/workbench-mail-composer";
import { LocaleProvider } from "@/context/locale-context";

describe("WorkbenchMailComposer recipient selection", () => {
  test("renders deduplicated multi-select personnel emails below Send", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <WorkbenchMailComposer
          organization="TacVerse"
          recipientSuggestions={[
            { label: "张三", email: "jay@xenserobotics.com" },
            { label: "李四", email: "JAY@xenserobotics.com" },
            { label: "王五", email: "wang@xenserobotics.com" },
          ]}
          recipientGroups={[
            {
              id: "xr-workstation",
              label: "XR 工位",
              emails: ["dylan@xenserobotics.com"],
            },
            {
              id: "team-managers",
              label: "Dylan 等团队管理人员",
              emails: ["dylan@xenserobotics.com", "frank@xenserobotics.com"],
            },
            {
              id: "reward-non-negative",
              label: "Reward >=0（筛选范围内）",
              emails: ["wang@xenserobotics.com"],
            },
            {
              id: "all-personnel",
              label: "人员列表全员",
              emails: ["jay@xenserobotics.com", "wang@xenserobotics.com"],
            },
          ]}
        />
      </LocaleProvider>,
    );

    expect(html).toContain("Separate multiple email addresses with commas");
    expect(html).toContain("Recipients (multiple selection)");
    expect(html).toContain("Choose a group to fill recipients");
    expect(html).toContain("XR 工位");
    expect(html).toContain("Dylan 等团队管理人员");
    expect(html).toContain("Reward &gt;=0（筛选范围内）");
    expect(html).toContain("人员列表全员");
    expect(html).toContain("张三、李四");
    expect(html).toContain("jay@xenserobotics.com");
    expect(html).toContain("wang@xenserobotics.com");
    expect(html.match(/type="checkbox"/gu)).toHaveLength(2);
    expect(html.indexOf("Recipients (multiple selection)")).toBeGreaterThan(
      html.indexOf(">Send</button>"),
    );
  });
});

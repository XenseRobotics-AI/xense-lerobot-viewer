import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkbenchMailComposer from "@/components/workbench-mail-composer";

describe("WorkbenchMailComposer recipient selection", () => {
  test("renders deduplicated multi-select personnel emails below Send", () => {
    const html = renderToStaticMarkup(
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
      />,
    );

    expect(html).toContain("多个邮箱使用逗号分隔");
    expect(html).toContain("收件人邮箱（可多选）");
    expect(html).toContain("选择分组，自动填充邮箱");
    expect(html).toContain("XR 工位");
    expect(html).toContain("Dylan 等团队管理人员");
    expect(html).toContain("Reward &gt;=0（筛选范围内）");
    expect(html).toContain("人员列表全员");
    expect(html).toContain("张三、李四");
    expect(html).toContain("jay@xenserobotics.com");
    expect(html).toContain("wang@xenserobotics.com");
    expect(html.match(/type="checkbox"/gu)).toHaveLength(2);
    expect(html.indexOf("收件人邮箱（可多选）")).toBeGreaterThan(
      html.indexOf(">发送</button>"),
    );
  });
});

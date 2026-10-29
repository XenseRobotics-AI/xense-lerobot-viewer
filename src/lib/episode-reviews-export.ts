import { reviewTimestamp } from "@/utils/reviewTime";
import {
  reviewStatus,
  type ReviewCollectionFile,
} from "@/types/episode-review.types";

/** One row per inspector, retaining all independent checks for analysis. */
export function reviewCollectionCsv(collection: ReviewCollectionFile): string {
  const rows: (string | number)[][] = [
    [
      "数据集",
      "Episode",
      "姓名",
      "角色",
      "检查时间（UTC+8）",
      "入口",
      "检查状态",
      "检查人数",
    ],
  ];
  for (const [dataset, file] of Object.entries(collection.datasets).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    for (const [episode, entries] of Object.entries(file.episodes).sort(
      ([a], [b]) => Number(a) - Number(b),
    )) {
      const status = reviewStatus(entries);
      for (const record of entries)
        rows.push([
          dataset,
          Number(episode),
          record.reviewer,
          record.role === "admin"
            ? "管理员"
            : record.role === "developer"
              ? "开发者"
              : record.role === "inspector"
                ? "质检员"
                : "",
          reviewTimestamp(record.reviewed_at),
          record.source === "urdf" ? "3D REPLAY" : "EPISODE",
          status === "crossReviewed" ? "已交叉复检" : "待交叉复检",
          new Set(entries.map((entry) => entry.reviewer)).size,
        ]);
    }
  }
  const escape = (value: string | number) => {
    let text = String(value);
    // Prevent names/paths from being interpreted as spreadsheet formulas.
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return (
    "\uFEFF" +
    rows.map((row) => row.map(escape).join(",")).join("\r\n") +
    "\r\n"
  );
}

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "src/components/urdf-video-overlay.tsx"),
    "utf8",
  );
}

describe("3D Replay video sizing", () => {
  test("sizes defaults from the actual overlay width", async () => {
    const overlay = await source();
    expect(overlay).toContain("ResizeObserver");
    expect(overlay).toContain("overlay.getBoundingClientRect().width");
    expect(overlay).toContain("clampWidth(overlayWidth * defaultWidthRatio)");
    expect(overlay).toContain("defaultWidthRatio={0.3}");
    expect(overlay).toContain("defaultWidthRatio={hasSingleHead ? 0.2 : 0.34}");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRegistryRoot, loadAutoAnnotation } from "@/lib/auto-annotations";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((r) => fs.rm(r, { recursive: true, force: true })),
  );
});

async function corpus(
  report: unknown,
  reportRel = "reports/ds/annotate-1/annotations.json",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-ann-"));
  roots.push(root);
  const dataset = path.join(root, "released", "ds");
  await fs.mkdir(path.join(dataset, "meta"), { recursive: true });
  const registry = path.join(root, ".registry");
  await fs.mkdir(path.join(registry, "datasets"), { recursive: true });
  await fs.writeFile(
    path.join(registry, "datasets", "ds.json"),
    JSON.stringify({
      stages: {
        annotate: {
          status: "done",
          at: "2026-10-30T13:21:21+00:00",
          report: reportRel,
        },
      },
    }),
  );
  const file = path.join(registry, reportRel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report));
  return { dataset, registry };
}

const REPORT = {
  schema: "tacflow.annotate.dataset/1",
  dataset: "ds",
  models: ["gpt-6.1-terra"],
  episodes_total: 1,
  episodes_usable: 1,
  episodes: [
    {
      episode_index: 0,
      usable: true,
      problems: [],
      labels: {
        completion: { task_completed: "success" },
        timeline: [{ start_s: 0, end_s: 2, action: "grasp" }],
      },
    },
  ],
};

describe("loadAutoAnnotation", () => {
  test("finds the corpus registry two levels up and reads the episode", async () => {
    const { dataset, registry } = await corpus(REPORT);
    expect(await findRegistryRoot(dataset)).toBe(registry);
    const found = await loadAutoAnnotation(dataset, 0);
    expect(found.status).toBe("ok");
    if (found.status === "ok") {
      expect(found.body.episode?.outcome).toBe("success");
      expect(found.body.episode?.timeline[0].action).toBe("grasp");
      expect(found.body.annotated_at).toBe("2026-10-30T13:21:21+00:00");
    }
    const missing = await loadAutoAnnotation(dataset, 7);
    expect(missing.status === "ok" && missing.body.episode).toBeNull();
  });

  test("refuses a report path that escapes the registry", async () => {
    const { dataset } = await corpus(REPORT, "../outside.json");
    const found = await loadAutoAnnotation(dataset, 0);
    expect(found.status).toBe("none");
  });

  test("refuses a file that is not the annotate report schema", async () => {
    const { dataset } = await corpus({ ...REPORT, schema: "something/else" });
    expect((await loadAutoAnnotation(dataset, 0)).status).toBe("none");
  });

  test("a dataset without a registry has nothing to show", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-ann-none-"));
    roots.push(root);
    expect((await loadAutoAnnotation(path.join(root, "ds"), 0)).status).toBe(
      "none",
    );
  });
});

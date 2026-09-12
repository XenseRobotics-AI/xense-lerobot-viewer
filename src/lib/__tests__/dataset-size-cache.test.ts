import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDatasetSizeResolver,
  datasetSizeCachePath,
  datasetSizeFingerprint,
} from "@/lib/dataset-size-cache";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A dataset shaped like the parts the fingerprint looks at. */
async function makeDataset(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "meta"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "chunk-000"), { recursive: true });
  await fs.mkdir(path.join(dir, "videos", "chunk-000"), { recursive: true });
  await fs.writeFile(path.join(dir, "meta", "info.json"), "{}");
  await fs.writeFile(
    path.join(dir, "data", "chunk-000", "file-000.parquet"),
    "x",
  );
}

afterAll(async () => {
  await Promise.all(
    temps.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("datasetSizeFingerprint", () => {
  test("is stable for an untouched dataset", async () => {
    const dir = await tempDir("fp-stable-");
    await makeDataset(dir);
    expect(await datasetSizeFingerprint(dir)).toBe(
      await datasetSizeFingerprint(dir),
    );
  });

  test("changes when a file appears inside a chunk directory", async () => {
    // The case the dataset directory's own mtime cannot see: mtime only moves
    // on the *direct* parent, and `export_subtasks.py` writes down here.
    const dir = await tempDir("fp-chunk-");
    await makeDataset(dir);
    const before = await datasetSizeFingerprint(dir);
    await fs.writeFile(
      path.join(dir, "data", "chunk-000", "file-000.parquet.bak"),
      "y",
    );
    expect(await datasetSizeFingerprint(dir)).not.toBe(before);
  });

  test("changes when a whole directory appears", async () => {
    const dir = await tempDir("fp-newdir-");
    await makeDataset(dir);
    const before = await datasetSizeFingerprint(dir);
    await fs.mkdir(path.join(dir, "videos", "chunk-001"));
    expect(await datasetSizeFingerprint(dir)).not.toBe(before);
  });

  test("does not throw on a directory that is not a dataset", async () => {
    const dir = await tempDir("fp-bare-");
    expect(typeof (await datasetSizeFingerprint(dir))).toBe("string");
  });
});

describe("createDatasetSizeResolver", () => {
  test("walks on a miss and reuses on a hit", async () => {
    const root = await tempDir("size-root-");
    const dataset = path.join(root, "ds");
    await makeDataset(dataset);

    let walks = 0;
    const first = await createDatasetSizeResolver(root, async () => {
      walks += 1;
      return 4242;
    });
    expect(await first.sizeOf(dataset)).toBe(4242);
    expect(walks).toBe(1);
    await first.flush();

    // A second scan of the same untouched dataset must not walk again.
    const second = await createDatasetSizeResolver(root, async () => {
      walks += 1;
      return 9999;
    });
    expect(await second.sizeOf(dataset)).toBe(4242);
    expect(walks).toBe(1);
  });

  test("re-walks once the dataset changes", async () => {
    const root = await tempDir("size-change-");
    const dataset = path.join(root, "ds");
    await makeDataset(dataset);

    const first = await createDatasetSizeResolver(root, async () => 10);
    await first.sizeOf(dataset);
    await first.flush();

    await fs.writeFile(path.join(dataset, "data", "chunk-000", "extra"), "z");
    const second = await createDatasetSizeResolver(root, async () => 20);
    expect(await second.sizeOf(dataset)).toBe(20);
  });

  test("keys on the absolute directory, so locations coexist", async () => {
    const root = await tempDir("size-multi-");
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await makeDataset(a);
    await makeDataset(b);

    const write = await createDatasetSizeResolver(root, async (dir) =>
      dir === a ? 1 : 2,
    );
    await write.sizeOf(a);
    await write.sizeOf(b);
    await write.flush();

    const read = await createDatasetSizeResolver(root, async () => {
      throw new Error("should not walk");
    });
    expect(await read.sizeOf(a)).toBe(1);
    expect(await read.sizeOf(b)).toBe(2);
  });

  test("a corrupt store degrades to walking", async () => {
    const root = await tempDir("size-corrupt-");
    const dataset = path.join(root, "ds");
    await makeDataset(dataset);
    const file = datasetSizeCachePath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");

    const resolver = await createDatasetSizeResolver(root, async () => 7);
    expect(await resolver.sizeOf(dataset)).toBe(7);
    await resolver.flush();
    // …and the next scan reads back what this one repaired.
    const next = await createDatasetSizeResolver(root, async () => 8);
    expect(await next.sizeOf(dataset)).toBe(7);
  });

  test("flush writes nothing when the scan learned nothing", async () => {
    const root = await tempDir("size-noop-");
    const resolver = await createDatasetSizeResolver(root, async () => 1);
    await resolver.flush();
    await expect(fs.stat(datasetSizeCachePath(root))).rejects.toThrow();
  });
});

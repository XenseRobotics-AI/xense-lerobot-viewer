import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  directorySizeBytes,
  discoverLocalDatasets,
} from "@/lib/local-datasets-discovery";
import { addLocation } from "@/lib/dataset-locations-store";
import { decodeLocalDatasetPath } from "@/utils/datasetRoute";

const roots: string[] = [];

async function tempTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ds-size-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("directorySizeBytes", () => {
  test("sums files across nested directories", async () => {
    const root = await tempTree();
    await fs.mkdir(path.join(root, "data", "chunk-000"), { recursive: true });
    await fs.mkdir(path.join(root, "meta"), { recursive: true });
    await fs.writeFile(
      path.join(root, "data", "chunk-000", "a.parquet"),
      "x".repeat(100),
    );
    await fs.writeFile(path.join(root, "meta", "info.json"), "y".repeat(25));

    expect(await directorySizeBytes(root)).toBe(125);
  });

  test("counts the sync bookkeeping cache that discovery skips", async () => {
    const root = await tempTree();
    await fs.mkdir(path.join(root, ".cache", "huggingface"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, ".cache", "huggingface", "meta"),
      "z".repeat(40),
    );

    // It occupies disk, so it belongs in the storage figure even though the
    // dataset scanner ignores `.cache` when looking for datasets.
    expect(await directorySizeBytes(root)).toBe(40);
  });

  test("does not follow symlinks — linked bytes belong to their owner", async () => {
    const outside = await tempTree();
    await fs.writeFile(path.join(outside, "big.mp4"), "v".repeat(500));

    const root = await tempTree();
    await fs.writeFile(path.join(root, "small.parquet"), "s".repeat(10));
    await fs.symlink(
      path.join(outside, "big.mp4"),
      path.join(root, "link.mp4"),
    );
    await fs.symlink(outside, path.join(root, "linked-dir"));

    expect(await directorySizeBytes(root)).toBe(10);
  });

  test("returns 0 for a missing directory rather than throwing", async () => {
    const root = await tempTree();
    expect(await directorySizeBytes(path.join(root, "nope"))).toBe(0);
  });

  test("an unreadable subtree contributes nothing but does not fail the scan", async () => {
    const root = await tempTree();
    await fs.writeFile(path.join(root, "readable.bin"), "r".repeat(70));
    const locked = path.join(root, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "hidden.bin"), "h".repeat(999));
    await fs.chmod(locked, 0o000);

    const size = await directorySizeBytes(root);
    await fs.chmod(locked, 0o755); // restore so cleanup can remove it

    // Running as root defeats the permission bit; accept either outcome rather
    // than making the suite depend on who runs it.
    expect([70, 1069]).toContain(size);
  });
});

describe("discoverLocalDatasets with a switched path", () => {
  const savedRoot = process.env.LOCAL_DATASET_ROOT;

  afterAll(() => {
    if (savedRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
    else process.env.LOCAL_DATASET_ROOT = savedRoot;
  });

  async function dataset(dir: string): Promise<void> {
    await fs.mkdir(path.join(dir, "meta"), { recursive: true });
    await fs.mkdir(path.join(dir, "data"), { recursive: true });
    await fs.mkdir(path.join(dir, "videos"), { recursive: true });
    await fs.writeFile(path.join(dir, "data", "x.parquet"), "d");
    await fs.writeFile(path.join(dir, "videos", "x.mp4"), "v");
    await fs.writeFile(
      path.join(dir, "meta", "info.json"),
      JSON.stringify({
        codebase_version: "v3.0",
        total_episodes: 2,
        total_frames: 40,
        fps: 20,
        features: {},
      }),
    );
  }

  test("scans the root by default and the selected location when asked", async () => {
    const root = await tempTree();
    await dataset(path.join(root, "Xense", "in-root"));
    const archive = await tempTree();
    await dataset(path.join(archive, "TacVerse-RDT"));
    process.env.LOCAL_DATASET_ROOT = root;
    await addLocation(root, archive);

    const byRoot = await discoverLocalDatasets();
    expect(byRoot.browsePath).toBe(path.resolve(root));
    expect(byRoot.locations).toEqual([archive]);
    expect(byRoot.datasets.map((ds) => ds.relativePath)).toEqual([
      "Xense/in-root",
    ]);
    // Under the root, routes stay relative — nothing about them changes.
    expect(decodeLocalDatasetPath(byRoot.datasets[0].encodedPath)).toBe(
      "Xense/in-root",
    );

    const switched = await discoverLocalDatasets(archive);
    expect(switched.root).toBe(path.resolve(root));
    expect(switched.browsePath).toBe(archive);
    expect(switched.datasets.map((ds) => ds.relativePath)).toEqual([
      "TacVerse-RDT",
    ]);
    // Away from the root, the absolute path is what the file routes need.
    expect(decodeLocalDatasetPath(switched.datasets[0].encodedPath)).toBe(
      path.join(archive, "TacVerse-RDT"),
    );
  });

  test("a location that is itself a dataset is listed under its own name", async () => {
    const root = await tempTree();
    process.env.LOCAL_DATASET_ROOT = root;
    const archive = await tempTree();
    const only = path.join(archive, "TacVerse-RDT");
    await dataset(only);
    await addLocation(root, only);

    const result = await discoverLocalDatasets(only);
    expect(result.browsePath).toBe(only);
    expect(result.datasets.map((ds) => ds.relativePath)).toEqual([
      "TacVerse-RDT",
    ]);
    expect(decodeLocalDatasetPath(result.datasets[0].encodedPath)).toBe(only);
  });

  test("an unknown path falls back to the root; a vanished one is reported", async () => {
    const root = await tempTree();
    await dataset(path.join(root, "Xense", "in-root"));
    process.env.LOCAL_DATASET_ROOT = root;

    const stranger = await discoverLocalDatasets("/not/a/known/location");
    expect(stranger.browsePath).toBe(path.resolve(root));
    expect(stranger.datasets).toHaveLength(1);

    const gone = path.join(await tempTree(), "unmounted");
    await fs.mkdir(gone);
    await addLocation(root, gone);
    await fs.rmdir(gone);
    const missing = await discoverLocalDatasets(gone);
    expect(missing.browsePath).toBe(gone);
    expect(missing.datasets).toEqual([]);
    expect(missing.errors[0].message).toMatch(/does not exist/);
  });
});

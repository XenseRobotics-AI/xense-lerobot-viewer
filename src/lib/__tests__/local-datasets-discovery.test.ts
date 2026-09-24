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

/**
 * A conversion that stopped part-way writes `meta/.checkpoint.json` and no
 * `meta/info.json` (`xense-dataset-convert/hdf52lerobot/checkpoint.py`). It is
 * surfaced separately, and the point of most of these tests is the *separate*:
 * a finished dataset must be scanned, sized and summarised exactly as before.
 */
describe("interrupted conversions", () => {
  const savedRoot = process.env.LOCAL_DATASET_ROOT;

  afterAll(() => {
    if (savedRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
    else process.env.LOCAL_DATASET_ROOT = savedRoot;
  });

  async function finished(dir: string): Promise<void> {
    await fs.mkdir(path.join(dir, "meta"), { recursive: true });
    await fs.mkdir(path.join(dir, "data"), { recursive: true });
    await fs.mkdir(path.join(dir, "videos"), { recursive: true });
    await fs.writeFile(path.join(dir, "data", "x.parquet"), "d".repeat(64));
    await fs.writeFile(path.join(dir, "videos", "x.mp4"), "v".repeat(32));
    await fs.writeFile(
      path.join(dir, "meta", "info.json"),
      JSON.stringify({
        codebase_version: "v3.0",
        robot_type: "bi_rdt_gripper",
        total_episodes: 2,
        total_frames: 40,
        fps: 20,
        features: {},
      }),
    );
  }

  async function checkpoint(dir: string, body: string): Promise<void> {
    await fs.mkdir(path.join(dir, "meta"), { recursive: true });
    await fs.mkdir(path.join(dir, "data"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "data", "partial.parquet"),
      "p".repeat(90),
    );
    await fs.writeFile(path.join(dir, "meta", ".checkpoint.json"), body);
  }

  const resumable = (episodes: number) =>
    JSON.stringify({
      version: 1,
      config_fingerprint: "abc",
      converted: Array.from({ length: episodes }, (_, i) => `ep${i}.hdf5`),
      skipped: [],
      sources: [],
      writer: {},
      videos: {},
    });

  test("is listed on its own, with its progress, and never as a dataset", async () => {
    const root = await tempTree();
    process.env.LOCAL_DATASET_ROOT = root;
    await checkpoint(path.join(root, "TacVerse", "stopped-0810"), resumable(3));

    const result = await discoverLocalDatasets();
    expect(result.datasets).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.interrupted).toHaveLength(1);
    expect(result.interrupted[0].relativePath).toBe("TacVerse/stopped-0810");
    expect(result.interrupted[0].episodesConverted).toBe(3);
    // The bytes it is holding are the reason it is shown at all.
    expect(result.interrupted[0].sizeBytes).toBeGreaterThan(0);
    expect(result.interrupted[0].updatedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * The regression the feature was conditioned on: a finished dataset renders
   * from `LocalDatasetSummary`, so if that object is byte-identical with and
   * without a stopped conversion in the tree, its card is too. `DatasetCardGrid`
   * is not touched by this feature at all — it never receives the new list —
   * so its props are the whole surface that could have moved.
   */
  test("a stopped conversion beside a dataset changes nothing about the dataset", async () => {
    const root = await tempTree();
    process.env.LOCAL_DATASET_ROOT = root;
    await finished(path.join(root, "TacVerse", "done-0810"));

    const before = await discoverLocalDatasets();
    expect(before.datasets).toHaveLength(1);
    expect(before.interrupted).toEqual([]);

    await checkpoint(path.join(root, "TacVerse", "stopped-0810"), resumable(7));
    const after = await discoverLocalDatasets();

    // Same fields, same values, same order — including sizeBytes, which is the
    // one thing a shared size cache could have disturbed.
    expect(JSON.stringify(after.datasets)).toBe(
      JSON.stringify(before.datasets),
    );
    expect(after.interrupted).toHaveLength(1);
    expect(after.interrupted[0].episodesConverted).toBe(7);
  });

  /**
   * A finished run deletes its checkpoint last, so a crash between the two
   * leaves both files. `info.json` is what marks a dataset finished, so this is
   * a dataset with litter in it, not an interruption — the same call
   * `Checkpoint.load` makes.
   */
  test("a leftover checkpoint inside a finished dataset is ignored", async () => {
    const plain = await tempTree();
    process.env.LOCAL_DATASET_ROOT = plain;
    await finished(path.join(plain, "TacVerse", "done-0810"));
    const clean = await discoverLocalDatasets();

    const littered = await tempTree();
    process.env.LOCAL_DATASET_ROOT = littered;
    const dir = path.join(littered, "TacVerse", "done-0810");
    await finished(dir);
    await fs.writeFile(
      path.join(dir, "meta", ".checkpoint.json"),
      resumable(2),
    );
    const result = await discoverLocalDatasets();

    expect(result.interrupted).toEqual([]);
    expect(result.datasets).toHaveLength(1);
    // Identical but for the bytes the extra file adds, which is the honest
    // difference: the card reports what is on disk.
    const strip = (json: string) => json.replace(/"sizeBytes":\d+/g, "");
    expect(strip(JSON.stringify(result.datasets))).toBe(
      strip(JSON.stringify(clean.datasets)),
    );
    expect(result.datasets[0].sizeBytes).toBeGreaterThan(
      clean.datasets[0].sizeBytes,
    );
  });

  test("an unreadable or unknown-version checkpoint still surfaces, without a count", async () => {
    const root = await tempTree();
    process.env.LOCAL_DATASET_ROOT = root;
    await checkpoint(path.join(root, "torn"), '{"version": 1, "conve');
    await checkpoint(
      path.join(root, "future"),
      JSON.stringify({ version: 2, converted: ["a", "b"] }),
    );

    const result = await discoverLocalDatasets();
    const byName = Object.fromEntries(
      result.interrupted.map((entry) => [entry.relativePath, entry]),
    );
    // Both are directories holding bytes that nothing else would report; a
    // checkpoint the converter would refuse to resume from is still worth
    // naming, just without claiming progress it cannot read.
    expect(byName["torn"].episodesConverted).toBeNull();
    expect(byName["future"].episodesConverted).toBeNull();
  });

  test("a directory with neither file is not listed anywhere", async () => {
    const root = await tempTree();
    process.env.LOCAL_DATASET_ROOT = root;
    await fs.mkdir(path.join(root, "TacVerse", "empty-shell", "data"), {
      recursive: true,
    });

    const result = await discoverLocalDatasets();
    expect(result.datasets).toEqual([]);
    expect(result.interrupted).toEqual([]);
  });

  test("a browsed location that is itself a stopped conversion names itself", async () => {
    const root = await tempTree();
    process.env.LOCAL_DATASET_ROOT = root;
    const archive = await tempTree();
    const only = path.join(archive, "xtac-rdt-umi-stopped-0810");
    await checkpoint(only, resumable(1));
    await addLocation(root, only);

    const result = await discoverLocalDatasets(only);
    expect(result.browsePath).toBe(only);
    expect(result.interrupted.map((entry) => entry.relativePath)).toEqual([
      "xtac-rdt-umi-stopped-0810",
    ]);
  });
});

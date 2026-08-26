import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  directorySizeBytes,
  readDatasetHardwareValue,
} from "@/lib/local-datasets-discovery";

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

describe("readDatasetHardwareValue", () => {
  test("reads the legacy top-level units format", () => {
    expect(
      readDatasetHardwareValue({
        robot_type: "bi_taccap_gripper",
        units: [
          { side: "right", gripper_sn: "TCGU01A28Z9999m" },
          { side: "left", gripper_sn: "TCGU01A28Z0033m" },
        ],
      }),
    ).toBe("TCGU01A28Z0033m");
  });

  test("falls back to the latest epoch units format", () => {
    expect(
      readDatasetHardwareValue({
        robot_type: "bi_taccap_gripper",
        epochs: [
          {
            from_episode: 0,
            to_episode: 20,
            units: [{ side: "left", gripper_sn: "TCGU01A28Z0061m" }],
          },
          {
            from_episode: 20,
            to_episode: 40,
            units: [{ side: "left", gripper_sn: "TCGU01A28Z0041m" }],
          },
        ],
      }),
    ).toBe("TCGU01A28Z0041m");
  });
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

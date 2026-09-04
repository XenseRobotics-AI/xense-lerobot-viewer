import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browsePathCookieString } from "@/utils/browsePath";
import {
  addLocation,
  browseDirectory,
  countDatasetsUnder,
  locationsFilePath,
  normalizeLocationInput,
  readLocations,
  removeLocation,
  resolveBrowsePath,
} from "@/lib/dataset-locations-store";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function makeDataset(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "meta"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "meta", "info.json"),
    JSON.stringify({ codebase_version: "v3.0", total_episodes: 1 }),
  );
}

const originalHome = process.env.HOME;

beforeAll(() => {
  process.env.HOME = "/home/tester";
});

afterAll(async () => {
  process.env.HOME = originalHome;
  await Promise.all(
    temps.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("normalizeLocationInput", () => {
  test("accepts absolute paths and resolves dots", () => {
    expect(normalizeLocationInput(" /archive/TacVerse/../TacVerse/x/ ")).toBe(
      "/archive/TacVerse/x",
    );
  });

  test("expands ~ and file://", () => {
    expect(normalizeLocationInput("~/data")).toBe("/home/tester/data");
    expect(normalizeLocationInput("file:///archive/a%20b")).toBe(
      "/archive/a b",
    );
  });

  test("refuses relative and empty paths", () => {
    expect(() => normalizeLocationInput("archive/x")).toThrow(/absolute/);
    expect(() => normalizeLocationInput("   ")).toThrow(/empty/);
  });
});

describe("locations store", () => {
  test("adds, lists, dedupes and removes a path", async () => {
    const root = await tempDir("loc-root-");
    const outside = await tempDir("loc-outside-");
    await makeDataset(path.join(outside, "org", "ds"));

    expect(await readLocations(root)).toEqual([]);

    const added = await addLocation(root, outside);
    expect(added.locations.map((entry) => entry.path)).toEqual([outside]);
    expect(added.inspection.datasetCount).toBe(1);
    expect(added.inspection.isDataset).toBe(false);

    // Adding again is a no-op, not an error, and does not grow the list.
    const again = await addLocation(root, `${outside}/`);
    expect(again.locations).toHaveLength(1);

    const stored = JSON.parse(
      await fs.readFile(locationsFilePath(root), "utf-8"),
    ) as { version: number; locations: { path: string }[] };
    expect(stored.version).toBe(1);
    expect(stored.locations[0].path).toBe(outside);

    expect(await removeLocation(root, outside)).toEqual([]);
    expect(await readLocations(root)).toEqual([]);
  });

  test("refuses a missing path, a file, and the default root", async () => {
    const root = await tempDir("loc-root-");
    const file = path.join(root, "not-a-dir");
    await fs.writeFile(file, "x");

    await expect(addLocation(root, "/definitely/not/here")).rejects.toThrow(
      /does not exist/,
    );
    await expect(addLocation(root, file)).rejects.toThrow(/Not a directory/);
    await expect(addLocation(root, root)).rejects.toThrow(
      /default dataset root/,
    );
    expect(await readLocations(root)).toEqual([]);
  });

  test("tolerates a corrupt or foreign file", async () => {
    const root = await tempDir("loc-root-");
    await fs.mkdir(path.dirname(locationsFilePath(root)), { recursive: true });
    await fs.writeFile(locationsFilePath(root), "{not json");
    expect(await readLocations(root)).toEqual([]);
    await fs.writeFile(
      locationsFilePath(root),
      JSON.stringify({ version: 1, locations: [{ path: "relative" }, 3] }),
    );
    expect(await readLocations(root)).toEqual([]);
  });
});

describe("resolveBrowsePath", () => {
  test("honours a listed location and refuses anything else", async () => {
    const root = await tempDir("loc-root-");
    const listed = await tempDir("loc-listed-");
    const stranger = await tempDir("loc-stranger-");
    await addLocation(root, listed);

    expect(await resolveBrowsePath(root, listed)).toBe(listed);
    expect(await resolveBrowsePath(root, `${listed}/`)).toBe(listed);
    expect(await resolveBrowsePath(root, root)).toBe(root);

    // A cookie is user input: a path nobody added must not steer the scan.
    expect(await resolveBrowsePath(root, stranger)).toBe(root);
    expect(await resolveBrowsePath(root, "not-absolute")).toBe(root);
    expect(await resolveBrowsePath(root, undefined)).toBe(root);
    expect(await resolveBrowsePath(root, "  ")).toBe(root);

    // Forgetting a path also stops it from being browsed.
    await removeLocation(root, listed);
    expect(await resolveBrowsePath(root, listed)).toBe(root);
  });
});

describe("browsePathCookieString", () => {
  test("encodes the path and scopes the cookie to the site", () => {
    const cookie = browsePathCookieString("/archive/Tac Verse");
    expect(cookie).toContain("xense-browse-path=%2Farchive%2FTac%20Verse");
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("countDatasetsUnder / browseDirectory", () => {
  test("counts a dataset as itself and nested ones up to the scan depth", async () => {
    const dir = await tempDir("loc-count-");
    await makeDataset(path.join(dir, "a"));
    await makeDataset(path.join(dir, "b", "c"));
    await makeDataset(path.join(dir, "too", "deep", "for", "scan"));
    expect(await countDatasetsUnder(dir)).toBe(2);
    expect(await countDatasetsUnder(path.join(dir, "a"))).toBe(1);
  });

  test("lists subdirectories, flags datasets, hides dot-directories", async () => {
    const dir = await tempDir("loc-browse-");
    await makeDataset(path.join(dir, "ds"));
    await fs.mkdir(path.join(dir, "plain"));
    await fs.mkdir(path.join(dir, ".hidden"));
    await fs.writeFile(path.join(dir, "file.txt"), "x");

    const listing = await browseDirectory(dir);
    expect(listing.path).toBe(dir);
    expect(listing.parent).toBe(path.dirname(dir));
    expect(listing.isDataset).toBe(false);
    expect(listing.entries).toEqual([
      { name: "ds", path: path.join(dir, "ds"), isDataset: true },
      { name: "plain", path: path.join(dir, "plain"), isDataset: false },
    ]);

    const rootListing = await browseDirectory("/");
    expect(rootListing.parent).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultWorkbenchWorkstationMappings,
  readWorkbenchWorkstationMappings,
  workbenchWorkstationMappingsPath,
  writeWorkbenchWorkstationMappings,
} from "@/lib/workbench-config-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "xense-workbench-config-"),
  );
  temporaryRoots.push(root);
  return root;
}

describe("workbench workstation mapping store", () => {
  test("returns default TacVerse workstation mappings when no config exists", async () => {
    const root = await temporaryRoot();
    const config = await readWorkbenchWorkstationMappings("TacVerse", root);

    expect(config.source).toBe("defaults");
    expect(config.updatedAt).toBeNull();
    expect(config.mappings.TCGU01A28Z0033m).toBe("N0");
    expect(config.mappings.TCGU01A28Z0071m).toBe("E4");
  });

  test("keeps repo defaults scoped by organization", async () => {
    const root = await temporaryRoot();

    expect(defaultWorkbenchWorkstationMappings("TacVerse")).toMatchObject({
      TCGU01A28Z0033m: "N0",
      TCGU01A28Z0071m: "E4",
    });
    await expect(
      readWorkbenchWorkstationMappings("OtherOrg", root),
    ).resolves.toMatchObject({
      source: "defaults",
      mappings: {},
    });
  });

  test("writes sanitized mappings below the dataset root", async () => {
    const root = await temporaryRoot();
    const config = await writeWorkbenchWorkstationMappings(
      "TacVerse",
      {
        " TCGU01A28Z0069m ": " D2 ",
        empty: " ",
      },
      root,
    );

    expect(config.source).toBe("stored");
    expect(config.mappings).toEqual({ TCGU01A28Z0069m: "D2" });
    await expect(
      fs.readFile(workbenchWorkstationMappingsPath("TacVerse", root), "utf8"),
    ).resolves.toContain('"TCGU01A28Z0069m": "D2"');
  });

  test("keeps workstation mappings scoped by organization", async () => {
    const root = await temporaryRoot();
    await writeWorkbenchWorkstationMappings(
      "TacVerse",
      { TCGU01A28Z0069m: "D2" },
      root,
    );
    await writeWorkbenchWorkstationMappings(
      "OtherOrg",
      { TCGU01A28Z0069m: "A1" },
      root,
    );

    await expect(
      readWorkbenchWorkstationMappings("TacVerse", root),
    ).resolves.toMatchObject({
      source: "stored",
      mappings: { TCGU01A28Z0069m: "D2" },
    });
    await expect(
      readWorkbenchWorkstationMappings("OtherOrg", root),
    ).resolves.toMatchObject({
      source: "stored",
      mappings: { TCGU01A28Z0069m: "A1" },
    });
  });
});

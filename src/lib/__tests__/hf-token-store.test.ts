import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearViewerHfToken,
  readViewerHfToken,
  resolveHfToken,
  tokenStorePath,
  writeViewerHfToken,
} from "@/lib/hf-token-store";

const originalHfToken = process.env.HF_TOKEN;
const originalHfHome = process.env.HF_HOME;
const originalTokenPath = process.env.HF_TOKEN_PATH;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (originalHfToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = originalHfToken;
  if (originalHfHome === undefined) delete process.env.HF_HOME;
  else process.env.HF_HOME = originalHfHome;
  if (originalTokenPath === undefined) delete process.env.HF_TOKEN_PATH;
  else process.env.HF_TOKEN_PATH = originalTokenPath;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-hf-token-"));
  temporaryRoots.push(root);
  return root;
}

describe("viewer Hugging Face token store", () => {
  test("writes atomically below the dataset root and reads the exact token", async () => {
    const root = await temporaryRoot();
    await writeViewerHfToken("  hf_test_secret  ", root);
    expect(await readViewerHfToken(root)).toBe("hf_test_secret");
    expect(await fs.readFile(tokenStorePath(root), "utf8")).toBe(
      "hf_test_secret\n",
    );

    if (process.platform !== "win32") {
      const mode = (await fs.stat(tokenStorePath(root))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("viewer token wins over environment and cache credentials", async () => {
    const root = await temporaryRoot();
    process.env.HF_TOKEN = "hf_environment";
    await writeViewerHfToken("hf_viewer", root);
    await expect(resolveHfToken(root)).resolves.toEqual({
      token: "hf_viewer",
      source: "viewer",
    });
  });

  test("clear removes only the viewer-owned token", async () => {
    const root = await temporaryRoot();
    process.env.HF_TOKEN = "hf_environment";
    await writeViewerHfToken("hf_viewer", root);
    await clearViewerHfToken(root);
    expect(await readViewerHfToken(root)).toBeNull();
    await expect(resolveHfToken(root)).resolves.toEqual({
      token: "hf_environment",
      source: "environment",
    });
  });

  test("invalid writes are rejected without creating a credential", async () => {
    const root = await temporaryRoot();
    await expect(writeViewerHfToken("   ", root)).rejects.toThrow();
    expect(await readViewerHfToken(root)).toBeNull();
  });
});

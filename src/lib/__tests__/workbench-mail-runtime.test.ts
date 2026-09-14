import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertWorkbenchSmtpPasswordConfigured,
  workbenchSmtpPasswordFilePath,
  writeWorkbenchSmtpPassword,
} from "@/lib/workbench-mail-runtime";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xense-smtp-runtime-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Workbench SMTP runtime", () => {
  test("uses provider-specific files under the local dataset root", () => {
    expect(workbenchSmtpPasswordFilePath("qq", root)).toBe(
      path.join(root, ".xense-viewer/secrets/smtp-qq-authorization-code"),
    );
    expect(workbenchSmtpPasswordFilePath("163", root)).toBe(
      path.join(root, ".xense-viewer/secrets/smtp-163-authorization-code"),
    );
  });

  test("atomically stores separate provider codes with private permissions", async () => {
    await writeWorkbenchSmtpPassword(" qq-code ", "qq", root);
    await writeWorkbenchSmtpPassword("163-code", "163", root);

    const qqPath = workbenchSmtpPasswordFilePath("qq", root);
    const neteasePath = workbenchSmtpPasswordFilePath("163", root);
    await expect(fs.readFile(qqPath, "utf8")).resolves.toBe("qq-code\n");
    await expect(fs.readFile(neteasePath, "utf8")).resolves.toBe("163-code\n");
    expect((await fs.stat(path.join(root, ".xense-viewer"))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await fs.stat(path.join(root, ".xense-viewer/secrets"))).mode & 0o777,
    ).toBe(0o700);
    expect((await fs.stat(qqPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(neteasePath)).mode & 0o777).toBe(0o600);
  });

  test("reports a missing provider authorization code clearly", async () => {
    await expect(
      assertWorkbenchSmtpPasswordConfigured("qq", root),
    ).rejects.toThrow("Missing QQ SMTP authorization code");
    await writeWorkbenchSmtpPassword("163-code", "163", root);
    await expect(
      assertWorkbenchSmtpPasswordConfigured("163", root),
    ).resolves.toBe(workbenchSmtpPasswordFilePath("163", root));
  });
});

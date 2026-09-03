import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/workbench/smtp-password/route";

const previousPasswordFile = process.env.SMTP_PASSWORD_FILE;
let tempDir: string;
let passwordFile: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-smtp-password-"));
  passwordFile = path.join(tempDir, "qq_smtp_password");
  process.env.SMTP_PASSWORD_FILE = passwordFile;
});

afterEach(async () => {
  if (previousPasswordFile === undefined) delete process.env.SMTP_PASSWORD_FILE;
  else process.env.SMTP_PASSWORD_FILE = previousPasswordFile;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/workbench/smtp-password", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("Workbench SMTP password route", () => {
  test("rejects browser cross-origin requests", async () => {
    const response = await PUT(
      putRequest(
        { password: "smtp-auth-code" },
        {
          Origin: "http://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      code: "ORIGIN_REJECTED",
    });
    expect(response.status).toBe(403);
  });

  test("rejects empty passwords", async () => {
    const response = await PUT(putRequest({ password: "   " }));

    await expect(response.json()).resolves.toEqual({
      error: "SMTP password is required.",
    });
    expect(response.status).toBe(400);
  });

  test("writes the SMTP password file outside the repo", async () => {
    const response = await PUT(putRequest({ password: " smtp-auth-code " }));
    const payload = (await response.json()) as {
      message: string;
      passwordFile: string;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      message: "SMTP password saved.",
      passwordFile,
    });
    await expect(fs.readFile(passwordFile, "utf8")).resolves.toBe(
      "smtp-auth-code\n",
    );
    const stat = await fs.stat(passwordFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

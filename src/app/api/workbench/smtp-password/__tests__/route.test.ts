import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/workbench/smtp-password/route";
import { workbenchSmtpPasswordFilePath } from "@/lib/workbench-mail-runtime";

const previousRoot = process.env.LOCAL_DATASET_ROOT;
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-smtp-password-"));
  process.env.LOCAL_DATASET_ROOT = tempDir;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/workbench/smtp-password", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Workbench SMTP password route", () => {
  test("rejects browser cross-origin requests", async () => {
    const response = await PUT(
      putRequest(
        { sender: "sender@qq.com", password: "smtp-auth-code" },
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

  test("rejects invalid senders and empty authorization codes", async () => {
    const invalidSender = await PUT(
      putRequest({ sender: "person@xenserobotics.com", password: "code" }),
    );
    await expect(invalidSender.json()).resolves.toEqual({
      error: "严禁使用飞书邮箱作为发件人。",
    });
    expect(invalidSender.status).toBe(400);

    const emptyPassword = await PUT(
      putRequest({ sender: "sender@qq.com", password: "   " }),
    );
    await expect(emptyPassword.json()).resolves.toEqual({
      error: "SMTP authorization code is required.",
    });
    expect(emptyPassword.status).toBe(400);
  });

  test("writes QQ and 163 codes separately without returning their paths", async () => {
    const qqResponse = await PUT(
      putRequest({ sender: "sender@qq.com", password: " qq-code " }),
    );
    const neteaseResponse = await PUT(
      putRequest({ sender: "operator@163.com", password: "163-code" }),
    );

    expect(qqResponse.status).toBe(200);
    await expect(qqResponse.json()).resolves.toEqual({
      message: "QQ SMTP authorization code saved.",
    });
    expect(neteaseResponse.status).toBe(200);
    await expect(neteaseResponse.json()).resolves.toEqual({
      message: "163 SMTP authorization code saved.",
    });
    await expect(
      fs.readFile(workbenchSmtpPasswordFilePath("qq", tempDir), "utf8"),
    ).resolves.toBe("qq-code\n");
    await expect(
      fs.readFile(workbenchSmtpPasswordFilePath("163", tempDir), "utf8"),
    ).resolves.toBe("163-code\n");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/workbench/mail-smoke-test/route";

const previousEnv = {
  PYTHON_BIN: process.env.PYTHON_BIN,
  PYTHONPATH: process.env.PYTHONPATH,
  PYTHONHOME: process.env.PYTHONHOME,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_PASSWORD_FILE: process.env.SMTP_PASSWORD_FILE,
  SMTP_USERNAME: process.env.SMTP_USERNAME,
};

let tempDir: string;

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-mail-route-"));
  for (const name of Object.keys(previousEnv) as Array<
    keyof typeof previousEnv
  >) {
    restoreEnv(name);
  }
  delete process.env.PYTHON_BIN;
  delete process.env.PYTHONHOME;
  delete process.env.SMTP_PASSWORD;
  delete process.env.SMTP_PASSWORD_FILE;
  delete process.env.SMTP_USERNAME;
  process.env.PYTHONPATH = "/tmp/should-not-leak";
});

afterEach(async () => {
  for (const name of Object.keys(previousEnv) as Array<
    keyof typeof previousEnv
  >) {
    restoreEnv(name);
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

function postRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/workbench/mail-smoke-test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function writeFakePython(source: string): Promise<void> {
  const file = path.join(tempDir, "fake-python");
  await fs.writeFile(
    file,
    `#!/usr/bin/env bun
${source}`,
    "utf8",
  );
  await fs.chmod(file, 0o755);
  process.env.PYTHON_BIN = file;
}

describe("Workbench mail smoke-test route", () => {
  test("rejects browser cross-origin requests", async () => {
    const response = await POST(
      postRequest(
        {
          org: "TacVerse",
          message: {
            sender: "ignored@example.com",
            recipient: "frank@xenserobotics.com",
            subject: "SMTP smoketest",
            textBody: "Plain report",
            htmlBody: "<html><body>Report</body></html>",
          },
        },
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

  test("normalizes message fields and passes both bodies to SMTP", async () => {
    await writeFakePython(`
console.log(JSON.stringify({
  type: "result",
  result: {
    status: "ok",
    message: "SMTP smoke test sent.",
    from: process.env.SMTP_FROM_ADDRESS,
    username: process.env.SMTP_USERNAME,
    to: process.env.SMTP_TO_ADDRESS,
    subject: process.env.SMTP_SUBJECT,
    textBody: process.env.SMTP_TEXT_BODY,
    htmlBody: process.env.SMTP_HTML_BODY,
    passwordFile: process.env.SMTP_PASSWORD_FILE,
    pythonPath: process.env.PYTHONPATH ?? null
  }
}));
`);

    const response = await POST(
      postRequest({
        org: " TacVerse ",
        message: {
          sender: "spoof@example.com",
          recipient:
            " frank@xenserobotics.com; jay@xenserobotics.com,FRANK@xenserobotics.com ",
          subject: " SMTP smoketest ",
          textBody: "Plain report",
          htmlBody: "<!doctype html><html><body>HTML report</body></html>",
        },
      }),
    );
    const payload = (await response.json()) as {
      message: string;
      result: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(payload.message).toBe("SMTP smoke test sent.");
    expect(payload.result).toMatchObject({
      from: "1796262052@qq.com",
      username: "1796262052@qq.com",
      to: "frank@xenserobotics.com, jay@xenserobotics.com",
      subject: "SMTP smoketest",
      textBody: "Plain report",
      htmlBody: "<!doctype html><html><body>HTML report</body></html>",
      passwordFile: "/tmp/qq_smtp_password",
      pythonPath: null,
    });
  });

  test("returns script stage and code on SMTP failures", async () => {
    await writeFakePython(`
console.log(JSON.stringify({
  type: "error",
  stage: "auth",
  code: "auth_error",
  error: "authentication failed"
}));
process.exit(3);
`);

    const response = await POST(
      postRequest({
        org: "TacVerse",
        message: {
          sender: "ignored@example.com",
          recipient: "frank@xenserobotics.com",
          subject: "SMTP smoketest",
          textBody: "Plain report",
          htmlBody: "<html><body>Report</body></html>",
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      error: "authentication failed",
      stage: "auth",
      code: "auth_error",
    });
    expect(response.status).toBe(502);
  });

  test("returns a clear error for malformed script output", async () => {
    await writeFakePython(`console.log("not-json");`);

    const response = await POST(
      postRequest({
        org: "TacVerse",
        message: {
          sender: "ignored@example.com",
          recipient: "frank@xenserobotics.com",
          subject: "SMTP smoketest",
          textBody: "Plain report",
          htmlBody: "<html><body>Report</body></html>",
        },
      }),
    );
    const payload = (await response.json()) as {
      error: string;
      stage: string;
      code: string;
    };

    expect(response.status).toBe(502);
    expect(payload.stage).toBe("script");
    expect(payload.code).toBe("SMTP_OUTPUT_INVALID");
    expect(payload.error).toContain("malformed output");
  });

  test("rejects legacy draft payloads without generated bodies", async () => {
    const response = await POST(
      postRequest({
        org: "TacVerse",
        draft: {
          recipient: "frank@xenserobotics.com",
          subject: "SMTP smoketest",
          body: "Legacy Markdown",
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      error: "Workbench mail smoke test requires a message.",
    });
    expect(response.status).toBe(400);
  });
});

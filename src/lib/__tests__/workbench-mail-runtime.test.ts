import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKBENCH_163_SMTP_PASSWORD_FILE,
  DEFAULT_WORKBENCH_SMTP_PASSWORD_FILE,
  normalizeWorkbenchSmtpProvider,
  workbenchSmtpPasswordFilePath,
} from "@/lib/workbench-mail-runtime";

const previousProvider = process.env.SMTP_PROVIDER;
const previousPasswordFile = process.env.SMTP_PASSWORD_FILE;

afterEach(() => {
  if (previousProvider === undefined) delete process.env.SMTP_PROVIDER;
  else process.env.SMTP_PROVIDER = previousProvider;
  if (previousPasswordFile === undefined) delete process.env.SMTP_PASSWORD_FILE;
  else process.env.SMTP_PASSWORD_FILE = previousPasswordFile;
});

describe("Workbench SMTP runtime", () => {
  test("normalizes QQ and NetEase provider aliases", () => {
    expect(normalizeWorkbenchSmtpProvider(undefined)).toBe("qq");
    expect(normalizeWorkbenchSmtpProvider("QQ")).toBe("qq");
    expect(normalizeWorkbenchSmtpProvider("netease")).toBe("163");
    expect(normalizeWorkbenchSmtpProvider("netease163")).toBe("163");
    expect(normalizeWorkbenchSmtpProvider("163")).toBe("163");
    expect(normalizeWorkbenchSmtpProvider("unsupported")).toBe("qq");
  });

  test("uses provider-specific password files unless explicitly overridden", () => {
    delete process.env.SMTP_PASSWORD_FILE;
    process.env.SMTP_PROVIDER = "qq";
    expect(workbenchSmtpPasswordFilePath()).toBe(
      DEFAULT_WORKBENCH_SMTP_PASSWORD_FILE,
    );

    process.env.SMTP_PROVIDER = "163";
    expect(workbenchSmtpPasswordFilePath()).toBe(
      DEFAULT_WORKBENCH_163_SMTP_PASSWORD_FILE,
    );

    process.env.SMTP_PASSWORD_FILE = "/tmp/custom-smtp-password";
    expect(workbenchSmtpPasswordFilePath()).toBe("/tmp/custom-smtp-password");
  });
});

import fs from "node:fs/promises";
import path from "node:path";

export type WorkbenchSmtpProvider = "qq" | "163";

export const DEFAULT_WORKBENCH_SMTP_PASSWORD_FILE = "/tmp/qq_smtp_password";
export const DEFAULT_WORKBENCH_163_SMTP_PASSWORD_FILE =
  "/tmp/163_smtp_password";
export const MAX_WORKBENCH_SMTP_PASSWORD_LENGTH = 4096;

export function normalizeWorkbenchSmtpProvider(
  value: unknown,
): WorkbenchSmtpProvider {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "163" ||
    normalized === "netease" ||
    normalized === "netease163"
  ) {
    return "163";
  }
  return "qq";
}

export function workbenchSmtpProvider(): WorkbenchSmtpProvider {
  return normalizeWorkbenchSmtpProvider(process.env.SMTP_PROVIDER);
}

export function workbenchSmtpPasswordFilePath(
  provider = workbenchSmtpProvider(),
): string {
  const defaultPath =
    provider === "163"
      ? DEFAULT_WORKBENCH_163_SMTP_PASSWORD_FILE
      : DEFAULT_WORKBENCH_SMTP_PASSWORD_FILE;
  return process.env.SMTP_PASSWORD_FILE?.trim() || defaultPath;
}

export function normalizeWorkbenchSmtpPassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WORKBENCH_SMTP_PASSWORD_LENGTH) {
    return null;
  }
  return trimmed;
}

export async function writeWorkbenchSmtpPassword(
  password: string,
  filePath = workbenchSmtpPasswordFilePath(),
): Promise<{ filePath: string }> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${password}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
  return { filePath };
}

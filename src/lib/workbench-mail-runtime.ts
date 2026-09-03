import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_WORKBENCH_SMTP_PASSWORD_FILE = "/tmp/qq_smtp_password";
export const MAX_WORKBENCH_SMTP_PASSWORD_LENGTH = 4096;

export function workbenchSmtpPasswordFilePath(): string {
  return (
    process.env.SMTP_PASSWORD_FILE?.trim() ||
    DEFAULT_WORKBENCH_SMTP_PASSWORD_FILE
  );
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

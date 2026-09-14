import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import type { WorkbenchSmtpProvider } from "@/lib/workbench-mail-sender";

const STORE_DIR = ".xense-viewer";
const SECRETS_DIR = "secrets";
const SMTP_PASSWORD_FILES: Record<WorkbenchSmtpProvider, string> = {
  qq: "smtp-qq-authorization-code",
  "163": "smtp-163-authorization-code",
};

export const MAX_WORKBENCH_SMTP_PASSWORD_LENGTH = 4096;

export function workbenchSmtpPasswordFilePath(
  provider: WorkbenchSmtpProvider,
  root = resolveLocalDatasetRoot(),
): string {
  return path.join(root, STORE_DIR, SECRETS_DIR, SMTP_PASSWORD_FILES[provider]);
}
export function normalizeWorkbenchSmtpPassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WORKBENCH_SMTP_PASSWORD_LENGTH) {
    return null;
  }
  return trimmed;
}

export async function assertWorkbenchSmtpPasswordConfigured(
  provider: WorkbenchSmtpProvider,
  root = resolveLocalDatasetRoot(),
): Promise<string> {
  const filePath = workbenchSmtpPasswordFilePath(provider, root);
  try {
    const password = normalizeWorkbenchSmtpPassword(
      await fs.readFile(filePath, "utf8"),
    );
    if (password) return filePath;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  throw new Error(
    `Missing ${provider.toUpperCase()} SMTP authorization code. Save it in Workbench before sending.`,
  );
}

export async function writeWorkbenchSmtpPassword(
  password: string,
  provider: WorkbenchSmtpProvider,
  root = resolveLocalDatasetRoot(),
): Promise<{ filePath: string }> {
  const normalized = normalizeWorkbenchSmtpPassword(password);
  if (!normalized) throw new Error("SMTP authorization code is required.");

  const viewerDir = path.join(root, STORE_DIR);
  const secretsDir = path.join(viewerDir, SECRETS_DIR);
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(viewerDir, 0o700).catch(() => undefined);
  await fs.chmod(secretsDir, 0o700).catch(() => undefined);

  const destination = workbenchSmtpPasswordFilePath(provider, root);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${normalized}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(temporary, 0o600).catch(() => undefined);
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return { filePath: destination };
}

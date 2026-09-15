import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";

const STORE_DIR = ".xense-viewer";
const SECRETS_DIR = "secrets";
const TOKEN_FILE = "modelscope-token";
const MAX_TOKEN_LENGTH = 4096;

export type ModelScopeTokenSource = "viewer" | "environment" | "none";

export type ResolvedModelScopeToken = {
  token: string | null;
  source: ModelScopeTokenSource;
};

function tokenPath(root: string): string {
  return path.join(root, STORE_DIR, SECRETS_DIR, TOKEN_FILE);
}

function trimToken(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  return !token || token.length > MAX_TOKEN_LENGTH ? null : token;
}

export async function readViewerModelScopeToken(
  root = resolveLocalDatasetRoot(),
): Promise<string | null> {
  try {
    return trimToken(await fs.readFile(tokenPath(root), "utf8"));
  } catch {
    return null;
  }
}

export async function writeViewerModelScopeToken(
  value: string,
  root = resolveLocalDatasetRoot(),
): Promise<void> {
  const token = trimToken(value);
  if (!token) throw new Error("A non-empty ModelScope token is required.");

  const secretsDir = path.join(root, STORE_DIR, SECRETS_DIR);
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(root, STORE_DIR), 0o700).catch(() => undefined);
  await fs.chmod(secretsDir, 0o700).catch(() => undefined);

  const destination = tokenPath(root);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(temporary, 0o600).catch(() => undefined);
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function clearViewerModelScopeToken(
  root = resolveLocalDatasetRoot(),
): Promise<void> {
  await fs.unlink(tokenPath(root)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  });
}

export async function resolveModelScopeToken(
  root = resolveLocalDatasetRoot(),
): Promise<ResolvedModelScopeToken> {
  const viewer = await readViewerModelScopeToken(root);
  if (viewer) return { token: viewer, source: "viewer" };

  const environment = trimToken(process.env.MODELSCOPE_API_TOKEN);
  if (environment) return { token: environment, source: "environment" };

  return { token: null, source: "none" };
}

export function modelScopeTokenStorePath(
  root = resolveLocalDatasetRoot(),
): string {
  return tokenPath(root);
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";

/**
 * Viewer-owned Hugging Face credential storage.
 *
 * The token deliberately lives below the configured dataset root rather than
 * in a browser cookie/localStorage.  That keeps the credential out of client
 * bundles and makes a copied dataset root self-contained for this local app.
 */
const STORE_DIR = ".xense-viewer";
const SECRETS_DIR = "secrets";
const TOKEN_FILE = "hf-token";
const MAX_TOKEN_LENGTH = 4096;

export type HfTokenSource = "viewer" | "environment" | "cache" | "none";

// Compatibility aliases used by the account/catalog routes.  Keeping one
// source vocabulary prevents a saved token and a CLI-cached token from being
// accidentally treated as separate credential models.
export type HfCredentialSource = HfTokenSource;

export type ResolvedHfToken = {
  token: string | null;
  source: HfTokenSource;
};

export type HfCredential = ResolvedHfToken;

function tokenPath(root: string): string {
  return path.join(root, STORE_DIR, SECRETS_DIR, TOKEN_FILE);
}

function trimToken(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

/** Read only the viewer-owned token; no environment/cache fallback. */
export async function readViewerHfToken(
  root = resolveLocalDatasetRoot(),
): Promise<string | null> {
  try {
    return trimToken(await fs.readFile(tokenPath(root), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically replace the viewer token and tighten permissions on every parent
 * directory.  A temporary file is used so a process killed during a write
 * cannot leave a partially valid credential behind.
 */
export async function writeViewerHfToken(
  value: string,
  root = resolveLocalDatasetRoot(),
): Promise<void> {
  const token = trimToken(value);
  if (!token) throw new Error("A non-empty Hugging Face token is required.");

  const secretsDir = path.join(root, STORE_DIR, SECRETS_DIR);
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  // mkdir mode is affected by umask and does not change an existing directory.
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

export async function clearViewerHfToken(
  root = resolveLocalDatasetRoot(),
): Promise<void> {
  await fs.unlink(tokenPath(root)).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  });
}

function cachedTokenCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.HF_TOKEN_PATH?.trim()) {
    candidates.push(process.env.HF_TOKEN_PATH.trim());
  }
  const hfHome = process.env.HF_HOME?.trim();
  if (hfHome) candidates.push(path.join(hfHome, "token"));
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg) candidates.push(path.join(xdg, "huggingface", "token"));
  const home = os.homedir();
  if (home) candidates.push(path.join(home, ".cache", "huggingface", "token"));
  return [...new Set(candidates)];
}

async function readCachedHfToken(): Promise<string | null> {
  for (const candidate of cachedTokenCandidates()) {
    try {
      const token = trimToken(await fs.readFile(candidate, "utf8"));
      if (token) return token;
    } catch {
      // A missing/unreadable candidate simply lets us try the next convention.
    }
  }
  return null;
}

/**
 * Resolve credentials in the same order users expect from the Workbench:
 * viewer token > HF_TOKEN > Hugging Face CLI cache > anonymous.
 */
export async function resolveHfToken(
  root = resolveLocalDatasetRoot(),
): Promise<ResolvedHfToken> {
  const viewer = await readViewerHfToken(root);
  if (viewer) return { token: viewer, source: "viewer" };

  const environment = trimToken(process.env.HF_TOKEN);
  if (environment) return { token: environment, source: "environment" };

  const cached = await readCachedHfToken();
  if (cached) return { token: cached, source: "cache" };

  return { token: null, source: "none" };
}

export async function resolveHfCredential(
  root = resolveLocalDatasetRoot(),
): Promise<HfCredential> {
  return resolveHfToken(root);
}

export function tokenStorePath(root = resolveLocalDatasetRoot()): string {
  return tokenPath(root);
}

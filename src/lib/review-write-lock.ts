import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PROTOCOL = "xense-review-flock-v1";
const OWNER = "owner.json";

export class ReviewWriteLockError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "REVIEW_LOCK_UNAVAILABLE",
  ) {
    super(message);
  }
}

/** Persistent inode: never unlink this file, even when no process holds it. */
async function nativeLease(file: string, timeoutMs: number) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ReviewWriteLockError("Invalid system review lock file", 400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await fs.open(file, "a", 0o664);
  const identity = await handle.stat({ bigint: true });
  await handle.close();
  // --no-fork leaves one tiny shell waiting on stdin. Parent exit closes the
  // pipe and releases the kernel lock; there is no timestamp-based takeover.
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--timeout",
      String(timeoutMs / 1000),
      "--conflict-exit-code",
      "75",
      "--no-fork",
      "--",
      file,
      "sh",
      "-c",
      "printf 'locked\\n'; IFS= read -r release || :",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let acquired = false;
  let finished = false;
  let released = false;
  let stderr = "";
  let stdout = "";
  let processError: Error | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      processError = error;
    });
    child.stdin.on("error", (error) => {
      processError = error;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-64);
      if (!acquired && stdout.includes("locked\n")) {
        acquired = true;
        resolve();
      }
    });
    child.once("close", (code) => {
      finished = true;
      resolveClosed();
      if (!acquired)
        reject(
          new ReviewWriteLockError(
            code === 75
              ? "Review file is busy; another writer is still saving. Retry shortly."
              : "Cannot acquire the system review lock. Install util-linux flock and use a filesystem supporting shared locks. " +
                  (processError?.message ?? stderr.trim()),
            code === 75 ? 409 : 503,
            code === 75 ? "REVIEW_LOCK_BUSY" : "REVIEW_LOCK_UNAVAILABLE",
          ),
        );
    });
  });
  return {
    ino: identity.ino.toString(),
    async verifyHeld() {
      const current = await fs
        .lstat(file, { bigint: true })
        .catch(() => undefined);
      if (
        !current?.isFile() ||
        current.isSymbolicLink() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev
      )
        throw new ReviewWriteLockError(
          "Review system lock identity changed; stop writers and investigate before retrying",
          503,
          "REVIEW_LOCK_CHANGED",
        );
      if (finished || child.exitCode !== null || child.signalCode !== null)
        throw new ReviewWriteLockError(
          "Review write lock was lost before commit; retry saving",
          503,
          "REVIEW_LOCK_CHANGED",
        );
    },
    assertHeld() {
      if (finished || child.exitCode !== null || child.signalCode !== null)
        throw new ReviewWriteLockError(
          "Review write lock was lost before commit; retry saving",
          503,
          "REVIEW_LOCK_CHANGED",
        );
    },
    async release() {
      if (!released) {
        released = true;
        child.stdin.end("release\n");
      }
      await closed;
    },
  };
}

/** Keep mkdir compatibility while old viewer instances still share the file. */
export async function acquireReviewWriteLock(
  target: string,
  timeoutMs = 10_000,
) {
  const file = target + ".write-lock";
  const native = await nativeLease(file, timeoutMs);
  const directory = target + ".lock";
  const ownerPath = path.join(directory, OWNER);
  const token = randomUUID();
  const deadline = performance.now() + timeoutMs;
  try {
    await native.verifyHeld();
    while (true) {
      native.assertHeld();
      try {
        await fs.mkdir(directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let stat;
      try {
        stat = await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ReviewWriteLockError(
          "Review lock must be a real directory",
          400,
        );
      let owner;
      try {
        owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
      }
      // Holding this same kernel inode proves the prior new-protocol writer
      // is gone. An empty/unknown old lock has no such proof: never steal it.
      if (owner?.protocol === PROTOCOL && owner.ino === native.ino) {
        await fs.unlink(ownerPath);
        await fs.rmdir(directory);
        continue;
      }
      if (performance.now() >= deadline)
        throw new ReviewWriteLockError(
          "Review file is busy with an old-version or unknown writer. If its empty .lock directory is left behind, pause all old-version saves before recovering it; browsing can continue. No lock was removed automatically.",
          409,
          "REVIEW_LEGACY_LOCK",
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stagedOwner = directory + ".owner-" + token;
    let staged = false;
    try {
      const handle = await fs.open(stagedOwner, "wx");
      staged = true;
      try {
        await handle.writeFile(
          JSON.stringify({ protocol: PROTOCOL, ino: native.ino, token }),
        );
      } finally {
        await handle.close();
      }
      // Exclusive hard-link publication never exposes partial owner JSON and
      // cannot overwrite an unexpected owner in the compatibility directory.
      await fs.link(stagedOwner, ownerPath);
    } catch (error) {
      await fs.rmdir(directory).catch(() => undefined);
      throw error;
    } finally {
      if (staged) await fs.rm(stagedOwner, { force: true });
    }
  } catch (error) {
    await native.release();
    throw error;
  }
  let released = false;
  return {
    async assertHeld() {
      await native.verifyHeld();
      const owner = await fs
        .readFile(ownerPath, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => undefined);
      if (
        owner?.token !== token ||
        owner.protocol !== PROTOCOL ||
        owner.ino !== native.ino
      )
        throw new ReviewWriteLockError(
          "Review lock ownership changed; stop writers and investigate before retrying",
          503,
          "REVIEW_LOCK_CHANGED",
        );
      native.assertHeld();
    },
    async release() {
      if (released) return;
      released = true;
      try {
        const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
        if (owner.token !== token)
          throw new ReviewWriteLockError(
            "Review lock ownership changed; recovery is required",
            503,
            "REVIEW_LOCK_CHANGED",
          );
        await fs.unlink(ownerPath);
        await fs.rmdir(directory);
      } finally {
        await native.release();
      }
    },
  };
}

/** Operator-only: all old-version saves must already be quiescent. */
export async function recoverLegacyReviewLock(
  target: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const native = await nativeLease(target + ".write-lock", timeoutMs);
  try {
    const directory = target + ".lock";
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.readdir(directory)).length
    )
      throw new ReviewWriteLockError(
        "Recovery only accepts an empty legacy lock directory; no files were removed",
        409,
      );
    const stamp = new Date(Date.now() + 8 * 3600_000)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("Z", "+0800");
    const original = await fs
      .lstat(target)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    let backup: string | undefined;
    if (original) {
      if (!original.isFile() || original.isSymbolicLink())
        throw new ReviewWriteLockError(
          "Recovery requires a regular review file or no original file",
          400,
        );
      backup = target + ".backup-" + stamp + "-" + randomUUID();
      await fs.copyFile(target, backup, fs.constants.COPYFILE_EXCL);
    }
    await native.verifyHeld();
    await fs.rmdir(directory);
    return backup;
  } finally {
    await native.release();
  }
}

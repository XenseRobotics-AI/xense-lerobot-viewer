import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  acquireReviewWriteLock,
  recoverLegacyReviewLock,
} from "../review-write-lock";

let directory: string;
let target: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "viewer-review-lock-"));
  await fs.chmod(directory, 0o2775);
  target = path.join(directory, "episode-reviews.json");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
});

test("kernel and legacy locks both exclude other writers and release exactly once", async () => {
  const first = await acquireReviewWriteLock(target);
  try {
    await expect(fs.mkdir(target + ".lock")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(acquireReviewWriteLock(target, 30)).rejects.toMatchObject({
      status: 409,
    });
    await first.assertHeld();
  } finally {
    await first.release();
  }
  await first.release();
  expect(await fs.exists(target + ".lock")).toBe(false);
  const before = (await fs.stat(target + ".write-lock")).ino;
  const second = await acquireReviewWriteLock(target);
  await second.release();
  expect((await fs.stat(target + ".write-lock")).ino).toBe(before);
});

test("a replaced native lock inode prevents the original writer from committing", async () => {
  const lock = await acquireReviewWriteLock(target);
  try {
    await fs.rename(target + ".write-lock", target + ".write-lock-original");
    await fs.writeFile(target + ".write-lock", "");
    await expect(
      Promise.resolve().then(() => lock.assertHeld()),
    ).rejects.toMatchObject({ status: 503 });
  } finally {
    await lock.release();
  }
});

test("a replaced owner token prevents commit and cannot be removed by the old owner", async () => {
  const lock = await acquireReviewWriteLock(target);
  const ownerPath = path.join(target + ".lock", "owner.json");
  const original = await fs.readFile(ownerPath, "utf8");
  const changed = JSON.stringify({
    ...JSON.parse(original),
    token: "another-owner",
  });
  try {
    await fs.writeFile(ownerPath, changed);
    await expect(
      Promise.resolve().then(() => lock.assertHeld()),
    ).rejects.toMatchObject({ status: 503 });
    await expect(lock.release()).rejects.toMatchObject({ status: 503 });
    expect(await fs.readFile(ownerPath, "utf8")).toBe(changed);
  } finally {
    await fs.writeFile(ownerPath, original);
    await lock.release();
  }
});

test("unknown old locks are never stolen based on age", async () => {
  await fs.mkdir(target + ".lock");
  await fs.utimes(target + ".lock", 1, 1);
  await expect(acquireReviewWriteLock(target, 30)).rejects.toMatchObject({
    status: 409,
  });
  expect((await fs.stat(target + ".lock")).mtimeMs).toBe(1000);
  expect(await fs.readdir(target + ".lock")).toEqual([]);
});

test("owner publication failures leave no compatibility lock and allow recovery", async () => {
  const publishing = spyOn(fs, "symlink").mockRejectedValue(
    Object.assign(new Error("Injected owner publication failure"), {
      code: "ENOSPC",
    }),
  );
  let failure: unknown;
  try {
    const lock = await acquireReviewWriteLock(target);
    await lock.release();
  } catch (error) {
    failure = error;
  } finally {
    publishing.mockRestore();
  }
  expect(failure).toMatchObject({ code: "ENOSPC" });
  expect(await fs.exists(target + ".lock")).toBe(false);
  expect(
    (await fs.readdir(directory)).filter((name) => name.includes(".owner-")),
  ).toEqual([]);
  const lock = await acquireReviewWriteLock(target);
  await lock.release();
});

test("legacy writer completion wakes a new writer without deleting its lock", async () => {
  await fs.mkdir(target + ".lock");
  const pending = acquireReviewWriteLock(target, 500);
  await Bun.sleep(40);
  await fs.rmdir(target + ".lock");
  const lock = await pending;
  await lock.release();
  expect(await fs.exists(target + ".lock")).toBe(false);
});

test("legacy lock timeouts do not depend on wall clock movement", async () => {
  await fs.mkdir(target + ".lock");
  const wallClock = spyOn(Date, "now").mockReturnValue(0);
  const pending = acquireReviewWriteLock(target, 30).then(
    async (lock) => {
      await lock.release();
      return 200;
    },
    (error: { status: number }) => error.status,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      pending,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(-1), 1000);
      }),
    ]);
    expect(outcome).toBe(409);
  } finally {
    clearTimeout(timer);
    wallClock.mockRestore();
    await pending;
  }
});

test("partial staged owner writes cannot publish an incomplete compatibility lock", async () => {
  const write = fs.writeFile.bind(fs);
  const writing = spyOn(fs, "writeFile").mockImplementation(
    async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).includes(".lock.owner-")) {
        await write(args[0], "{partial");
        throw Object.assign(new Error("Injected full disk"), {
          code: "ENOSPC",
        });
      }
      return write(...args);
    },
  );
  try {
    await expect(acquireReviewWriteLock(target)).rejects.toMatchObject({
      code: "ENOSPC",
    });
  } finally {
    writing.mockRestore();
  }
  expect(await fs.exists(target + ".lock")).toBe(false);
  expect(
    (await fs.readdir(directory)).filter((name) => name.includes(".owner-")),
  ).toEqual([]);
});

test("owner publication never overwrites or removes an unexpected existing owner", async () => {
  const publishing = spyOn(fs, "symlink").mockImplementation(
    async (_source, destination) => {
      await fs.mkdir(destination);
      await fs.writeFile(
        path.join(String(destination), "owner.json"),
        "foreign owner",
        { flag: "wx" },
      );
      throw Object.assign(new Error("Injected competing owner"), {
        code: "EEXIST",
      });
    },
  );
  try {
    await expect(acquireReviewWriteLock(target, 30)).rejects.toMatchObject({
      code: "REVIEW_LEGACY_LOCK",
    });
  } finally {
    publishing.mockRestore();
  }
  expect(
    await fs.readFile(path.join(target + ".lock", "owner.json"), "utf8"),
  ).toBe("foreign owner");
  expect(
    (await fs.readdir(directory)).filter((name) => name.includes(".owner-")),
  ).toEqual([]);
});

test("a killed Node writer releases the native lease and its known orphan is recovered", async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../review-write-lock.ts", import.meta.url).pathname],
    target: "node",
    format: "esm",
    write: false,
  });
  expect(bundle.success).toBe(true);
  const helper = path.join(directory, "lock.mjs");
  await fs.writeFile(helper, await bundle.outputs[0].text());
  const child = spawn(
    "node",
    [
      "--input-type=module",
      "-e",
      "import {acquireReviewWriteLock} from " +
        JSON.stringify(pathToFileURL(helper).href) +
        "; await acquireReviewWriteLock(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);",
      target,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error("Writer exited before ready: " + code)),
    );
  });
  const owner = await fs.readFile(
    path.join(target + ".lock", "owner.json"),
    "utf8",
  );
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  const replacement = await acquireReviewWriteLock(target, 1000);
  try {
    expect(
      await fs.readFile(path.join(target + ".lock", "owner.json"), "utf8"),
    ).not.toBe(owner);
    await replacement.assertHeld();
  } finally {
    await replacement.release();
  }
});

test("symlinked lock directories are rejected without touching their targets", async () => {
  const other = path.join(directory, "other");
  await fs.mkdir(other);
  await fs.symlink(other, target + ".lock");
  await expect(acquireReviewWriteLock(target, 30)).rejects.toMatchObject({
    status: 400,
  });
  expect(await fs.readdir(other)).toEqual([]);
});

test("a lost publication acknowledgement preserves a complete recoverable owner", async () => {
  const symlink = fs.symlink.bind(fs);
  const publishing = spyOn(fs, "symlink").mockImplementation(
    async (...args: Parameters<typeof fs.symlink>) => {
      await symlink(...args);
      throw Object.assign(new Error("Lost publication acknowledgement"), {
        code: "EIO",
      });
    },
  );
  try {
    await expect(acquireReviewWriteLock(target)).rejects.toMatchObject({
      code: "EIO",
    });
  } finally {
    publishing.mockRestore();
  }
  expect((await fs.lstat(target + ".lock")).isSymbolicLink()).toBe(true);
  expect(
    JSON.parse(
      await fs.readFile(path.join(target + ".lock", "owner.json"), "utf8"),
    ).protocol,
  ).toBe("xense-review-flock-v2");
  const next = await acquireReviewWriteLock(target);
  await next.assertHeld();
  await next.release();
  expect(await fs.readdir(directory)).toEqual([
    "episode-reviews.json.write-lock",
  ]);
});

test("a failed v1 orphan cleanup cannot leave an empty compatibility directory", async () => {
  await fs.writeFile(target + ".write-lock", "");
  const ino = (
    await fs.stat(target + ".write-lock", { bigint: true })
  ).ino.toString();
  await fs.mkdir(target + ".lock");
  await fs.writeFile(
    path.join(target + ".lock", "owner.json"),
    JSON.stringify({
      protocol: "xense-review-flock-v1",
      ino,
      token: crypto.randomUUID(),
    }),
  );
  const unlink = fs.unlink.bind(fs);
  const cleaning = spyOn(fs, "unlink").mockImplementation(async (p) => {
    if (String(p).includes(".lock.retired-"))
      throw Object.assign(new Error("Injected cleanup failure"), {
        code: "EIO",
      });
    return unlink(p);
  });
  try {
    await expect(acquireReviewWriteLock(target)).rejects.toMatchObject({
      code: "EIO",
    });
  } finally {
    cleaning.mockRestore();
  }
  expect(await fs.exists(target + ".lock")).toBe(false);
  const next = await acquireReviewWriteLock(target);
  await next.release();
});

test("a foreign atomic owner is preserved even when its path looks valid", async () => {
  const token = crypto.randomUUID();
  const other = target + ".lock.owner-" + token;
  await fs.mkdir(other);
  const raw = JSON.stringify({
    protocol: "xense-review-flock-v2",
    ino: "foreign-inode",
    token,
  });
  await fs.writeFile(path.join(other, "owner.json"), raw);
  await fs.symlink(path.basename(other), target + ".lock");
  await expect(acquireReviewWriteLock(target, 30)).rejects.toMatchObject({
    code: "REVIEW_LOCK_CHANGED",
  });
  expect(await fs.readFile(path.join(other, "owner.json"), "utf8")).toBe(raw);
  expect(await fs.readlink(target + ".lock")).toBe(path.basename(other));
});

test("a replaced owner directory cannot redirect lock cleanup outside its scope", async () => {
  const lock = await acquireReviewWriteLock(target);
  const linkTarget = await fs.readlink(target + ".lock");
  const stagedDirectory = path.join(directory, linkTarget);
  const moved = stagedDirectory + ".saved";
  const outside = path.join(directory, "outside-owner");
  await fs.unlink(target + ".lock");
  await fs.rename(stagedDirectory, moved);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "owner.json"), "preserve this data");
  await fs.symlink("outside-owner", stagedDirectory, "dir");
  await fs.symlink(linkTarget, target + ".lock", "dir");
  await expect(lock.assertHeld()).rejects.toMatchObject({
    code: "REVIEW_LOCK_CHANGED",
  });
  await expect(lock.release()).rejects.toMatchObject({
    code: "REVIEW_LOCK_CHANGED",
  });
  expect(await fs.readFile(path.join(outside, "owner.json"), "utf8")).toBe(
    "preserve this data",
  );
  expect(await fs.readlink(target + ".lock")).toBe(linkTarget);
});

test("restrictive process umasks cannot make published owners unreadable to other servers", async () => {
  const previous = process.umask(0o077);
  let lock: Awaited<ReturnType<typeof acquireReviewWriteLock>> | undefined;
  try {
    lock = await acquireReviewWriteLock(target);
    expect((await fs.stat(target + ".write-lock")).mode & 0o777).toBe(0o664);
    expect((await fs.stat(target + ".lock")).mode & 0o777).toBe(0o775);
    expect(
      (await fs.stat(path.join(target + ".lock", "owner.json"))).mode & 0o777,
    ).toBe(0o664);
    const link = await fs.readlink(target + ".lock");
    expect(path.isAbsolute(link)).toBe(false);
    await lock.assertHeld();
  } finally {
    process.umask(previous);
    await lock?.release();
  }
});

test.each(["before_publish", "after_publish", "before_unlink", "after_unlink"])(
  "a killed Node process at %s never strands an unknown empty lock",
  async (boundary) => {
    const bundle = await Bun.build({
      entrypoints: [
        new URL("../review-write-lock.ts", import.meta.url).pathname,
      ],
      target: "node",
      format: "esm",
      write: false,
    });
    expect(bundle.success).toBe(true);
    const helper = path.join(directory, "crash-lock.mjs");
    await fs.writeFile(helper, await bundle.outputs[0].text());
    const source = [
      'import fs from "node:fs/promises";',
      "import {acquireReviewWriteLock} from " +
        JSON.stringify(pathToFileURL(helper).href) +
        ";",
      "const [target, boundary] = process.argv.slice(1);",
      'const pause = () => { console.log("boundary"); return new Promise(() => {}); };',
      "const symlink = fs.symlink.bind(fs);",
      'fs.symlink = async (...args) => { if(boundary === "before_publish") await pause(); await symlink(...args); if(boundary === "after_publish") await pause(); };',
      "const unlink = fs.unlink.bind(fs);",
      'fs.unlink = async (...args) => { if(String(args[0]) === target + ".lock" && boundary === "before_unlink") await pause(); await unlink(...args); if(String(args[0]) === target + ".lock" && boundary === "after_unlink") await pause(); };',
      "const lock = await acquireReviewWriteLock(target); await lock.release();",
    ].join(String.fromCharCode(10));
    const child = spawn(
      "node",
      ["--input-type=module", "-e", source, target, boundary],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Crash boundary not reached: " + stderr)),
          5000,
        );
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error("Writer exited: " + code + " " + stderr)),
        );
      });
    } finally {
      clearTimeout(timer);
    }
    const marker = await fs.lstat(target + ".lock").catch(() => undefined);
    if (boundary === "before_publish" || boundary === "after_unlink")
      expect(marker).toBeUndefined();
    else {
      expect(marker?.isSymbolicLink()).toBe(true);
      expect(
        JSON.parse(
          await fs.readFile(path.join(target + ".lock", "owner.json"), "utf8"),
        ).protocol,
      ).toBe("xense-review-flock-v2");
    }
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
    const replacement = await acquireReviewWriteLock(target, 1000);
    try {
      await replacement.assertHeld();
    } finally {
      await replacement.release();
    }
    expect(await fs.exists(target + ".lock")).toBe(false);
  },
);

test("operator recovery backs up bytes and preserves unfinished writes", async () => {
  await fs.writeFile(target, "original records\n");
  await fs.writeFile(target + ".tmp-pending", "unfinished");
  await fs.mkdir(target + ".lock");
  const backup = await recoverLegacyReviewLock(target);
  expect(backup).toBeString();
  expect(await fs.readFile(backup!, "utf8")).toBe("original records\n");
  expect(await fs.readFile(target, "utf8")).toBe("original records\n");
  expect(await fs.readFile(target + ".tmp-pending", "utf8")).toBe("unfinished");
  expect(await fs.exists(target + ".lock")).toBe(false);
  const lock = await acquireReviewWriteLock(target);
  await lock.release();
});

test("operator recovery handles an orphan before the first review file exists", async () => {
  await fs.mkdir(target + ".lock");
  await fs.writeFile(target + ".tmp-first", "unfinished first write");
  expect(await recoverLegacyReviewLock(target)).toBeUndefined();
  expect(await fs.exists(target)).toBe(false);
  expect(await fs.exists(target + ".lock")).toBe(false);
  expect(await fs.readFile(target + ".tmp-first", "utf8")).toBe(
    "unfinished first write",
  );
  const lock = await acquireReviewWriteLock(target);
  await lock.release();
});

test("operator recovery refuses symlinked or non-file originals", async () => {
  const original = path.join(directory, "outside-records");
  await fs.writeFile(original, "preserve");
  await fs.mkdir(target + ".lock");
  await fs.symlink(original, target);
  await expect(recoverLegacyReviewLock(target)).rejects.toMatchObject({
    status: 400,
  });
  expect(await fs.readFile(original, "utf8")).toBe("preserve");
  expect(await fs.readdir(target + ".lock")).toEqual([]);
  await fs.unlink(target);
  await fs.mkdir(target);
  await expect(recoverLegacyReviewLock(target)).rejects.toMatchObject({
    status: 400,
  });
  expect(await fs.readdir(target + ".lock")).toEqual([]);
});

test("operator recovery refuses active or nonempty locks", async () => {
  await fs.writeFile(target, "original");
  const lock = await acquireReviewWriteLock(target);
  try {
    await expect(recoverLegacyReviewLock(target, 30)).rejects.toMatchObject({
      status: 409,
    });
  } finally {
    await lock.release();
  }
  await fs.mkdir(target + ".lock");
  await fs.writeFile(path.join(target + ".lock", "unknown-owner"), "keep");
  await expect(recoverLegacyReviewLock(target)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    await fs.readFile(path.join(target + ".lock", "unknown-owner"), "utf8"),
  ).toBe("keep");
});

import { test, expect, beforeEach, afterEach } from "bun:test";
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
    first.assertHeld();
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

test("unknown old locks are never stolen based on age", async () => {
  await fs.mkdir(target + ".lock");
  await fs.utimes(target + ".lock", 1, 1);
  await expect(acquireReviewWriteLock(target, 30)).rejects.toMatchObject({
    status: 409,
  });
  expect((await fs.stat(target + ".lock")).mtimeMs).toBe(1000);
  expect(await fs.readdir(target + ".lock")).toEqual([]);
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

test("a killed Node writer releases the native lease and its known orphan is recovered", async () => {
  const input = await fs.readFile(
    new URL("../review-write-lock.ts", import.meta.url),
    "utf8",
  );
  const helper = path.join(directory, "lock.mjs");
  await fs.writeFile(
    helper,
    new Bun.Transpiler({ loader: "ts" }).transformSync(input),
  );
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
    replacement.assertHeld();
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

test("operator recovery backs up bytes and preserves unfinished writes", async () => {
  await fs.writeFile(target, "original records\n");
  await fs.writeFile(target + ".tmp-pending", "unfinished");
  await fs.mkdir(target + ".lock");
  const backup = await recoverLegacyReviewLock(target);
  expect(await fs.readFile(backup, "utf8")).toBe("original records\n");
  expect(await fs.readFile(target, "utf8")).toBe("original records\n");
  expect(await fs.readFile(target + ".tmp-pending", "utf8")).toBe("unfinished");
  expect(await fs.exists(target + ".lock")).toBe(false);
  const lock = await acquireReviewWriteLock(target);
  await lock.release();
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

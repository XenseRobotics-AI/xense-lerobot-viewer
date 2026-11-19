import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { LocalFileStat } from "./local-dataset-paths";
import type { PlaybackColor } from "@/utils/videoPlaybackUrl";

const CACHE_BYTES = 16 * 1024 ** 3;
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const MAX_SECONDS = 300;
const RECENT_MS = 15 * 60 * 1000;
const DEFAULT_CACHE = path.join(
  os.homedir(),
  ".cache",
  "xense-viewer",
  "lossless-video",
);

export class LosslessPlaybackError extends Error {}
type Probe = {
  codec_name: string;
  pix_fmt: string;
  width: number;
  height: number;
  duration: number;
  color_range?: string;
};
const probes = new Map<string, Probe>();
type Job<T> = {
  controller: AbortController;
  promise: Promise<T>;
  owners: number;
  settled: boolean;
};
const probeJobs = new Map<string, Job<Probe>>();
type EncodeJob = Job<LocalFileStat> & { leases: Map<string, number> };
const jobs = new Map<string, EncodeJob>();

async function touchLease(root: string, key: string, lease: string) {
  await fs.writeFile(path.join(root, key + ".lease-" + lease), "", {
    mode: 0o600,
  });
}

function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    if (active >= max) {
      if (waiting.length >= 16)
        throw new LosslessPlaybackError("Playback preparation queue is full");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const i = waiting.indexOf(start);
          if (i >= 0) waiting.splice(i, 1);
          reject(signal!.reason);
        };
        const start = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        waiting.push(start);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else active++;
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
const probeSlot = limiter(4);
const encodeSlot = limiter(2);

async function probe(file: LocalFileStat, signal: AbortSignal): Promise<Probe> {
  const key = `${file.absolutePath}:${file.size}:${file.mtimeMs}`;
  const existing = probes.get(key);
  if (existing) return existing;
  let job = probeJobs.get(key);
  if (job) return owned(job, signal);
  const controller = new AbortController();
  job = { controller, owners: 0, settled: false, promise: undefined! };
  const entry = job;
  job.promise = probeSlot(
    () =>
      new Promise<Probe>((resolve, reject) => {
        execFile(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,pix_fmt,width,height,color_range:format=start_time,duration",
            "-of",
            "json",
            file.absolutePath,
          ],
          { timeout: 30000, maxBuffer: 512 * 1024, signal: controller.signal },
          (error, stdout) => {
            if (error) {
              reject(
                controller.signal.aborted
                  ? controller.signal.reason
                  : new LosslessPlaybackError(
                      "Unable to inspect playback codec",
                    ),
              );
              return;
            }
            try {
              const data = JSON.parse(stdout);
              resolve({
                ...data.streams[0],
                duration:
                  Math.max(0, Number(data.format.start_time) || 0) +
                  Number(data.format.duration),
              });
            } catch {
              reject(new LosslessPlaybackError("Invalid playback metadata"));
            }
          },
        );
      }),
    controller.signal,
  )
    .then((info) => {
      probes.set(key, info);
      while (probes.size > 64) probes.delete(probes.keys().next().value!);
      return info;
    })
    .finally(() => {
      entry.settled = true;
      probeJobs.delete(key);
    });
  probeJobs.set(key, job);
  return owned(job, signal);
}

async function stat(filePath: string): Promise<LocalFileStat | null> {
  try {
    const info = await fs.stat(filePath);
    return info.isFile() && info.size > 0
      ? { absolutePath: filePath, size: info.size, mtimeMs: info.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

async function reserve(root: string) {
  const entries = await fs.readdir(root);
  // Each encoder creates its lock before reserving space. Include every
  // outstanding reservation, also from another server process, in the limit.
  let pending = 0;
  for (const name of entries.filter((name) =>
    /^[a-f0-9]{64}\.mp4\.lock$/.test(name),
  )) {
    const filePath = path.join(root, name);
    const info = await fs.stat(filePath).catch(() => null);
    if (!info) continue;
    let stale = Date.now() - info.mtimeMs > RECENT_MS;
    try {
      const owner = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") stale = true;
        }
      }
    } catch {
      // Another encoder may still be writing its new lock.
    }
    if (stale) await fs.unlink(filePath).catch(() => undefined);
    else pending++;
  }
  const remainingBytes = CACHE_BYTES - pending * MAX_FILE_BYTES;
  const remainingFiles = 128 - pending;
  const leased = new Set<string>();
  for (const name of entries.filter((name) =>
    /^[a-f0-9]{64}\.lease-(?:[a-f0-9]{32}|legacy)$/.test(name),
  )) {
    const lease = await fs.stat(path.join(root, name)).catch(() => null);
    if (lease && Date.now() - lease.mtimeMs < RECENT_MS)
      leased.add(name.slice(0, 64));
    else await fs.unlink(path.join(root, name)).catch(() => undefined);
  }
  for (const name of entries.filter((name) =>
    /^[a-f0-9]{64}\..+\.part\.mp4$/.test(name),
  )) {
    const file = await stat(path.join(root, name));
    if (file && Date.now() - file.mtimeMs > 2 * RECENT_MS)
      await fs.unlink(file.absolutePath).catch(() => undefined);
  }
  const files = (
    await Promise.all(
      entries
        .filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name))
        .map((name) => stat(path.join(root, name))),
    )
  ).filter((file): file is LocalFileStat => !!file);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let count = files.length;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= remainingBytes && count <= remainingFiles) break;
    if (leased.has(path.basename(file.absolutePath).slice(0, 64))) continue;
    await fs.unlink(file.absolutePath).catch(() => undefined);
    total -= file.size;
    count--;
  }
  if (total > remainingBytes || count > remainingFiles)
    throw new LosslessPlaybackError(
      "Playback cache is full; active videos are retained",
    );
}

async function lock(
  filePath: string,
  signal: AbortSignal,
): Promise<(() => Promise<void>) | null> {
  const lockPath = filePath + ".lock";
  while (true) {
    signal.throwIfAborted();
    if (await stat(filePath)) return null;
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, at: Date.now() }),
        );
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (Date.now() - Number(owner.at) > RECENT_MS)
          await fs.unlink(lockPath).catch(() => undefined);
        else if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH")
              await fs.unlink(lockPath).catch(() => undefined);
          }
        }
      } catch {
        const age = await fs.stat(lockPath).catch(() => null);
        if (age && Date.now() - age.mtimeMs > RECENT_MS)
          await fs.unlink(lockPath).catch(() => undefined);
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, 100);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

async function encode(
  source: LocalFileStat,
  output: string,
  from: number,
  to: number,
  info: Probe,
  signal: AbortSignal,
  color?: PlaybackColor,
) {
  const partial = output + "." + randomUUID() + ".part.mp4";
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "2",
        "-filter_threads",
        "1",
        "-ss",
        String(from),
        "-t",
        String(to - from),
        "-i",
        source.absolutePath,
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "ultrafast",
        "-qp",
        "0",
        "-pix_fmt",
        info.pix_fmt,
        "-g",
        "60",
        "-fps_mode",
        "passthrough",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-y",
        partial,
      ];
      if (color && !color.fullRange && info.pix_fmt === "yuvj420p") {
        // Reinterpret the same YUV samples with the original browser's range.
        // Full-to-full scaling keeps every sample unchanged; only tags change.
        args.splice(args.indexOf("-pix_fmt") + 1, 1, "yuv420p");
        args.splice(
          args.length - 2,
          0,
          "-vf",
          "scale=in_range=full:out_range=full,format=yuv420p,setparams=range=limited",
        );
      }
      if (color)
        args.splice(
          args.length - 2,
          0,
          "-colorspace",
          color.matrix,
          "-color_primaries",
          color.primaries,
          "-color_trc",
          color.transfer,
          "-color_range",
          color.fullRange ? "pc" : "tv",
        );
      const child = spawn("ffmpeg", args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new LosslessPlaybackError("Playback preparation timed out");
        child.kill("SIGKILL");
      }, 150000);
      child.stdout.on("data", (bytes) => {
        for (const match of String(bytes).matchAll(/total_size=(\d+)/g)) {
          if (Number(match[1]) > MAX_FILE_BYTES) {
            failure = new LosslessPlaybackError(
              "Lossless playback cache item is too large",
            );
            child.kill("SIGKILL");
          }
        }
      });
      // Drain stderr without retaining input paths or unbounded decoder logs.
      child.stderr.on("data", () => undefined);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(signal.aborted ? signal.reason : error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new LosslessPlaybackError("Unable to prepare lossless playback"),
          );
        else resolve();
      });
    });
    signal.throwIfAborted();
    const [original, result] = await Promise.all([
      fs.stat(source.absolutePath),
      stat(partial),
    ]);
    if (
      !result ||
      result.size > MAX_FILE_BYTES ||
      original.size !== source.size ||
      original.mtimeMs !== source.mtimeMs
    )
      throw new LosslessPlaybackError(
        "Video changed during playback preparation",
      );
    await fs.chmod(partial, 0o600);
    await fs.rename(partial, output);
  } finally {
    await fs.unlink(partial).catch(() => undefined);
  }
}

async function prepare(
  source: LocalFileStat,
  output: string,
  from: number,
  to: number,
  info: Probe,
  signal: AbortSignal,
  owners: () => string[],
  color?: PlaybackColor,
) {
  return encodeSlot(async () => {
    const cached = await stat(output);
    if (cached) return cached;
    const release = await lock(output, signal);
    if (!release) return (await stat(output))!;
    try {
      await reserve(path.dirname(output));
      await encode(source, output, from, to, info, signal, color);
      await Promise.all(
        owners().map((owner) =>
          touchLease(
            path.dirname(output),
            path.basename(output, ".mp4"),
            owner,
          ),
        ),
      );
      return (await stat(output))!;
    } finally {
      await release();
    }
  }, signal);
}

async function owned<T>(job: Job<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  job.owners++;
  let abort!: () => void;
  try {
    return await Promise.race([
      job.promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
    job.owners--;
    if (!job.settled && job.owners === 0) job.controller.abort();
  }
}

/** Episode-local, pixel-lossless HEVC compatibility copies; originals are read only. */
export async function getLosslessPlaybackFile(
  source: LocalFileStat,
  range: { from: number; to?: number; lease?: string; color?: PlaybackColor },
  signal: AbortSignal,
  cacheRoot = process.env.XENSE_VIDEO_CACHE_DIR?.trim() || DEFAULT_CACHE,
): Promise<{ file: LocalFileStat; converted: boolean; cacheKey?: string }> {
  signal.throwIfAborted();
  if (
    !Number.isFinite(range.from) ||
    range.from < 0 ||
    (range.to !== undefined &&
      (!Number.isFinite(range.to) || range.to <= range.from))
  )
    throw new LosslessPlaybackError("Invalid playback interval");
  if (range.lease !== undefined && !/^[a-f0-9]{32}$/.test(range.lease))
    throw new LosslessPlaybackError("Invalid playback lease");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "lossless-h264-v4-episode-clock",
        source.absolutePath,
        source.size,
        source.mtimeMs,
        range.from,
        range.to ?? "end",
        range.color ?? null,
      ]),
    )
    .digest("hex");
  const output = path.join(cacheRoot, hash + ".mp4");
  const leasedFile = async (file: LocalFileStat) => {
    await fs.writeFile(
      path.join(cacheRoot, hash + ".lease-" + (range.lease ?? "legacy")),
      "",
      { mode: 0o600 },
    );
    await fs.utimes(output, new Date(), new Date()).catch(() => undefined);
    return { file, converted: true, cacheKey: hash };
  };
  const existing = await stat(output);
  if (existing) return leasedFile(existing);
  const info = await probe(source, signal);
  signal.throwIfAborted();
  const to = Math.min(range.to ?? info.duration, info.duration);
  if (
    info.codec_name !== "hevc" ||
    !["yuv420p", "yuvj420p"].includes(info.pix_fmt) ||
    info.width * info.height > 1920 * 1080 ||
    !Number.isFinite(to) ||
    to <= range.from ||
    to - range.from > MAX_SECONDS
  )
    return { file: source, converted: false };
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  let job = jobs.get(output);
  if (!job) {
    const controller = new AbortController();
    job = {
      controller,
      owners: 0,
      settled: false,
      promise: undefined!,
      leases: new Map(),
    };
    const entry = job;
    job.promise = prepare(
      source,
      output,
      range.from,
      to,
      info,
      controller.signal,
      () => [...entry.leases.keys()],
      range.color,
    ).finally(() => {
      entry.settled = true;
      if (jobs.get(output) === entry) jobs.delete(output);
    });
    jobs.set(output, job);
  }
  const owner = range.lease ?? "legacy";
  job.leases.set(owner, (job.leases.get(owner) ?? 0) + 1);
  let complete = false;
  try {
    const file = await owned(job, signal);
    const result = await leasedFile(file);
    complete = true;
    return result;
  } finally {
    const remaining = (job.leases.get(owner) ?? 1) - 1;
    if (remaining) job.leases.set(owner, remaining);
    else {
      job.leases.delete(owner);
      if (!complete)
        await fs
          .unlink(path.join(cacheRoot, hash + ".lease-" + owner))
          .catch(() => undefined);
    }
  }
}

export async function releaseLosslessPlaybackLease(
  key: string,
  lease: string,
  root = process.env.XENSE_VIDEO_CACHE_DIR?.trim() || DEFAULT_CACHE,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{32}$/.test(lease))
    throw new LosslessPlaybackError("Invalid playback lease");
  await fs
    .unlink(path.join(root, key + ".lease-" + lease))
    .catch(() => undefined);
}

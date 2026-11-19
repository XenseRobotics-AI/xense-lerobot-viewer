import fs, { type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { LocalFileStat } from "./local-dataset-paths";
import { createFileBody } from "./file-response";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const MAX_BOXES = 64;

type Box = { type: string; start: number; size: number; header: number };
export type FastStartLayout = {
  /** Insert the patched index immediately before the original mdat. */
  insertAt: number;
  indexAt: number;
  index: Buffer;
};
const cache = new Map<
  string,
  { identity: string; layout: FastStartLayout | null }
>();
const inFlight = new Map<string, Promise<FastStartLayout | null>>();
let cacheBytes = 0;
class InvalidMp4 extends Error {}

async function readExactly(file: FileHandle, position: number, size: number) {
  const bytes = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const result = await file.read(bytes, read, size - read, position + read);
    if (!result.bytesRead) throw new InvalidMp4("Truncated MP4");
    read += result.bytesRead;
  }
  return bytes;
}

function boxHeader(bytes: Buffer, start: number, end: number): Box {
  if (end - start < 8) throw new InvalidMp4("Invalid MP4 box");
  let size = bytes.readUInt32BE(start);
  const header = size === 1 ? 16 : 8;
  if (header === 16) {
    if (end - start < 16) throw new InvalidMp4("Invalid extended MP4 box");
    const extended = bytes.readBigUInt64BE(start + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER))
      throw new InvalidMp4("MP4 box too large");
    size = Number(extended);
  } else if (size === 0) size = end - start;
  if (size < header || size > end - start)
    throw new InvalidMp4("Invalid MP4 box size");
  return {
    type: bytes.toString("latin1", start + 4, start + 8),
    start,
    size,
    header,
  };
}

/** Patch chunk offsets, never sample/codec data. Unknown layouts use the raw file. */
function patchIndex(index: Buffer, media: Box, indexAt: number): boolean {
  let tables = 0;
  let boxes = 0;
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
  const visit = (start: number, end: number, depth: number) => {
    if (depth > 6) throw new InvalidMp4("MP4 nesting too deep");
    for (let position = start; position < end; ) {
      if (++boxes > 10000) throw new InvalidMp4("Too many MP4 index boxes");
      const box = boxHeader(index, position, end);
      const payload = position + box.header;
      const boxEnd = position + box.size;
      if (["cmov", "mvex", "saio", "iloc"].includes(box.type))
        throw new InvalidMp4("Unsupported MP4 offset layout");
      if (containers.has(box.type)) visit(payload, boxEnd, depth + 1);
      else if (box.type === "stco" || box.type === "co64") {
        if (boxEnd - payload < 8 || index.readUInt32BE(payload) !== 0)
          throw new InvalidMp4("Invalid chunk offset table");
        const count = index.readUInt32BE(payload + 4);
        const width = box.type === "stco" ? 4 : 8;
        if (boxEnd - payload !== 8 + count * width)
          throw new InvalidMp4("Truncated chunk offset table");
        for (let i = 0; i < count; i++) {
          const at = payload + 8 + i * width;
          const offset =
            width === 4
              ? BigInt(index.readUInt32BE(at))
              : index.readBigUInt64BE(at);
          if (
            offset < BigInt(media.start + media.header) ||
            offset >= BigInt(media.start + media.size) ||
            offset >= BigInt(indexAt)
          )
            throw new InvalidMp4("Chunk outside the media payload");
          const shifted = offset + BigInt(index.length);
          if (width === 4) {
            if (shifted > BigInt(0xffffffff))
              throw new InvalidMp4("32-bit chunk offset overflow");
            index.writeUInt32BE(Number(shifted), at);
          } else index.writeBigUInt64BE(shifted, at);
        }
        if (count) tables++;
      }
      position = boxEnd;
    }
  };
  visit(0, index.length, 0);
  return tables > 0;
}

async function inspect(file: LocalFileStat): Promise<FastStartLayout | null> {
  if (file.size < 32 || !Number.isSafeInteger(file.size)) return null;
  const handle = await fs.open(file.absolutePath, "r");
  try {
    const original = await handle.stat();
    if (original.size !== file.size || original.mtimeMs !== file.mtimeMs)
      return null;
    const boxes: Box[] = [];
    for (let position = 0; position < file.size; ) {
      if (boxes.length >= MAX_BOXES) return null;
      const bytes = await readExactly(
        handle,
        position,
        Math.min(16, file.size - position),
      );
      // Parse only headers; skip all media bytes, including multi-GB shards.
      const header = boxHeader(bytes, 0, file.size - position);
      const box = { ...header, start: position };
      if (!["ftyp", "free", "wide", "mdat", "moov"].includes(box.type))
        return null;
      boxes.push(box);
      position += box.size;
    }
    const media = boxes.filter((box) => box.type === "mdat");
    const indices = boxes.filter((box) => box.type === "moov");
    const index = indices[0];
    if (
      boxes[0]?.type !== "ftyp" ||
      media.length !== 1 ||
      indices.length !== 1 ||
      index !== boxes.at(-1) ||
      index.start < media[0].start ||
      index.size > MAX_INDEX_BYTES
    )
      return null;
    const bytes = await readExactly(handle, index.start, index.size);
    if (!patchIndex(bytes, media[0], index.start)) return null;
    const current = await handle.stat();
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs)
      return null;
    return { insertAt: media[0].start, indexAt: index.start, index: bytes };
  } catch (error) {
    // Malformed, uncommon, already-faststart and fragmented files keep their
    // original representation. Optimization must never prevent playback.
    if (error instanceof InvalidMp4) return null;
    // Transient I/O failure cannot select a different byte layout at the same
    // playback URL: a later range must not mix raw and relocated offsets.
    throw error;
  } finally {
    await handle.close();
  }
}

/** Per-version shared, bounded index cache; no disk cache or dataset writes. */
export async function getFastStartLayout(file: LocalFileStat) {
  const identity = `${file.size}:${file.mtimeMs}`;
  const cached = cache.get(file.absolutePath);
  if (cached?.identity === identity) {
    cache.delete(file.absolutePath);
    cache.set(file.absolutePath, cached);
    return cached.layout;
  }
  const key = `${file.absolutePath}:${identity}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = inspect(file);
  inFlight.set(key, request);
  try {
    const layout = await request;
    cacheBytes -= cache.get(file.absolutePath)?.layout?.index.length ?? 0;
    cache.delete(file.absolutePath);
    cache.set(file.absolutePath, { identity, layout });
    cacheBytes += layout?.index.length ?? 0;
    while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)?.layout?.index.length ?? 0;
      cache.delete(oldest);
    }
    return layout;
  } finally {
    inFlight.delete(key);
  }
}

/** Serve the virtual ftyp/moov/mdat layout with bounded, cancellable reads. */
export function createFastStartResponse(
  file: LocalFileStat,
  layout: FastStartLayout,
  signal: AbortSignal,
  init: ResponseInit,
  range = { start: 0, end: file.size - 1 },
): Response {
  if (signal.aborted) return new Response(null, { status: 499 });
  const spans = [
    { start: 0, end: layout.insertAt - 1, offset: 0 },
    {
      start: layout.insertAt,
      end: layout.insertAt + layout.index.length - 1,
      index: true,
    },
    {
      start: layout.insertAt + layout.index.length,
      end: file.size - 1,
      offset: -layout.index.length,
    },
  ]
    .map((span) => ({
      ...span,
      start: Math.max(span.start, range.start),
      end: Math.min(span.end, range.end),
    }))
    .filter((span) => span.start <= span.end);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let terminal = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const abort = () => {
    if (terminal) return;
    terminal = true;
    cleanup();
    output.error(new DOMException("File request aborted", "AbortError"));
    void reader?.cancel().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          while (!terminal) {
            if (reader) {
              const chunk = await reader.read();
              if (terminal) return;
              if (!chunk.done) {
                controller.enqueue(chunk.value);
                return;
              }
              reader.releaseLock();
              reader = undefined;
            }
            const span = spans[0];
            if (!span) {
              terminal = true;
              cleanup();
              controller.close();
              return;
            }
            if (span.index) {
              const end = Math.min(span.end, span.start + 64 * 1024 - 1);
              controller.enqueue(
                new Uint8Array(
                  layout.index.subarray(
                    span.start - layout.insertAt,
                    end - layout.insertAt + 1,
                  ),
                ),
              );
              span.start = end + 1;
              if (span.start > span.end) spans.shift();
              return;
            }
            spans.shift();
            reader = createFileBody(
              createReadStream(file.absolutePath, {
                start: span.start + span.offset!,
                end: span.end + span.offset!,
                highWaterMark: 64 * 1024,
              }),
              signal,
            ).getReader();
          }
        } catch (error) {
          if (terminal) return;
          terminal = true;
          cleanup();
          controller.error(error);
          await reader?.cancel().catch(() => undefined);
        }
      },
      async cancel() {
        terminal = true;
        cleanup();
        await reader?.cancel();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  try {
    return new Response(body, init);
  } catch (error) {
    void body.cancel().catch(() => undefined);
    throw error;
  }
}

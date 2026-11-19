import { NextRequest } from "next/server";
import path from "node:path";
import { statDatasetFile } from "@/lib/local-dataset-paths";
import { createFileResponse } from "@/lib/file-response";
import { getLosslessPlaybackFile } from "@/lib/lossless-video-cache";
import type { LocalFileStat } from "@/lib/local-dataset-paths";
import type { PlaybackColor } from "@/utils/videoPlaybackUrl";
import {
  createFastStartResponse,
  getFastStartLayout,
} from "@/lib/mp4-faststart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const DEFAULT_VIDEO_RANGE_CHUNK_SIZE = 2 * 1024 * 1024;
const INITIAL_VIDEO_RANGE_CHUNK_SIZE = 256 * 1024;
const MAX_LOSSLESS_RANGE_CHUNK_SIZE = 32 * 1024 * 1024;

function losslessChunkSize(req: NextRequest, fileSize: number) {
  const from = Number(req.nextUrl.searchParams.get("from") ?? 0);
  const to = Number(req.nextUrl.searchParams.get("to"));
  // A paused preload keeps its HTTP/1 connection until the range ends. Size
  // each range for roughly two seconds of this camera, so low-bitrate
  // tactile feeds do not occupy connections needed by the wrist cameras.
  const seconds = to - from;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(
        MAX_LOSSLESS_RANGE_CHUNK_SIZE,
        Math.max(
          INITIAL_VIDEO_RANGE_CHUNK_SIZE,
          Math.ceil((fileSize / seconds) * 2),
        ),
      )
    : DEFAULT_VIDEO_RANGE_CHUNK_SIZE;
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".jsonl") return "application/x-ndjson; charset=utf-8";
  if (ext === ".parquet") return "application/octet-stream";
  if (VIDEO_EXTENSIONS.has(ext)) return "video/mp4";
  return "application/octet-stream";
}

function normalizeRange(
  rangeHeader: string,
  fileSize: number,
  initialChunkSize = DEFAULT_VIDEO_RANGE_CHUNK_SIZE,
  subsequentChunkSize = DEFAULT_VIDEO_RANGE_CHUNK_SIZE,
): { start: number; end: number } | null {
  if (fileSize === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  let start: number;
  let end: number;

  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    if (!Number.isFinite(start) || start < 0) return null;
    end =
      endRaw === ""
        ? Math.min(
            start + (start === 0 ? initialChunkSize : subsequentChunkSize) - 1,
            fileSize - 1,
          )
        : Number.parseInt(endRaw, 10);
    if (!Number.isFinite(end) || end < start) return null;
    end = Math.min(end, fileSize - 1);
  }

  if (start >= fileSize) return null;
  return { start, end };
}

function buildCommonHeaders(filePath: string, size: number): Headers {
  const headers = new Headers();
  headers.set("content-type", inferContentType(filePath));
  headers.set("accept-ranges", "bytes");
  headers.set(
    "cache-control",
    "private, max-age=3600, stale-while-revalidate=86400",
  );
  headers.set("content-length", String(size));
  return headers;
}

async function playbackFile(req: NextRequest, source: LocalFileStat) {
  if (
    req.nextUrl.searchParams.get("compat") !== "lossless-h264" ||
    path.extname(source.absolutePath).toLowerCase() !== ".mp4"
  )
    return { file: source, converted: false };
  const from = Number(req.nextUrl.searchParams.get("from") ?? 0);
  const end = req.nextUrl.searchParams.get("to");
  const lease = req.nextUrl.searchParams.get("lease");
  const matrix = req.nextUrl.searchParams.get("matrix");
  const primaries = req.nextUrl.searchParams.get("primaries");
  const transfer = req.nextUrl.searchParams.get("transfer");
  const fullRange = req.nextUrl.searchParams.get("full_range");
  const color =
    ["bt709", "smpte170m"].includes(matrix ?? "") &&
    ["bt709", "smpte170m"].includes(primaries ?? "") &&
    ["bt709", "smpte170m", "iec61966-2-1"].includes(transfer ?? "") &&
    ["0", "1"].includes(fullRange ?? "")
      ? ({
          matrix,
          primaries,
          transfer,
          fullRange: fullRange === "1",
        } as PlaybackColor)
      : undefined;
  return getLosslessPlaybackFile(
    source,
    {
      from,
      ...(end === null ? {} : { to: Number(end) }),
      ...(lease === null ? {} : { lease }),
      ...(color ? { color } : {}),
    },
    req.signal,
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string; filePath: string[] }> },
) {
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const { encodedPath, filePath } = await ctx.params;
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const source = await statDatasetFile(encodedPath, filePath);
  if (req.signal.aborted) return new Response(null, { status: 499 });
  if (!source) return new Response("Not found", { status: 404 });
  let playback;
  try {
    playback = await playbackFile(req, source);
  } catch {
    return new Response(
      req.signal.aborted ? null : "Unable to prepare compatible playback",
      { status: req.signal.aborted ? 499 : 503 },
    );
  }
  const { file, converted } = playback;

  const layout =
    !converted &&
    req.nextUrl.searchParams.get("playback") === "1" &&
    path.extname(file.absolutePath).toLowerCase() === ".mp4"
      ? await getFastStartLayout(file)
      : null;
  if (req.signal.aborted) return new Response(null, { status: 499 });

  const rangeHeader = req.headers.get("range");
  if (!rangeHeader) {
    const headers = buildCommonHeaders(file.absolutePath, file.size);
    if (layout)
      return createFastStartResponse(file, layout, req.signal, {
        status: 200,
        headers,
      });
    return createFileResponse(file.absolutePath, req.signal, {
      status: 200,
      headers,
    });
  }

  // Give all cameras their index and first packets before one preload occupies
  // an HTTP connection with a large segment. Compatible reads follow bitrate.
  const compatibleChunk = converted ? losslessChunkSize(req, file.size) : 0;
  const firstChunk = converted
    ? compatibleChunk
    : layout
      ? Math.min(
          DEFAULT_VIDEO_RANGE_CHUNK_SIZE,
          Math.max(
            INITIAL_VIDEO_RANGE_CHUNK_SIZE,
            layout.insertAt + layout.index.length + 64 * 1024,
          ),
        )
      : DEFAULT_VIDEO_RANGE_CHUNK_SIZE;
  const range = normalizeRange(
    rangeHeader,
    file.size,
    firstChunk,
    converted ? compatibleChunk : DEFAULT_VIDEO_RANGE_CHUNK_SIZE,
  );
  if (!range) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        "content-range": `bytes */${file.size}`,
      },
    });
  }

  const headers = buildCommonHeaders(
    file.absolutePath,
    range.end - range.start + 1,
  );
  headers.set(
    "content-range",
    `bytes ${range.start}-${range.end}/${file.size}`,
  );

  if (layout)
    return createFastStartResponse(
      file,
      layout,
      req.signal,
      { status: 206, headers },
      range,
    );

  return createFileResponse(
    file.absolutePath,
    req.signal,
    { status: 206, headers },
    range,
  );
}

export async function HEAD(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string; filePath: string[] }> },
) {
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const { encodedPath, filePath } = await ctx.params;
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const source = await statDatasetFile(encodedPath, filePath);
  if (req.signal.aborted) return new Response(null, { status: 499 });
  if (!source) return new Response(null, { status: 404 });
  let playback;
  try {
    playback = await playbackFile(req, source);
  } catch {
    return new Response(
      req.signal.aborted ? null : "Unable to prepare compatible playback",
      { status: req.signal.aborted ? 499 : 503 },
    );
  }
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const { file, converted } = playback;
  const headers = buildCommonHeaders(file.absolutePath, file.size);
  headers.set(
    "x-video-playback-codec",
    converted ? "h264-lossless" : "original",
  );
  if ("cacheKey" in playback && playback.cacheKey)
    headers.set("x-video-cache-key", playback.cacheKey);

  return new Response(null, {
    status: 200,
    headers,
  });
}

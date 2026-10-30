import { NextRequest } from "next/server";
import path from "node:path";
import { statDatasetFile } from "@/lib/local-dataset-paths";
import { createFileResponse } from "@/lib/file-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const DEFAULT_VIDEO_RANGE_CHUNK_SIZE = 2 * 1024 * 1024;

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
        ? Math.min(start + DEFAULT_VIDEO_RANGE_CHUNK_SIZE - 1, fileSize - 1)
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

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string; filePath: string[] }> },
) {
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const { encodedPath, filePath } = await ctx.params;
  if (req.signal.aborted) return new Response(null, { status: 499 });
  const file = await statDatasetFile(encodedPath, filePath);
  if (req.signal.aborted) return new Response(null, { status: 499 });
  if (!file) return new Response("Not found", { status: 404 });

  const rangeHeader = req.headers.get("range");
  if (!rangeHeader) {
    const headers = buildCommonHeaders(file.absolutePath, file.size);
    return createFileResponse(file.absolutePath, req.signal, {
      status: 200,
      headers,
    });
  }

  const range = normalizeRange(rangeHeader, file.size);
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
  const file = await statDatasetFile(encodedPath, filePath);
  if (req.signal.aborted) return new Response(null, { status: 499 });
  if (!file) return new Response(null, { status: 404 });

  return new Response(null, {
    status: 200,
    headers: buildCommonHeaders(file.absolutePath, file.size),
  });
}

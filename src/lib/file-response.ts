import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/** One request owns one file stream; consumer cancellation also closes the file. */
export function createFileResponse(
  filePath: string,
  signal: AbortSignal,
  init: ResponseInit,
  range?: { start: number; end: number },
): Response {
  if (signal.aborted) return new Response(null, { status: 499 });

  // Do not pass the signal into createReadStream: an already-aborted signal
  // destroys it before toWeb can install its error/close listeners on Node 18.
  const source = createReadStream(filePath, range);
  const body = Readable.toWeb(source, {
    strategy: {
      highWaterMark: 64 * 1024,
      size: (chunk: Uint8Array) => chunk.byteLength,
    },
  }) as unknown as ReadableStream<Uint8Array>;
  const abort = () => {
    source.destroy(new DOMException("File request aborted", "AbortError"));
  };
  const cleanup = () => signal.removeEventListener("abort", abort);
  source.once("close", cleanup);
  signal.addEventListener("abort", abort, { once: true });
  // Close the check/subscribe gap without cancelling/disturbing the Web body.
  if (signal.aborted) abort();

  try {
    return new Response(body, init);
  } catch (error) {
    cleanup();
    source.destroy();
    throw error;
  }
}

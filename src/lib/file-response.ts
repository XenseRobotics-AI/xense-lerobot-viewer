import { createReadStream, type ReadStream } from "node:fs";

const FILE_QUEUE_BYTES = 64 * 1024;

/** Bridge one auto-closing file stream with exactly one terminal Web action. */
export function createFileBody(
  source: ReadStream,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  // Node 18's toWeb closes again from finished() when a reader cancels between
  // EOF and fd close. Own that lifecycle instead of delegating to that adapter.
  source.pause();
  let terminal = false;
  let ended = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const cleanupRequest = () => signal.removeEventListener("abort", onAbort);
  const cleanupSource = () => {
    cleanupRequest();
    source.removeListener("data", onData);
    source.removeListener("end", onEnd);
    source.removeListener("error", onError);
    source.removeListener("close", onClose);
    resolveClosed();
  };
  const fail = (error: unknown) => {
    if (terminal) return;
    terminal = true;
    cleanupRequest();
    output.error(error);
    source.destroy();
  };
  const prematureClose = () =>
    Object.assign(new Error("File stream closed before reaching EOF"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
  const onData = (chunk: Buffer | string) => {
    if (terminal) return;
    output.enqueue(
      new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    if ((output.desiredSize ?? 0) <= 0) source.pause();
  };
  const onEnd = () => {
    ended = true;
  };
  const onError = (error: Error) => fail(error);
  const onClose = () => {
    cleanupSource();
    if (terminal) return;
    terminal = true;
    if (ended) output.close();
    else output.error(prematureClose());
  };
  const onAbort = () =>
    fail(new DOMException("File request aborted", "AbortError"));

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        source.on("data", onData);
        source.once("end", onEnd);
        // Keep the error listener until fd close, including after cancellation.
        source.on("error", onError);
        source.once("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else if (source.destroyed) fail(source.errored ?? prematureClose());
        if (source.closed) cleanupSource();
      },
      pull() {
        if (!terminal) source.resume();
      },
      cancel() {
        // A cancelled Web stream is already closed. Suppress EOF/close/data
        // callbacks before destroying the Node stream, never close it again.
        terminal = true;
        cleanupRequest();
        source.destroy();
        return closed;
      },
    },
    {
      highWaterMark: FILE_QUEUE_BYTES,
      size: (chunk) => chunk?.byteLength ?? 0,
    },
  );
}

/** One request owns one file stream; consumer cancellation also closes the file. */
export function createFileResponse(
  filePath: string,
  signal: AbortSignal,
  init: ResponseInit,
  range?: { start: number; end: number },
): Response {
  if (signal.aborted) return new Response(null, { status: 499 });
  // Attach all lifecycle handlers before propagating an abort to the file.
  const source = createReadStream(filePath, {
    ...range,
    highWaterMark: FILE_QUEUE_BYTES,
  });
  const body = createFileBody(source, signal);
  try {
    return new Response(body, init);
  } catch (error) {
    void body.cancel().catch(() => undefined);
    throw error;
  }
}

type Emit = (event: unknown) => void;

/** A read-only task belongs to this response and stops when its reader leaves. */
export function createTaskStreamResponse(
  requestSignal: AbortSignal,
  run: (emit: Emit, signal: AbortSignal) => Promise<void>,
  options: { timeoutMs: number; timeoutMessage: string },
): Response {
  if (requestSignal.aborted) return new Response(null, { status: 499 });

  const job = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", onAbort);
  };
  const cancel = () => {
    if (closed) return;
    closed = true;
    cleanup();
    job.abort(new DOMException("Client disconnected", "AbortError"));
  };
  const emit: Emit = (event) => {
    if (closed) return;
    // Serialization is a task failure, not evidence that the reader left.
    const bytes = encoder.encode(JSON.stringify(event) + "\n");
    try {
      output.enqueue(bytes);
    } catch {
      cancel();
    }
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    cleanup();
    output.close();
  };
  const onAbort = () => {
    finish();
    job.abort(new DOMException("Client disconnected", "AbortError"));
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) {
        onAbort();
        return;
      }
      timeout = setTimeout(() => {
        if (closed) return;
        emit({ type: "error", error: options.timeoutMessage });
        finish();
        job.abort(new DOMException(options.timeoutMessage, "TimeoutError"));
      }, options.timeoutMs);
      timeout.unref?.();

      // Observe both synchronous and asynchronous failures. A cancelled reader
      // must never be closed/enqueued again when a delayed task settles.
      void Promise.resolve()
        .then(() => {
          if (!job.signal.aborted) return run(emit, job.signal);
        })
        .then(finish, (error: unknown) => {
          if (!job.signal.aborted) {
            emit({
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          finish();
        });
    },
    cancel,
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

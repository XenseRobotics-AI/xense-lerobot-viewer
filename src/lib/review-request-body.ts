/** Bound bytes while streaming, including requests without Content-Length. */
export async function readReviewRequestBody(
  request: Request,
  maxBytes = 8192,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new ReviewBodyError();
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("A JSON body is required");
  let size = 0;
  const decoder = new TextDecoder();
  let body = "";
  const consume = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ReviewBodyError();
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (status: 408 | 499) => {
      reject(new ReviewBodyError(status));
      void reader.cancel().catch(() => undefined);
    };
    onAbort = () => stop(499);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    else timeout = setTimeout(() => stop(408), options.timeoutMs ?? 10000);
  });
  try {
    return await Promise.race([interrupted, consume()]);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
export class ReviewBodyError extends Error {
  constructor(public readonly status: 413 | 408 | 499 = 413) {
    super(
      status === 413
        ? "Review request body is too large"
        : status === 408
          ? "Review request body timed out"
          : "Review request was cancelled",
    );
  }
}

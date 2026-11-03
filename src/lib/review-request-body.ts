/** Bound bytes while streaming, including requests without Content-Length. */
export async function readReviewRequestBody(
  request: Request,
  maxBytes = 8192,
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ReviewBodyError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("A JSON body is required");
  let size = 0;
  const decoder = new TextDecoder();
  let body = "";
  try {
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
  } finally {
    reader.releaseLock();
  }
}
export class ReviewBodyError extends Error {
  constructor() {
    super("Review request body is too large");
  }
}

/** Read UTF-8 lines while owning the reader until completion or cancellation. */
export async function consumeResponseLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
      if (done) break;
    }
    onLine(buffer);
    complete = true;
  } finally {
    try {
      if (!complete) await reader.cancel();
    } catch {
      // Keep the original transport/parser/callback error, not a cleanup error.
    } finally {
      reader.releaseLock();
    }
  }
}

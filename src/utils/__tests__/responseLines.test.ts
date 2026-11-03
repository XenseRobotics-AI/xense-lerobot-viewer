import { describe, expect, test } from "bun:test";
import { consumeResponseLines } from "../responseLines";

describe("response line reader ownership", () => {
  test("decodes split UTF-8, CRLF and the final line without a newline", async () => {
    const bytes = new TextEncoder().encode("洪锐\r\n卫皓焱\n复检");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const lines: string[] = [];
    await consumeResponseLines(body, (line) => lines.push(line));
    expect(lines).toEqual(["洪锐", "卫皓焱", "复检"]);
    expect(body.locked).toBe(false);
  });
  test("parser/callback failure cancels unread bytes and releases the reader", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("bad JSON\n"));
      },
      cancel() {
        cancelled++;
        throw new Error("cleanup failed");
      },
    });
    await expect(
      consumeResponseLines(body, () => {
        throw new Error("invalid event");
      }),
    ).rejects.toThrow("invalid event");
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  });
  test("transport errors retain their identity and release the reader", async () => {
    const error = new DOMException("Disconnected", "AbortError");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });
    await expect(consumeResponseLines(body, () => {})).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });
  test("normal completion releases the lock without cancelling the producer", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
      cancel() {
        cancelled++;
      },
    });
    await consumeResponseLines(body, () => {});
    expect(cancelled).toBe(0);
    expect(body.locked).toBe(false);
  });
});

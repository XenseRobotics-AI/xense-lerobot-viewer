import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** A confirmed write task owns its process/lock; HTTP only owns its output. */
export function createBackgroundProcessResponse(
  spawn: () => ChildProcessWithoutNullStreams,
  onFinished: () => void,
  signal: AbortSignal,
): Response {
  if (signal.aborted) {
    onFinished();
    return new Response(null, { status: 499 });
  }
  const encoder = new TextEncoder();
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let finished = false;
  let buffer = "";
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finishJob = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    onFinished();
  };
  const detach = () => {
    closed = true;
    buffer = "";
    signal.removeEventListener("abort", onAbort);
    // A slow connected reader can pause stdout; a detached reader must drain
    // it so pipe backpressure cannot strand the background write/lock.
    child?.stdout.resume();
  };
  const close = () => {
    if (closed) return;
    output.close();
    detach();
  };
  const onAbort = () => close();
  const send = (event: unknown) => {
    if (closed) return;
    try {
      output.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      if ((output.desiredSize ?? 0) <= 0) child?.stdout.pause();
    } catch {
      detach();
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        try {
          child = spawn();
        } catch (error) {
          send({
            type: "error",
            error: "Failed to launch sync process: " + String(error),
          });
          close();
          finishJob();
          return;
        }
        let sentError = false;
        const forward = (line: string) => {
          if (closed || !line.trim()) return;
          try {
            const event = JSON.parse(line);
            if (event?.type === "error") sentError = true;
            send(event);
          } catch {
            /* stdout can include non-JSON diagnostic lines */
          }
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (closed) return;
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) forward(line);
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-64 * 1024);
        });
        child.on("error", (error) => {
          send({
            type: "error",
            error: "Sync process failed: " + error.message,
          });
          close();
          // Node emits close after error. Keep the write lease until then.
        });
        child.on("close", (code) => {
          forward(buffer);
          if (code !== 0 && !sentError) {
            send({
              type: "error",
              error:
                stderr.trim().split(/\r?\n/).pop() ||
                "Sync exited with code " + code + " and no output.",
            });
          }
          close();
          finishJob();
        });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
      pull() {
        child?.stdout.resume();
      },
      cancel: detach,
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

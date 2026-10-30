interface Task<T> {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

/** Shared read-only work stops only when its last subscriber leaves. */
export class SharedAbortableTaskPool<T> {
  private tasks = new Map<string, Task<T>>();

  run(
    key: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string },
  ): Promise<T> {
    const abortError = () =>
      new DOMException("Client disconnected", "AbortError");
    if (signal.aborted) return Promise.reject(abortError());

    let task = this.tasks.get(key);
    if (!task) {
      const controller = new AbortController();
      const promise = new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return work(controller.signal);
          })
          .then(resolve, reject)
          .finally(() =>
            controller.signal.removeEventListener("abort", onAbort),
          );
      });
      const timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException(options.timeoutMessage, "TimeoutError"),
          ),
        options.timeoutMs,
      );
      timeout.unref?.();
      task = { controller, promise, subscribers: 0, settled: false, timeout };
      this.tasks.set(key, task);
      const current = task;
      const settled = () => {
        current.settled = true;
        clearTimeout(current.timeout);
        if (this.tasks.get(key) === current) this.tasks.delete(key);
      };
      void promise.then(settled, settled);
    }

    const current = task;
    current.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        current.subscribers -= 1;
        if (current.subscribers === 0) {
          clearTimeout(current.timeout);
          if (this.tasks.get(key) === current) this.tasks.delete(key);
          if (!current.settled) current.controller.abort(abortError());
        }
        return true;
      };
      const onAbort = () => {
        if (release()) reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void current.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (error: unknown) => {
          if (release()) reject(error);
        },
      );
    });
  }
}

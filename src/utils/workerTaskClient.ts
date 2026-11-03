export class WorkerUnavailableError extends Error {}
export class SupersededWorkerTaskError extends Error {}
export interface TaskWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
type Job<I, O> = {
  id: number;
  input: I;
  resolve: (result: O) => void;
  reject: (error: Error) => void;
};

/** One active decode per channel. Latest selections precede older queued work. */
export class WorkerTaskClient<I, O> {
  private worker?: TaskWorker;
  private active?: Job<I, O>;
  private queue: Job<I, O>[] = [];
  private nextId = 0;
  private disabled = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      create: () => TaskWorker;
      idleMs: number;
      maxQueued?: number;
      timeoutMs?: number;
    },
  ) {}

  get available(): boolean {
    return !this.disabled;
  }

  warm(): void {
    if (this.disabled || this.worker) return;
    try {
      const worker = this.options.create();
      this.worker = worker;
      worker.onmessage = (event) => {
        if (this.worker !== worker) return;
        const reply = event.data as { id: number; data?: O; error?: string };
        const job = this.active;
        if (!job || reply.id !== job.id) return;
        clearTimeout(this.deadline);
        this.active = undefined;
        if (reply.error !== undefined) job.reject(new Error(reply.error));
        else if (reply.data !== undefined) job.resolve(reply.data);
        else job.reject(new Error("Invalid decoder response"));
        this.pump();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker)
          this.fail(new WorkerUnavailableError("Episode decoder unavailable"));
      };
      worker.onmessageerror = () => {
        if (this.worker === worker)
          this.fail(
            new WorkerUnavailableError("Episode decoder message failed"),
          );
      };
      this.scheduleIdle();
    } catch {
      this.fail(new WorkerUnavailableError("Web Workers unavailable"));
    }
  }

  run(input: I): Promise<O> {
    this.warm();
    if (this.disabled || !this.worker)
      return Promise.reject(
        new WorkerUnavailableError("Web Workers unavailable"),
      );
    clearTimeout(this.idleTimer);
    return new Promise<O>((resolve, reject) => {
      this.queue.unshift({ id: ++this.nextId, input, resolve, reject });
      while (this.queue.length > (this.options.maxQueued ?? 8))
        this.queue
          .pop()!
          .reject(
            new SupersededWorkerTaskError("Obsolete queued episode selection"),
          );
      this.pump();
    });
  }

  private pump() {
    if (this.active || !this.worker) return;
    const job = this.queue.shift();
    if (!job) {
      this.scheduleIdle();
      return;
    }
    this.active = job;
    this.deadline = setTimeout(
      () =>
        this.fail(
          new Error("Episode decode deadline exceeded; retry this episode"),
        ),
      this.options.timeoutMs ?? 120_000,
    );
    try {
      this.worker.postMessage({ id: job.id, input: job.input });
    } catch {
      this.fail(new WorkerUnavailableError("Episode decoder could not start"));
    }
  }

  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (!this.active && !this.queue.length && this.worker)
      this.idleTimer = setTimeout(() => this.release(), this.options.idleMs);
  }

  private release() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.deadline);
    if (this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }

  private fail(error: Error) {
    this.disabled = error instanceof WorkerUnavailableError;
    this.release();
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue = [];
    for (const job of jobs) job.reject(error);
  }
}

export function reviewSaveKey(episode: number, reviewer: string): string {
  return JSON.stringify([episode, reviewer.trim()]);
}

/** Serialize server snapshots without making navigation wait for any write. */
export class ReviewSaveQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, Promise<void>>();

  get size(): number {
    return this.pending.size;
  }
  has(key: string): boolean {
    return this.pending.has(key);
  }

  enqueue(key: string, write: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.tail.then(write);
    const done = operation.then(
      () => {
        this.pending.delete(key);
      },
      (error: unknown) => {
        this.pending.delete(key);
        throw error;
      },
    );
    this.pending.set(key, done);
    // Failure belongs to this record. Later records must still be saved.
    this.tail = done.catch(() => undefined);
    return done;
  }
}

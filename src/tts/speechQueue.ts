/**
 * Serial synthesis queue with de-duplication and re-prioritisation.
 *
 * The Kokoro worker synthesizes one clip at a time. When the user jumps to another step we
 * reorder pending work so the clips needed next are generated first, and drop clips that are
 * no longer needed.
 */

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export type SynthesizeFn = (key: string, text: string) => Promise<string>;

interface Job {
  key: string;
  text: string;
  promise: Promise<string>;
  resolve: (file: string) => void;
  reject: (err: unknown) => void;
}

export class SpeechQueue {
  private readonly done = new Map<string, string>();
  private readonly jobs = new Map<string, Job>();
  private pending: Job[] = [];
  private running: Job | undefined;

  constructor(private readonly synthesize: SynthesizeFn) {}

  /** Returns the clip file for `key`, synthesizing it if needed. */
  request(key: string, text: string): Promise<string> {
    const finished = this.done.get(key);
    if (finished !== undefined) return Promise.resolve(finished);
    const existing = this.jobs.get(key);
    if (existing) return existing.promise;

    let resolve!: (file: string) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that drop a promise must not cause unhandled rejections.
    promise.catch(() => undefined);
    const job: Job = { key, text, promise, resolve, reject };
    this.jobs.set(key, job);
    this.pending.push(job);
    this.pump();
    return promise;
  }

  /**
   * Keeps only pending jobs whose key is in `keysInOrder`, ordered as given.
   * The job currently being synthesized always finishes.
   */
  prioritize(keysInOrder: readonly string[]): void {
    const rank = new Map<string, number>();
    keysInOrder.forEach((k, i) => {
      if (!rank.has(k)) rank.set(k, i);
    });
    const keep: Job[] = [];
    for (const job of this.pending) {
      if (rank.has(job.key)) {
        keep.push(job);
      } else {
        this.jobs.delete(job.key);
        job.reject(new CancelledError());
      }
    }
    keep.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
    this.pending = keep;
  }

  /** Drops all pending work (the running job still completes). */
  clear(): void {
    this.prioritize([]);
  }

  /** Forgets finished results (e.g. after the voice setting changed). */
  reset(): void {
    this.clear();
    this.done.clear();
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private pump(): void {
    if (this.running || this.pending.length === 0) return;
    const job = this.pending.shift()!;
    this.running = job;
    this.synthesize(job.key, job.text).then(
      (file) => {
        this.done.set(job.key, file);
        job.resolve(file);
      },
      (err) => job.reject(err),
    ).finally(() => {
      this.jobs.delete(job.key);
      this.running = undefined;
      this.pump();
    });
  }
}

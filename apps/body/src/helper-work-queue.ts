/** FIFO admission bounds active work without making a burst a refusal. Queued
 * work has not been sent; cancellation never replays an entered operation. */
export class HelperWorkQueue {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; reject: (error: Error) => void }> = [];
  constructor(private readonly concurrency: number) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.active--;
          this.waiting.shift()?.start();
        });
      };
      if (this.active < this.concurrency) start();
      else this.waiting.push({ start, reject });
    });
  }
  cancel(error: Error): void {
    for (const item of this.waiting.splice(0)) item.reject(error);
  }
}


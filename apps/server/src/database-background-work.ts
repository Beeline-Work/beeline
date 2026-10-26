/** Work may finish after a response, but must finish before its database closes. */
export class DatabaseBackgroundWork {
  private readonly pending = new Set<Promise<void>>();

  run(work: () => Promise<void>): void {
    const task = Promise.resolve().then(work);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

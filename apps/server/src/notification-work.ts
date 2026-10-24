/** Keep notification fanout from checking out every foreground database slot. */
export class NotificationWork {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 2) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

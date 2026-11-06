/** The server's sole time source: an owner-created schedule reaching its time. */
export class OwnerScheduleClock {
  private timer?: ReturnType<typeof setTimeout>;
  private dueAt = Infinity;
  constructor(private readonly fire: () => void, private readonly now = Date.now) {}

  arm(delay: number | undefined): void {
    this.stop();
    if (delay === undefined || !Number.isFinite(delay)) return;
    this.dueAt = this.now() + Math.max(0, delay);
    this.wait();
  }

  private wait(): void {
    const remaining = this.dueAt - this.now();
    // Preserve long schedule times without querying or running work early.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.now() < this.dueAt) this.wait();
      else { this.dueAt = Infinity; this.fire(); }
    }, Math.min(Math.max(0, remaining), 2_147_483_647));
    this.timer.unref?.();
  }

  stop(): void { clearTimeout(this.timer); this.timer = undefined; this.dueAt = Infinity; }
}

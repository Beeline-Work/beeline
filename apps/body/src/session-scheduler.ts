export interface SessionLifecycle {
  activate(): Promise<string>;
  suspend(): Promise<void>;
}

export type SessionRunPriority = 'interactive' | 'background';

interface LiveSession {
  physicalSessionId: string;
  lifecycle: SessionLifecycle;
  lastUsedAt: number;
}

/**
 * Workspace-wide bounded session scheduler.
 *
 * A logical channel key is permanently serialized through one FIFO. Physical
 * ACP processes may be suspended while idle, but a key is never assigned to a
 * second live process. Reactivation is an explicit generation change on that
 * same pinned logical session, after its transcript has been restored by Body.
 */
export class SessionScheduler {
  private readonly maxLiveSessions: number;
  private readonly reserveInteractiveSlot: boolean;
  private readonly idleMs: number;
  private readonly live = new Map<string, LiveSession>();
  private readonly busy = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly physicalHistory = new Map<string, string[]>();
  private waiters: Array<() => void> = [];
  private capacityTail: Promise<void> = Promise.resolve();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    options: {
      maxLiveSessions?: number;
      idleMs?: number;
      reserveInteractiveSlot?: boolean;
    } = {},
  ) {
    const requestedMaxLiveSessions = options.maxLiveSessions ?? 4;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(requestedMaxLiveSessions) || requestedMaxLiveSessions < 1) {
      throw new Error('maxLiveSessions must be a positive integer');
    }
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 1) {
      throw new Error('idleMs must be a positive integer');
    }
    this.reserveInteractiveSlot = options.reserveInteractiveSlot ?? false;
    // A responsive scheduler needs one edit process and one Room process. Keep
    // capacity-one schedulers available for low-level bound tests, but promote
    // responsive runtime schedulers to the smallest useful bounded capacity.
    this.maxLiveSessions = this.reserveInteractiveSlot
      ? Math.max(2, requestedMaxLiveSessions)
      : requestedMaxLiveSessions;
    this.sweepTimer = setInterval(() => void this.sweepIdle(), Math.min(this.idleMs, 30_000));
    this.sweepTimer.unref?.();
  }

  /** Run one ordered turn on a channel's pinned logical session. */
  run<T>(
    key: string,
    lifecycle: SessionLifecycle,
    task: () => Promise<T>,
    options: { priority?: SessionRunPriority } = {},
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolveTail) => {
      releaseTail = resolveTail;
    });
    const queuedTail = previous.catch(() => undefined).then(() => tail);
    this.tails.set(key, queuedTail);

    return previous
      .catch(() => undefined)
      .then(async () => {
        await this.ensureLive(key, lifecycle, options.priority ?? 'interactive');
        const session = this.live.get(key)!;
        session.lastUsedAt = Date.now();
        try {
          return await task();
        } finally {
          this.busy.delete(key);
          const current = this.live.get(key);
          if (current) current.lastUsedAt = Date.now();
          this.wakeCapacityWaiters();
        }
      })
      .finally(() => {
        releaseTail();
        if (this.tails.get(key) === queuedTail) this.tails.delete(key);
      });
  }

  physicalSessionId(key: string): string | undefined {
    return this.live.get(key)?.physicalSessionId;
  }

  /** Every physical generation ever used for a logical key (test/diagnostic only). */
  generations(key: string): readonly string[] {
    return this.physicalHistory.get(key) ?? [];
  }

  snapshot(): { live: number; busy: number; queuedChannels: number; maxLive: number } {
    return {
      live: this.live.size,
      busy: this.busy.size,
      queuedChannels: this.tails.size,
      maxLive: this.maxLiveSessions,
    };
  }

  async suspend(key: string): Promise<void> {
    if (this.busy.has(key)) return;
    const session = this.live.get(key);
    if (!session) return;
    this.live.delete(key);
    await session.lifecycle.suspend();
    this.wakeCapacityWaiters();
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const sessions = [...this.live.entries()];
    this.live.clear();
    await Promise.all(sessions.map(([, session]) => session.lifecycle.suspend()));
    this.wakeCapacityWaiters();
  }

  private async ensureLive(
    key: string,
    lifecycle: SessionLifecycle,
    priority: SessionRunPriority,
  ): Promise<void> {
    for (;;) {
      const previousCapacity = this.capacityTail;
      let releaseCapacity!: () => void;
      const capacity = new Promise<void>((resolveCapacity) => {
        releaseCapacity = resolveCapacity;
      });
      this.capacityTail = previousCapacity.catch(() => undefined).then(() => capacity);
      await previousCapacity.catch(() => undefined);

      let retryAfterEviction = false;
      let waitForCapacity: Promise<void> | undefined;
      try {
        if (this.live.has(key)) {
          this.busy.add(key);
          return;
        }

        const capacityLimit =
          priority === 'background' && this.reserveInteractiveSlot
            ? this.maxLiveSessions - 1
            : this.maxLiveSessions;
        if (this.live.size >= capacityLimit) {
          const idle = [...this.live.entries()]
            .filter(([candidate]) => !this.busy.has(candidate))
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
          if (idle) {
            await this.suspend(idle[0]);
            retryAfterEviction = true;
          } else {
            // Register before releasing the capacity lock so a completion
            // cannot race between the full-capacity check and this waiter.
            waitForCapacity = new Promise<void>((resolveWaiter) =>
              this.waiters.push(resolveWaiter),
            );
          }
        }

        if (!waitForCapacity && !retryAfterEviction) {
          const physicalSessionId = await lifecycle.activate();
          const generations = this.physicalHistory.get(key) ?? [];
          generations.push(physicalSessionId);
          this.physicalHistory.set(key, generations);
          this.live.set(key, { physicalSessionId, lifecycle, lastUsedAt: Date.now() });
          // Reserve the process before releasing the capacity lock, otherwise a
          // concurrent key could evict this just-activated session before its task
          // marks itself busy.
          this.busy.add(key);
          return;
        }
      } finally {
        releaseCapacity();
      }

      // A background waiter must not hold the capacity mutex while an
      // interactive Room turn can use the reserved slot.
      await waitForCapacity;
    }
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    for (const [key, session] of [...this.live.entries()]) {
      if (!this.busy.has(key) && session.lastUsedAt <= cutoff) await this.suspend(key);
    }
  }

  private wakeCapacityWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}

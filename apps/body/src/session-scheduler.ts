export interface SessionLifecycle {
  activate(): Promise<string>;
  suspend(): Promise<void>;
  onStateChange?(state: SessionProcessState): Promise<void> | void;
}
export type SessionProcessState = 'live' | 'suspended' | 'waiting-for-slot';

export type SessionRunPriority = 'interactive' | 'background';

interface LiveSession {
  /** Undefined while the reservation is still spawning its ACP process. */
  physicalSessionId?: string;
  lifecycle: SessionLifecycle;
  lastUsedAt: number;
  /** Room this session is budgeted against (a corner budgets against its Room). */
  roomKey: string;
  /** True between slot reservation and a completed `activate()`. */
  pending: boolean;
}

/**
 * Concurrent live ACP processes one Room (its own session plus corners) may hold.
 * Operators can override this with `BUZZY_BODY_MAX_SESSIONS_PER_ROOM`; invalid
 * values fall back here. Raising the ceiling does not change token spend, but
 * every live session is a resident ACP process (typically hundreds of MB), and
 * more simultaneous turns can reach the model provider's concurrency limit
 * sooner and receive HTTP 429 responses.
 */
export const DEFAULT_PER_ROOM_LIVE_SESSIONS = 10;

/** Read the daemon's per-Room session ceiling without letting bad env crash startup. */
export function resolvePerRoomLiveSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BUZZY_BODY_MAX_SESSIONS_PER_ROOM?.trim();
  if (!raw) return DEFAULT_PER_ROOM_LIVE_SESSIONS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PER_ROOM_LIVE_SESSIONS;
}

/**
 * Smallest Workspace-wide ceiling. The dynamic ceiling is
 * `max(this, perRoom x activeRooms)` so a Workspace with many Rooms is not
 * squeezed through a fixed pool, while a single-Room Workspace still gets
 * enough capacity for its Room plus concurrent corners.
 */
export const DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR = 4;

/**
 * Workspace-wide bounded session scheduler.
 *
 * A logical channel key is permanently serialized through one FIFO. Physical
 * ACP processes may be suspended while idle, but a key is never assigned to a
 * second live process. Reactivation is an explicit generation change on that
 * same pinned logical session, after its transcript has been restored by Body.
 *
 * Capacity bookkeeping is guarded by `capacityTail`; the expensive I/O it
 * governs (an eviction's `suspend()`, a spawn's `activate()`) deliberately runs
 * *outside* that mutex. A `pending` placeholder is inserted under the lock and
 * counts against capacity for its whole activation, so oversubscription stays
 * impossible while two Rooms can spawn their processes concurrently. Holding
 * the mutex across the spawn (as this scheduler originally did) made one slow
 * ACP handshake stall every other Room's next turn, workspace-wide.
 */
export class SessionScheduler {
  /** Fixed ceiling when explicitly configured; undefined selects the dynamic one. */
  private readonly fixedMaxLiveSessions?: number;
  private readonly perRoomLiveSessions: number;
  private readonly workspaceFloor: number;
  private readonly activeRoomCount?: () => number;
  private readonly reserveInteractiveSlot: boolean;
  private readonly idleMs: number;
  private readonly live = new Map<string, LiveSession>();
  private readonly busy = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly physicalHistory = new Map<string, string[]>();
  /**
   * Sessions already removed from `live` whose process is still being torn
   * down. They keep occupying capacity until `suspend()` resolves, so an
   * eviction moved out of the critical section cannot transiently exceed the
   * ceiling in real OS processes.
   */
  private readonly suspending = new Set<LiveSession>();
  private waiters: Array<() => void> = [];
  private capacityTail: Promise<void> = Promise.resolve();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    options: {
      /** Fixed Workspace ceiling. Omit to use `max(floor, perRoom x activeRooms)`. */
      maxLiveSessions?: number;
      /** Per-Room budget (a Room and its corners share it). */
      perRoomLiveSessions?: number;
      /** Floor for the dynamic Workspace ceiling. */
      workspaceFloor?: number;
      /** Rooms the supervisor is currently serving; drives the dynamic ceiling. */
      activeRoomCount?: () => number;
      idleMs?: number;
      reserveInteractiveSlot?: boolean;
    } = {},
  ) {
    this.idleMs = options.idleMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 1) {
      throw new Error('idleMs must be a positive integer');
    }
    this.reserveInteractiveSlot = options.reserveInteractiveSlot ?? false;
    if (options.maxLiveSessions !== undefined) {
      if (!Number.isSafeInteger(options.maxLiveSessions) || options.maxLiveSessions < 1) {
        throw new Error('maxLiveSessions must be a positive integer');
      }
      // A responsive scheduler needs one edit process and one Room process. Keep
      // capacity-one schedulers available for low-level bound tests, but promote
      // responsive runtime schedulers to the smallest useful bounded capacity.
      this.fixedMaxLiveSessions = this.reserveInteractiveSlot
        ? Math.max(2, options.maxLiveSessions)
        : options.maxLiveSessions;
    }
    const perRoom = options.perRoomLiveSessions ?? DEFAULT_PER_ROOM_LIVE_SESSIONS;
    if (!Number.isSafeInteger(perRoom) || perRoom < 1) {
      throw new Error('perRoomLiveSessions must be a positive integer');
    }
    this.perRoomLiveSessions = perRoom;
    const floor = options.workspaceFloor ?? DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR;
    if (!Number.isSafeInteger(floor) || floor < 1) {
      throw new Error('workspaceFloor must be a positive integer');
    }
    this.workspaceFloor = floor;
    if (options.activeRoomCount) this.activeRoomCount = options.activeRoomCount;
    this.sweepTimer = setInterval(() => void this.sweepIdle(), Math.min(this.idleMs, 30_000));
    this.sweepTimer.unref?.();
  }

  /** Run one ordered turn on a channel's pinned logical session. */
  run<T>(
    key: string,
    lifecycle: SessionLifecycle,
    task: () => Promise<T>,
    options: { priority?: SessionRunPriority; roomKey?: string } = {},
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
        await this.ensureLive(
          key,
          lifecycle,
          options.priority ?? 'interactive',
          options.roomKey ?? key,
        );
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
        this.wakeCapacityWaiters();
      });
  }

  physicalSessionId(key: string): string | undefined {
    return this.live.get(key)?.physicalSessionId;
  }

  /** Every physical generation ever used for a logical key (test/diagnostic only). */
  generations(key: string): readonly string[] {
    return this.physicalHistory.get(key) ?? [];
  }

  snapshot(): {
    live: number;
    pending: number;
    busy: number;
    queuedChannels: number;
    maxLive: number;
    perRoom: number;
  } {
    let pending = 0;
    for (const session of this.live.values()) if (session.pending) pending += 1;
    return {
      live: this.live.size,
      pending,
      busy: this.busy.size,
      queuedChannels: this.tails.size,
      maxLive: this.workspaceCapacity(),
      perRoom: this.perRoomLiveSessions,
    };
  }

  async suspend(key: string): Promise<void> {
    if (this.busy.has(key) || this.tails.has(key)) return;
    const session = this.live.get(key);
    if (!session) return;
    this.live.delete(key);
    await this.retire(session);
  }

  /**
   * Tear down a poisoned session even when its task is still marked busy.
   * The watchdog uses this only after a Room has stopped making progress; the
   * killed ACP client rejects its pending request and releases the old queue.
   */
  async forceSuspend(key: string): Promise<void> {
    const session = this.live.get(key);
    if (!session) return;
    this.live.delete(key);
    this.busy.delete(key);
    await this.retire(session);
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const sessions = [...this.live.values()];
    this.live.clear();
    await Promise.all(sessions.map((session) => this.retire(session)));
    this.wakeCapacityWaiters();
  }

  /** Workspace ceiling: fixed when configured, else `max(floor, perRoom x rooms)`. */
  private workspaceCapacity(): number {
    if (this.fixedMaxLiveSessions !== undefined) return this.fixedMaxLiveSessions;
    const rooms = this.activeRoomCount?.() ?? this.distinctLiveRooms();
    const dynamic = this.perRoomLiveSessions * Math.max(1, rooms);
    return Math.max(this.workspaceFloor, dynamic);
  }

  private distinctLiveRooms(): number {
    const rooms = new Set<string>();
    for (const session of this.live.values()) rooms.add(session.roomKey);
    return rooms.size;
  }

  /** Live plus still-dying sessions — the real occupied-process count. */
  private occupied(): number {
    return this.live.size + this.suspending.size;
  }

  private async retire(session: LiveSession): Promise<void> {
    this.suspending.add(session);
    try {
      await session.lifecycle.suspend();
      await this.notifyState(session.lifecycle, 'suspended');
    } finally {
      this.suspending.delete(session);
      this.wakeCapacityWaiters();
    }
  }

  /**
   * Reserve a capacity slot under the mutex, then do the blocking work outside
   * it. The reservation is a `pending` entry in `live`: it counts against both
   * budgets for the whole spawn, so a concurrent Room cannot oversubscribe, and
   * a concurrent Room's own spawn is not queued behind this one.
   */
  private async ensureLive(
    key: string,
    lifecycle: SessionLifecycle,
    priority: SessionRunPriority,
    roomKey: string,
  ): Promise<void> {
    for (;;) {
      const previousCapacity = this.capacityTail;
      let releaseCapacity!: () => void;
      const capacity = new Promise<void>((resolveCapacity) => {
        releaseCapacity = resolveCapacity;
      });
      this.capacityTail = previousCapacity.catch(() => undefined).then(() => capacity);
      await previousCapacity.catch(() => undefined);

      let waitForCapacity: Promise<void> | undefined;
      let evicted: LiveSession | undefined;
      let reservation: LiveSession | undefined;
      try {
        // The per-key FIFO in run() means a pending reservation for this key
        // can only belong to this call chain, never a concurrent one.
        if (this.live.has(key)) {
          this.busy.add(key);
          return;
        }

        const reserved = priority === 'background' && this.reserveInteractiveSlot ? 1 : 0;
        const roomLimit = Math.max(1, this.perRoomLiveSessions - reserved);
        const workspaceLimit = Math.max(1, this.workspaceCapacity() - reserved);
        const roomLive = [...this.live.values()].filter(
          (session) => session.roomKey === roomKey,
        ).length;

        // A Room over its own budget only ever evicts one of its own idle
        // sessions, so a busy Room can never evict a quiet Room's process.
        if (roomLive >= roomLimit) {
          evicted = this.claimIdleVictim((session) => session.roomKey === roomKey);
        } else if (this.occupied() >= workspaceLimit) {
          evicted = this.claimIdleVictim(() => true);
        }
        if (!evicted && (roomLive >= roomLimit || this.occupied() >= workspaceLimit)) {
          // Register before releasing the capacity lock so a completion
          // cannot race between the full-capacity check and this waiter.
          waitForCapacity = new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
        } else {
          reservation = { lifecycle, lastUsedAt: Date.now(), roomKey, pending: true };
          this.live.set(key, reservation);
          this.busy.add(key);
        }
      } finally {
        releaseCapacity();
      }

      if (!reservation) {
        await this.notifyState(lifecycle, 'waiting-for-slot');
        // A background waiter must not hold the capacity mutex while an
        // interactive Room turn can use the reserved slot.
        await waitForCapacity;
        continue;
      }

      try {
        // Both of these were previously awaited under the workspace-wide
        // mutex. AcpClient.stop() alone costs >=800ms and a cold ACP handshake
        // can cost tens of seconds.
        if (evicted) await this.retire(evicted);
        const physicalSessionId = await lifecycle.activate();
        if (this.live.get(key) !== reservation) {
          // forceSuspend/dispose retired this reservation mid-activation.
          await lifecycle.suspend().catch(() => undefined);
          throw new Error(`session ${key} was suspended while activating`);
        }
        reservation.pending = false;
        reservation.physicalSessionId = physicalSessionId;
        reservation.lastUsedAt = Date.now();
        await this.notifyState(lifecycle, 'live');
        const generations = this.physicalHistory.get(key) ?? [];
        generations.push(physicalSessionId);
        this.physicalHistory.set(key, generations);
        return;
      } catch (error) {
        if (this.live.get(key) === reservation) this.live.delete(key);
        this.busy.delete(key);
        this.wakeCapacityWaiters();
        throw error;
      }
    }
  }

  /**
   * Remove and return the least-recently-used idle candidate, under the lock.
   * It moves straight into `suspending` so the slot it still physically holds
   * keeps counting until its actual teardown resolves outside the lock.
    */
  private claimIdleVictim(match: (session: LiveSession) => boolean): LiveSession | undefined {
    const victim = [...this.live.entries()]
      .filter(([candidate, session]) => !this.busy.has(candidate) && !this.tails.has(candidate) && match(session))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (!victim) return undefined;
    this.live.delete(victim[0]);
    this.suspending.add(victim[1]);
    return victim[1];
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    for (const [key, session] of [...this.live.entries()]) {
      if (!this.busy.has(key) && !this.tails.has(key) && session.lastUsedAt <= cutoff) await this.suspend(key);
    }
  }

  private wakeCapacityWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }
  private async notifyState(lifecycle: SessionLifecycle, state: SessionProcessState): Promise<void> {
    await Promise.resolve(lifecycle.onStateChange?.(state)).catch(() => undefined);
  }
}

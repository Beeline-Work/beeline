/**
 * Idle mode for a free starter agent's Fly Machine. The helper asks the
 * server to put the Machine to sleep once no turn has run for `idleMs`; the
 * server refuses while a wake is pending. Fly suspends the whole Machine, so
 * on resume this process simply continues: the wall clock jumps while the
 * monotonic clock did not, and the helper replaces its socket at once
 * instead of waiting for heartbeat timeouts.
 *
 * Only a local timer runs here; nothing polls the server.
 */
export interface FreeAgentIdleOptions {
  idleMs: number;
  /** Turns running now across every hosted agent. */
  activeTurns: () => number;
  /** Ask the server to sleep this Machine; true when it accepted. */
  requestSleep: () => Promise<boolean>;
  /** The Machine resumed after being suspended. */
  onResume: () => void;
  tickMs?: number;
  /** A wall-clock jump beyond the tick by this much means the Machine was suspended. */
  resumeGapMs?: number;
  now?: () => number;
  monotonic?: () => number;
  log?: (line: string) => void;
}

export class FreeAgentIdle {
  readonly #now: () => number;
  readonly #monotonic: () => number;
  readonly #tickMs: number;
  readonly #resumeGapMs: number;
  #lastActivity: number;
  #lastWall: number;
  #lastMonotonic: number;
  #requesting = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: FreeAgentIdleOptions) {
    this.#now = options.now ?? Date.now;
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.#tickMs = options.tickMs ?? 1_000;
    this.#resumeGapMs = options.resumeGapMs ?? 5_000;
    this.#lastActivity = this.#now();
    this.#lastWall = this.#lastActivity;
    this.#lastMonotonic = this.#monotonic();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Anything that counts as work restarts the idle window. */
  noteActivity(): void {
    this.#lastActivity = this.#now();
  }

  /** One check; exposed for tests. Resolves once any sleep request settles. */
  async tick(): Promise<void> {
    const wall = this.#now();
    const monotonic = this.#monotonic();
    const wallElapsed = wall - this.#lastWall;
    const monotonicElapsed = monotonic - this.#lastMonotonic;
    this.#lastWall = wall;
    this.#lastMonotonic = monotonic;
    if (wallElapsed - monotonicElapsed > this.#resumeGapMs) {
      this.options.log?.(
        `resumed after ${Math.round((wallElapsed - monotonicElapsed) / 1000)}s asleep; reconnecting`,
      );
      this.#lastActivity = wall;
      this.options.onResume();
      return;
    }
    if (this.options.activeTurns() > 0) {
      this.#lastActivity = wall;
      return;
    }
    if (this.#requesting || wall - this.#lastActivity < this.options.idleMs) return;
    this.#requesting = true;
    try {
      const accepted = await this.options.requestSleep();
      this.options.log?.(accepted ? 'idle; sleep accepted' : 'idle; sleep refused, work pending');
    } catch (error) {
      this.options.log?.(`sleep request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#requesting = false;
      // Refused or failed: wait a whole idle window before asking again.
      this.#lastActivity = this.#now();
    }
  }
}

import { captureServerError } from './sentry.js';

export interface LeaderConnection {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(destroy?: boolean): void;
  on?(event: 'error' | 'end', listener: () => void): unknown;
  removeListener?(event: 'error' | 'end', listener: () => void): unknown;
}

// Same database-wide lock as the previous owner; rolling servers cannot lead together.
const BACKGROUND_LOCK_KEY = 0x0bee11;

/** One dedicated connection waits for the PostgreSQL lock. Standby never
 * probes it on a clock. Only committed wakes and actual job deadlines run
 * work; a failed connection parks until a real recovery/source boundary. */
export class BackgroundLeader {
  private stopped = false;
  private running?: Promise<void>;
  private client?: LeaderConnection;
  private acquiring = false;
  private lost = false;
  private wakePending = false;
  private replacementAllowed = true;
  private resume?: () => void;
  private stopRecovery?: () => void;
  private abortCycle?: () => void;

  constructor(private readonly database: {
    connectDedicated(): Promise<LeaderConnection>;
    onRecovery?(listener: () => void): () => void;
  }, private readonly cycle: (newLeader: boolean, signal: AbortSignal) => Promise<number | void>) {}

  run(): Promise<void> {
    if (!this.running) {
      this.stopRecovery = this.database.onRecovery?.(() => { this.replacementAllowed = true; this.wake(); });
      this.running = this.runLoop();
    }
    return this.running;
  }

  private release(): void {
    const client = this.client; this.client = undefined;
    client?.release(true);
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let client: LeaderConnection | undefined;
      const controller = new AbortController();
      const retire = () => controller.abort();
      const disconnected = () => {
        if (this.stopped || this.lost) return;
        retire();
        this.lost = true;
        // An opened replacement is not recovery. Only a completed initial
        // business cycle or an independent database recovery restores this
        // allowance. error + end on the same backend is one incident.
        if (this.replacementAllowed) {
          this.replacementAllowed = false;
          this.wake();
        } else {
          this.wakePending = false;
          this.resume?.();
        }
      };
      try {
        this.lost = false; this.acquiring = true;
        client = await this.database.connectDedicated(); this.client = client;
        this.abortCycle=retire;
        if (this.stopped) break;
        client.on?.('error', disconnected); client.on?.('end', disconnected);
        // This is a dedicated ownership wait, never a data query. Always
        // destroy the connection on release, so these settings cannot leak
        // into the app/job pools. Shutdown destroys a blocked acquisition.
        // An endless wait pins the database's cleanup horizon (dead rows piled
        // up 110x on live_streams) and blocks concurrent index builds, so the
        // standby gives up after a minute and waits again on a fresh connection.
        await client.query('SET statement_timeout=0; SET lock_timeout=60000');
        if (this.stopped || this.lost) continue;
        await client.query('SELECT pg_advisory_lock($1)', [BACKGROUND_LOCK_KEY]);
        this.acquiring = false;
        if (this.stopped || this.lost) continue;
        let initial = true;
        while (!this.stopped && !this.lost) {
          this.wakePending = false;
          const delay = await this.cycle(initial, controller.signal); initial = false;
          if (this.stopped || this.lost) break;
          this.replacementAllowed = true;
          await this.wait(typeof delay === 'number' ? delay : Infinity);
        }
      } catch (error) {
        if (!this.stopped && (error as { code?: string }).code !== '55P03') captureServerError(error);
      } finally {
        retire();if(this.abortCycle===retire)this.abortCycle=undefined;
        this.acquiring = false;
        client?.removeListener?.('error', disconnected);
        client?.removeListener?.('end', disconnected);
        this.release();
      }
      if (!this.stopped) await this.wait(Infinity);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true; this.stopRecovery?.(); this.stopRecovery = undefined;
    this.abortCycle?.();
    // An active business cycle drains before releasing its authority; a
    // blocked lock acquisition owns no business work and can be destroyed.
    if (this.acquiring) this.release();
    this.resume?.();
    await this.running;
  }

  wake(): void {
    this.wakePending = true;
    this.resume?.();
  }

  private wait(delay: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.wakePending) { this.wakePending = false; return Promise.resolve(); }
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        if (this.resume === finish) this.resume = undefined;
        resolve();
      };
      this.resume = finish;
      if (Number.isFinite(delay)) {
        // Clamp only the host timer range, not the semantic deadline. Long
        // deadlines need the remaining duration rather than an early job run.
        const end = Date.now() + Math.max(0, delay);
        const arm = () => {
          const remaining = end - Date.now();
          if (remaining <= 0) { finish(); return; }
          timer = setTimeout(arm, Math.min(remaining, 2_147_483_647)); timer.unref?.();
        };
        arm();
      }
    });
  }
}

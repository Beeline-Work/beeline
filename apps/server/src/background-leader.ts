import { captureServerError } from './sentry.js';

export interface LeaderConnection {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(destroy?: boolean): void;
  on?(event: 'error' | 'end', listener: () => void): unknown;
  removeListener?(event: 'error' | 'end', listener: () => void): unknown;
}

// Same database-wide lock as the previous owner; rolling servers cannot lead together.
const BACKGROUND_LOCK_KEY = 0x0bee11;

/** Private composition boundary, never a caller-provided ownership claim.
 * Acquisition runs only after this exact backend holds the existing lock.
 * Abort/loss is synchronous; in-flight business work drains before release. */
export interface BackgroundLeaderHooks {
  acquired(connection: LeaderConnection, signal: AbortSignal): Promise<void>;
  lost(connection: LeaderConnection): void;
}

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
  private resume?: () => void;
  private stopRecovery?: () => void;
  private retireOwner?: () => void;

  constructor(private readonly database: {
    connectDedicated(): Promise<LeaderConnection>;
    onRecovery?(listener: () => void): () => void;
  }, private readonly cycle: (newLeader: boolean) => Promise<number | void>,
  private readonly hooks?: BackgroundLeaderHooks) {}

  run(): Promise<void> {
    if (!this.running) {
      this.stopRecovery = this.database.onRecovery?.(() => this.wake());
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
      const controller = new AbortController();let owned=false,retired=false;
      const retire=()=>{
        if(retired)return;retired=true;controller.abort();
        if(owned&&client)try{this.hooks?.lost(client);}catch(error){captureServerError(error);}
      };
      const disconnected = () => {
        retire();
        this.lost = true;
        // Losing the actual owning connection permits one replacement. A
        // failed replacement has no timer and waits for another real boundary.
        this.wake();
      };
      try {
        this.lost = false; this.acquiring = true;
        client = await this.database.connectDedicated(); this.client = client;
        this.retireOwner=retire;
        if (this.stopped) break;
        client.on?.('error', disconnected); client.on?.('end', disconnected);
        // This is a dedicated ownership wait, never a data query. Always
        // destroy the connection on release, so these settings cannot leak
        // into the app/job pools. Shutdown destroys a blocked acquisition.
        await client.query('SET statement_timeout=0; SET lock_timeout=0');
        if (this.stopped || this.lost) continue;
        await client.query('SELECT pg_advisory_lock($1)', [BACKGROUND_LOCK_KEY]);
        this.acquiring = false;
        if (this.stopped || this.lost) continue;
        owned=true;
        await this.hooks?.acquired(client,controller.signal);
        if(this.stopped||this.lost||controller.signal.aborted)continue;
        let initial = true;
        while (!this.stopped && !this.lost) {
          this.wakePending = false;
          const delay = await this.cycle(initial); initial = false;
          if (this.stopped || this.lost) break;
          await this.wait(typeof delay === 'number' ? delay : Infinity);
        }
      } catch (error) {
        if (!this.stopped) captureServerError(error);
      } finally {
        retire();if(this.retireOwner===retire)this.retireOwner=undefined;
        this.acquiring = false;
        client?.removeListener?.('error', disconnected);
        client?.removeListener?.('end', disconnected);
        this.release();
      }
      if (!this.stopped) await this.wait(Infinity);
    }
  }

  /** A failed durable retirement must end this exact physical owner after
   * its active business cycle drains. This is parking, not transport loss:
   * it grants no replacement attempt and discards prior queued wakes. */
  parkOwner(connection: LeaderConnection): void {
    if (this.stopped || connection !== this.client) return;
    this.lost = true;
    this.wakePending = false;
    this.retireOwner?.();
    this.resume?.();
  }

  async stop(): Promise<void> {
    this.stopped = true; this.stopRecovery?.(); this.stopRecovery = undefined;
    this.retireOwner?.();
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

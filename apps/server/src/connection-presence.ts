import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

export const PRESENCE_REFRESH_MS = 30_000;
export const PRESENCE_DISCONNECT_DEBOUNCE_MS = 5_000;

interface PresenceMetadata {
  releaseVersion?: string;
  sourceSha?: string;
  available?: boolean;
}

interface Claim extends PresenceMetadata {
  roomId: string;
  agentId: string;
  connections: number;
  offlineTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Presence is a property of an authenticated live connection. The durable row
 * records transitions and the owning server epoch; refreshes are ephemeral
 * NOTIFY messages, so an idle connected daemon never writes the database.
 */
export class ConnectionPresence {
  readonly epoch = randomUUID();
  readonly #claims = new Map<string, Claim>();
  readonly #refresh: ReturnType<typeof setInterval>;

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly refreshMs = PRESENCE_REFRESH_MS,
    private readonly disconnectDebounceMs = PRESENCE_DISCONNECT_DEBOUNCE_MS,
  ) {
    this.#refresh = setInterval(() => void this.refresh().catch(this.report), this.refreshMs);
    this.#refresh.unref?.();
  }

  connect(roomId: string, agentId: string, metadata: PresenceMetadata = {}): () => void {
    const key = `${roomId}\0${agentId}`;
    let claim = this.#claims.get(key);
    if (claim) {
      claim.connections += 1;
      clearTimeout(claim.offlineTimer);
      claim.offlineTimer = undefined;
    } else {
      claim = { roomId, agentId, connections: 1, ...metadata };
      this.#claims.set(key, claim);
      void this.persist(claim, metadata.available === false ? 'offline' : 'online').catch(
        this.report,
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#claims.get(key);
      if (!current || --current.connections > 0) return;
      current.offlineTimer = setTimeout(() => {
        if (current.connections > 0 || this.#claims.get(key) !== current) return;
        this.#claims.delete(key);
        void this.persistOffline(current).catch(this.report);
      }, this.disconnectDebounceMs);
      current.offlineTimer.unref?.();
    };
  }

  async stop(): Promise<void> {
    clearInterval(this.#refresh);
    const claims = [...this.#claims.values()];
    this.#claims.clear();
    for (const claim of claims) clearTimeout(claim.offlineTimer);
  }

  private readonly report = (error: unknown) =>
    console.error(
      '[presence] connection transition failed',
      error instanceof Error ? error.message : String(error),
    );

  private async persist(claim: Claim, status: 'online' | 'offline'): Promise<void> {
    const observedAt = Math.floor(Date.now() / 1000);
    await this.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence',$3::jsonb)
       ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE
       SET body=EXCLUDED.body,updated_at=now()`,
      [
        claim.roomId,
        claim.agentId,
        JSON.stringify({
          status,
          observedAt,
          ownerEpoch: this.epoch,
          expiresAt: observedAt + Math.ceil((this.refreshMs * 3) / 1_000),
          ...(claim.releaseVersion ? { releaseVersion: claim.releaseVersion } : {}),
          ...(claim.sourceSha ? { sourceSha: claim.sourceSha } : {}),
        }),
      ],
    );
    this.live.publish({
      type: 'presence', roomId: claim.roomId, agentId: claim.agentId, status, observedAt,
      ownerEpoch: this.epoch,
      expiresAt: observedAt + Math.ceil((this.refreshMs * 3) / 1_000),
    });
  }

  private async persistOffline(claim: Claim): Promise<void> {
    const observedAt = Math.floor(Date.now() / 1000);
    const changed = await this.database.query(
      `UPDATE live_outputs
       SET body=body||$3::jsonb,updated_at=now()
       WHERE room_id=$1 AND agent_id=$2 AND turn_id='presence' AND kind='presence'
         AND body->>'ownerEpoch'=$4 AND body->>'status'='online'`,
      [claim.roomId, claim.agentId, JSON.stringify({ status: 'offline', observedAt }), this.epoch],
    );
    if (!changed.rowCount) return;
    this.live.publish({
      type: 'presence',
      roomId: claim.roomId,
      agentId: claim.agentId,
      status: 'offline',
      observedAt,
      ownerEpoch: this.epoch,
      expiresAt: observedAt,
    });
  }

  private async refresh(): Promise<void> {
    const observedAt = Math.floor(Date.now() / 1000);
    const claims = [...this.#claims.values()].filter(
      (claim) => claim.connections > 0 && claim.available !== false,
    );
    if (!claims.length) return;
    for (const claim of claims) {
      this.live.publish({
        type: 'presence',
        roomId: claim.roomId,
        agentId: claim.agentId,
        status: 'online',
        observedAt,
        ownerEpoch: this.epoch,
        expiresAt: observedAt + Math.ceil((this.refreshMs * 3) / 1_000),
      });
    }
    await this.database.query(
      `SELECT pg_notify($1,jsonb_build_object(
         'table','connection_presence','operation','REFRESH',
         'roomId',claim->>'roomId','agentId',claim->>'agentId',
         'ownerEpoch',$2,'observedAt',$3::bigint,
         'expiresAt',$3::bigint+$5::bigint
       )::text)
       FROM jsonb_array_elements($4::jsonb) claim`,
      [
        POSTGRES_LIVE_CHANNEL,
        this.epoch,
        observedAt,
        JSON.stringify(claims.map(({ roomId, agentId }) => ({ roomId, agentId }))),
        Math.ceil((this.refreshMs * 3) / 1_000),
      ],
    );
  }
}

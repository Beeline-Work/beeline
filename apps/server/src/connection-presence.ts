import { randomUUID } from 'node:crypto';
import { isServerEventKind } from '@beeline/api-contract/phone';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';

export const DELIVERY_PICKUP_WINDOW_MS = 90_000;

interface PresenceMetadata {
  releaseVersion?: string;
  sourceSha?: string;
  available?: boolean;
  lifecycleId?: string;
}
interface Delivery {
  room_id: string;
  agent_id: string;
  message_id: string;
  created_at: Date;
  lifecycle: string | null;
  author_id: string;
  author_kind: string;
  access_policy: unknown;
  owner_id: string | null;
  system_kind: string | null;
}

/** Online is a durable lifecycle announcement, revoked only by failed delivery.
 * Socket ownership and elapsed idle time say nothing about delivery capability.
 */
export class ConnectionPresence {
  readonly epoch = randomUUID();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #release: () => void;
  readonly #releaseResync: () => void;
  #stopped = false;

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly pickupWindowMs = DELIVERY_PICKUP_WINDOW_MS,
  ) {
    this.#releaseResync = live.subscribeResync(() => void this.observe().catch(this.report));
    this.#release = live.subscribeAll((event) => {
      if (
        event.type === 'invalidate' &&
        ['phone-write', 'message', 'postgres:messages'].includes(event.reason)
      ) {
        void this.observe(event.roomId).catch(this.report);
      }
    });
  }

  /** One recovery read on server startup; pending deadlines come from messages,
   * not a poll or a separately written delivery ledger. */
  async start(): Promise<void> {
    await this.observe();
  }

  connect(roomId: string, agentId: string, metadata: PresenceMetadata = {}): () => void {
    void this.announce(roomId, agentId, metadata).catch(this.report);
    return () => {}; // Losing a socket is not a failed delivery.
  }

  async announce(roomId: string, agentId: string, metadata: PresenceMetadata = {}): Promise<void> {
    await announceAgentLifecycle(this.database, this.live, roomId, agentId, {
      ...metadata,
      lifecycleId: metadata.lifecycleId ?? this.epoch,
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#release();
    this.#releaseResync();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  private readonly report = (error: unknown) =>
    console.error(
      '[presence] delivery transition failed',
      error instanceof Error ? error.message : String(error),
    );

  async observe(roomId?: string): Promise<void> {
    if (this.#stopped) return;
    const deliveries = await this.database.query<Delivery>(
      `SELECT m.room_id,m.id message_id,m.created_at,m.author_id,author.kind author_kind,
         a.agent_id,a.access_policy,a.owner_id,p.body->>'lifecycleId' lifecycle,m.system_event->>'kind' system_kind
       FROM messages m
       JOIN identities author ON author.id=m.author_id
       JOIN memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL
       JOIN agents a ON a.agent_id=member.identity_id
       JOIN rooms r ON r.id=m.room_id AND r.archived_at IS NULL
       JOIN LATERAL(SELECT body,updated_at FROM live_outputs
         WHERE agent_id=a.agent_id AND kind='presence' ORDER BY updated_at DESC LIMIT 1) p ON true
       WHERE ($1::uuid IS NULL OR m.room_id=$1)
         AND m.mention_ids @> jsonb_build_array(a.agent_id) AND m.author_id<>a.agent_id
         AND p.body->>'status'='online' AND m.created_at>=p.updated_at
         AND NOT EXISTS(SELECT 1 FROM agent_turns t WHERE t.agent_id=a.agent_id AND t.room_id=m.room_id
           AND (t.request_id=m.id OR t.created_at>=m.created_at))`,
      [roomId ?? null],
    );
    for (const delivery of deliveries.rows) {
      if (
        delivery.author_kind === 'human' &&
        !isServerEventKind(delivery.system_kind) &&
        !senderMayAddressAgent(
          parseAgentAccessPolicy(delivery.access_policy),
          delivery.author_id,
          delivery.owner_id ?? undefined,
        )
      )
        continue;
      const key = `${delivery.agent_id}:${delivery.message_id}`;
      if (this.#stopped || this.#timers.has(key)) continue;
      const remaining = delivery.created_at.getTime() + this.pickupWindowMs - Date.now();
      const timer = setTimeout(
        () => {
          void this.failDelivery(delivery)
            .catch(this.report)
            .finally(() => this.#timers.delete(key));
        },
        Math.max(0, remaining),
      );
      timer.unref?.();
      this.#timers.set(key, timer);
    }
  }

  private async failDelivery(delivery: Delivery): Promise<void> {
    if (this.#stopped) return;
    const authority = (
      await this.database.query<{
        access_policy: unknown;
        owner_id: string;
        author_member: boolean;
      }>(
        `SELECT a.access_policy,a.owner_id,EXISTS(SELECT 1 FROM memberships
         WHERE identity_id=$3 AND room_id=$2 AND removed_at IS NULL) author_member
       FROM agents a JOIN rooms r ON r.id=$2 AND r.archived_at IS NULL
       WHERE a.agent_id=$1`,
        [delivery.agent_id, delivery.room_id, delivery.author_id],
      )
    ).rows[0];
    if (!authority) return;
    if (
      !isServerEventKind(delivery.system_kind) &&
      (!authority.author_member ||
        (delivery.author_kind === 'human' &&
          !senderMayAddressAgent(
            parseAgentAccessPolicy(authority.access_policy),
            delivery.author_id,
            authority.owner_id,
          )))
    )
      return;
    const changed = await this.database.query(
      `UPDATE live_outputs p SET body=p.body || jsonb_build_object(
         'status','offline','observedAt',GREATEST($4::bigint,(p.body->>'observedAt')::bigint+1)),updated_at=now()
       WHERE p.agent_id=$1 AND p.kind='presence' AND p.body->>'status'='online'
         AND (p.body->>'lifecycleId') IS NOT DISTINCT FROM $2::text
         AND EXISTS(SELECT 1 FROM memberships WHERE identity_id=$1 AND room_id=$5 AND removed_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM agent_turns t WHERE t.agent_id=$1 AND t.room_id=$5
           AND (t.request_id=$3 OR t.created_at >= $6::timestamptz))`,
      [
        delivery.agent_id,
        delivery.lifecycle,
        delivery.message_id,
        Math.floor(Date.now() / 1000),
        delivery.room_id,
        delivery.created_at,
      ],
    );
    if (changed.rowCount) await broadcastAgentPresence(this.database, this.live, delivery.agent_id);
  }
}

export async function announceAgentLifecycle(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string,
  agentId: string,
  metadata: PresenceMetadata,
): Promise<void> {
  const lifecycle = metadata.lifecycleId ?? randomUUID();
  const changed = await database.transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`presence:${agentId}`]);
    const previous = (
      await db.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'
         ORDER BY updated_at DESC LIMIT 1`,
        [agentId],
      )
    ).rows[0]?.body;
    // Re-subscription, including after a server deploy, cannot revive a failed
    // lifecycle. Only a new daemon instance may clear sticky offline.
    if (previous?.lifecycleId === lifecycle) return false;
    const observedAt = Math.max(
      Math.floor(Date.now() / 1000),
      Number(previous?.observedAt ?? 0) + 1,
    );
    const body = {
      status: metadata.available === false ? 'offline' : 'online',
      observedAt,
      lifecycleId: lifecycle,
      ...(metadata.releaseVersion ? { releaseVersion: metadata.releaseVersion } : {}),
      ...(metadata.sourceSha ? { sourceSha: metadata.sourceSha } : {}),
    };
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
         VALUES($1,$2,'presence','presence',$3::jsonb)
         ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [roomId, agentId, JSON.stringify(body)],
    );
    // All viewers, including other Rooms and corners, share the agent fact.
    await db.query(
      `UPDATE live_outputs SET body=$2::jsonb,updated_at=now()
         WHERE agent_id=$1 AND kind='presence' AND body IS DISTINCT FROM $2::jsonb`,
      [agentId, JSON.stringify(body)],
    );
    return true;
  });
  if (changed) await broadcastAgentPresence(database, live, agentId);
}

async function broadcastAgentPresence(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
): Promise<void> {
  const result = await database.query<{
    room_id: string;
    body: { status: 'online' | 'offline'; observedAt: number };
  }>(
    `SELECT m.room_id,p.body FROM memberships m
        JOIN LATERAL(SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'
          ORDER BY updated_at DESC LIMIT 1)p ON true
        WHERE m.identity_id=$1 AND m.room_id IS NOT NULL AND m.removed_at IS NULL`,
    [agentId],
  );
  for (const row of result.rows)
    live.publish({
      type: 'presence',
      roomId: row.room_id,
      agentId,
      status: row.body.status,
      observedAt: row.body.observedAt,
    });
}

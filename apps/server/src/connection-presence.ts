import { isServerEventKind } from '@beeline/api-contract/phone';
import { randomUUID } from 'node:crypto';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import type { CommittedTurnLiveRow, LiveHub } from './live.js';
import { tagsKnownIdentitySql } from './message-mentions.js';
import { noteFirstSilence } from './turn-silence-notice.js';

export const DELIVERY_PICKUP_WINDOW_MS = 90_000;
export const PRESENCE_OBSERVE_DEBOUNCE_MS = 25;

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
  evidence_token: string;
  author_id: string;
  author_kind: string;
  access_policy: unknown;
  owner_id: string | null;
  system_kind: string | null;
}

/** Presence is the helper's newest authenticated evidence. Mention deadlines may
 * demote only the exact evidence version they observed when they were armed.
 */
export class ConnectionPresence {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #evidence = new Map<
    string,
    { roomId: string | undefined; pending: boolean; worker: Promise<void> }
  >();
  readonly #authenticatedAt = new Map<string, number>();
  /** Last helper-process announce; a newer value than the stalled receipt means systemd already revived it. */
  readonly #announcedAt = new Map<string, number>();
  readonly #observePending = new Set<string | undefined>();
  readonly #observeDebounces = new Map<string, ReturnType<typeof setTimeout>>();
  #observeWorker: Promise<void> | undefined;
  readonly #release: () => void;
  readonly #releaseResync: () => void;
  #stopped = false;

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly pickupWindowMs = DELIVERY_PICKUP_WINDOW_MS,
  ) {
    this.#releaseResync = live.subscribeResync(() => {
      void this.recoverWorkingStalls().catch(this.report);
      this.scheduleObserve();
    });
    this.#release = live.subscribeAll((event) => {
      if (
        event.type === 'invalidate' &&
        ['phone-write', 'message', 'postgres:messages'].includes(event.reason)
      ) {
        this.scheduleObserve(event.roomId);
      }
      if (event.type === 'invalidate' && event.committedRow?.type === 'turn') {
        try {
          this.watchTurn(event.committedRow.row);
        } catch (error) {
          this.report(error);
        }
      } else if (
        event.type === 'invalidate' &&
        event.reason === 'postgres:agent_turns' &&
        event.requestId &&
        event.agentId
      ) {
        void this.watchTurnFromStore(event.roomId, event.requestId, event.agentId).catch(
          this.report,
        );
      }
    });
  }

  /** One recovery read on server startup; pending deadlines come from messages,
   * not a poll or a separately written delivery ledger. */
  async start(): Promise<void> {
    await this.recoverWorkingStalls();
    await this.observe();
  }

  async announce(roomId: string, agentId: string, metadata: PresenceMetadata = {}): Promise<void> {
    const lifecycleId = metadata.lifecycleId;
    if (!lifecycleId) return;
    if (this.#stopped) return;
    this.#announcedAt.set(agentId, Date.now());
    await announceAgentLifecycle(this.database, this.live, roomId, agentId, {
      ...metadata,
      lifecycleId,
    });
  }

  /** Record a request accepted under this agent's daemon credential. */
  evidence(roomId: string | undefined, agentId: string): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    // Authentication itself is delivery evidence. Record it synchronously so
    // a deadline cannot demote the agent while its coalesced durable refresh
    // is waiting for the database.
    this.#authenticatedAt.set(agentId, Date.now());
    const active = this.#evidence.get(agentId);
    if (active) {
      active.roomId = roomId ?? active.roomId;
      active.pending = true;
      return active.worker;
    }
    const state = { roomId, pending: true, worker: Promise.resolve() };
    state.worker = (async () => {
      while (state.pending && !this.#stopped) {
        state.pending = false;
        await recordAgentEvidence(this.database, this.live, state.roomId, agentId).catch(
          this.report,
        );
      }
    })().finally(() => {
      if (this.#evidence.get(agentId) === state) this.#evidence.delete(agentId);
    });
    this.#evidence.set(agentId, state);
    return state.worker;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#release();
    this.#releaseResync();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    for (const timer of this.#observeDebounces.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#observeDebounces.clear();
    this.#observePending.clear();
    this.#authenticatedAt.clear();
    this.#announcedAt.clear();
    this.#evidence.clear();
  }

  private readonly report = (error: unknown) =>
    console.error(
      '[presence] delivery transition failed',
      error instanceof Error ? error.message : String(error),
    );

  async observe(roomId?: string): Promise<void> {
    if (this.#stopped) return;
    this.#observePending.add(roomId);
    if (this.#observeWorker) return this.#observeWorker;
    const worker = (async () => {
      while (!this.#stopped && this.#observePending.size) {
        let nextRoomId: string | undefined;
        if (this.#observePending.has(undefined)) {
          // A full resync includes every pending Room-specific observation.
          this.#observePending.clear();
        } else {
          nextRoomId = this.#observePending.values().next().value;
          this.#observePending.delete(nextRoomId);
        }
        await this.observeOnce(nextRoomId);
      }
    })().finally(() => {
      if (this.#observeWorker === worker) this.#observeWorker = undefined;
    });
    this.#observeWorker = worker;
    return worker;
  }

  private scheduleObserve(roomId?: string): void {
    if (this.#stopped) return;
    const key = roomId ?? '*';
    if (this.#observeDebounces.has(key)) return;
    const timer = setTimeout(() => {
      this.#observeDebounces.delete(key);
      void this.observe(roomId).catch(this.report);
    }, PRESENCE_OBSERVE_DEBOUNCE_MS);
    timer.unref?.();
    this.#observeDebounces.set(key, timer);
  }

  private async observeOnce(roomId?: string): Promise<void> {
    // Resolve tags only after evidence/receipt bounds discard history. Inlining
    // the roster subquery into the broad join can occupy every pool connection
    // for minutes, starving phone authentication and even the next migration.
    const deliveries = await this.database.query<Delivery>(
      `WITH candidates AS MATERIALIZED (
       SELECT member.room_id,m.id message_id,m.created_at,m.author_id,m.author_kind,
         m.text,m.presentation,m.request_id,
         a.agent_id,a.access_policy,a.owner_id,target.handle agent_handle,
         p.body->>'lifecycleId' lifecycle,
         COALESCE(p.body->>'evidenceNonce',p.body->>'lifecycleId',p.body->>'observedAt') evidence_token,
         m.system_event->>'kind' system_kind
       FROM memberships member
       JOIN agents a ON a.agent_id=member.identity_id
       JOIN identities target ON target.id=a.agent_id
       JOIN rooms r ON r.id=member.room_id AND r.archived_at IS NULL
       JOIN LATERAL(SELECT body,updated_at FROM live_outputs
         WHERE agent_id=a.agent_id AND kind='presence' ORDER BY updated_at DESC LIMIT 1) p ON true
       JOIN LATERAL(
         SELECT message.*,author.kind author_kind
         FROM messages message JOIN identities author ON author.id=message.author_id
         WHERE message.room_id=member.room_id AND message.created_at>=p.updated_at
           AND message.author_id<>a.agent_id
           AND NOT EXISTS(SELECT 1 FROM agent_turns t
             WHERE t.agent_id=a.agent_id AND t.room_id=message.room_id
               AND (t.request_id=message.id OR t.created_at>=message.created_at))
         OFFSET 0
       ) m ON true
       WHERE member.removed_at IS NULL AND member.room_id IS NOT NULL
         AND ($1::uuid IS NULL OR member.room_id=$1)
         AND p.body->>'status'='online'
       ) SELECT m.* FROM candidates m
       WHERE ${tagsKnownIdentitySql('m', 'm.agent_id', 'm.agent_handle', "'agent'")}`,
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
    if ((this.#authenticatedAt.get(delivery.agent_id) ?? 0) >= delivery.created_at.getTime())
      return;
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
         'status','offline','observedAt',GREATEST($4::bigint,(p.body->>'observedAt')::bigint+1)),updated_at=clock_timestamp()
       WHERE p.agent_id=$1 AND p.kind='presence' AND p.body->>'status'='online'
         AND (p.room_id,p.agent_id,p.turn_id,p.kind)=(
           SELECT room_id,agent_id,turn_id,kind FROM live_outputs
           WHERE agent_id=$1 AND kind='presence' ORDER BY updated_at DESC LIMIT 1
         )
         AND (p.body->>'lifecycleId') IS NOT DISTINCT FROM $2::text
         AND COALESCE(p.body->>'evidenceNonce',p.body->>'lifecycleId',p.body->>'observedAt')=$7
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
        delivery.evidence_token,
      ],
    );
    if (changed.rowCount) {
      await broadcastAgentPresence(this.database, this.live, delivery.agent_id);
    }
    // Presence is one canonical row; the unanswered-delivery fact is per request
    // and per Room. Losing the demotion race must not skip the Room line.
    const unanswered = await this.database.query(
      `SELECT 1 FROM memberships member
       WHERE member.identity_id=$1 AND member.room_id=$2 AND member.removed_at IS NULL
         AND NOT EXISTS(
           SELECT 1 FROM agent_turns turn
           WHERE turn.agent_id=$1 AND turn.room_id=$2
             AND (turn.request_id=$3 OR turn.created_at>=$4::timestamptz)
         )`,
      [delivery.agent_id, delivery.room_id, delivery.message_id, delivery.created_at],
    );
    if (!unanswered.rowCount) return;
    await noteFirstSilence(this.database, this.live, {
      roomId: delivery.room_id,
      requestId: delivery.message_id,
      agentId: delivery.agent_id,
      reason: "her helper isn't running",
      reasonKind: 'offline',
      liveRestart: true,
    }).catch(this.report);
  }

  private turnTimerKey(roomId: string, requestId: string, agentId: string): string {
    return `turn:${agentId}:${roomId}:${requestId}`;
  }

  private async recoverWorkingStalls(): Promise<void> {
    if (this.#stopped) return;
    const turns = await this.database.query<CommittedTurnLiveRow>(
      `SELECT room_id,request_id,agent_id,status,started_at,created_at,generation_id,NULL::text requested_by
       FROM agent_turns WHERE status='working' AND created_at>now()-interval '24 hours'`,
    );
    for (const turn of turns.rows) this.watchTurn(turn);
  }

  private async watchTurnFromStore(
    roomId: string,
    requestId: string,
    agentId: string,
  ): Promise<void> {
    if (this.#stopped) return;
    const turn = (
      await this.database.query<CommittedTurnLiveRow>(
        `SELECT room_id,request_id,agent_id,status,started_at,created_at,generation_id,NULL::text requested_by
         FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [roomId, requestId, agentId],
      )
    ).rows[0];
    if (turn) this.watchTurn(turn);
    else this.clearTurnTimer(roomId, requestId, agentId);
  }

  private watchTurn(turn: CommittedTurnLiveRow): void {
    const createdAt = new Date(turn.created_at);
    const key = this.turnTimerKey(turn.room_id, turn.request_id, turn.agent_id);
    const previous = this.#timers.get(key);
    if (previous) clearTimeout(previous);
    if (this.#stopped || turn.status !== 'working') {
      this.#timers.delete(key);
      return;
    }
    const remaining = createdAt.getTime() + this.pickupWindowMs - Date.now();
    const timer = setTimeout(
      () => {
        void this.failStalledTurn({ ...turn, created_at: createdAt })
          .catch(this.report)
          .finally(() => this.#timers.delete(key));
      },
      Math.max(0, remaining),
    );
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  private clearTurnTimer(roomId: string, requestId: string, agentId: string): void {
    const key = this.turnTimerKey(roomId, requestId, agentId);
    const timer = this.#timers.get(key);
    if (timer) clearTimeout(timer);
    this.#timers.delete(key);
  }

  private async failStalledTurn(turn: CommittedTurnLiveRow): Promise<void> {
    if (this.#stopped) return;
    const current = (
      await this.database.query<{
        status: string;
        created_at: Date;
        generation_id: string | null;
      }>(
        `SELECT status,created_at,generation_id FROM agent_turns
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [turn.room_id, turn.request_id, turn.agent_id],
      )
    ).rows[0];
    if (
      !current ||
      current.status !== 'working' ||
      current.generation_id !== turn.generation_id
    )
      return;
    if (current.created_at.getTime() + this.pickupWindowMs > Date.now()) {
      this.watchTurn({
        ...turn,
        status: 'working',
        created_at: current.created_at,
        generation_id: current.generation_id,
      });
      return;
    }
    const announcedAt = this.#announcedAt.get(turn.agent_id) ?? 0;
    await noteFirstSilence(this.database, this.live, {
      roomId: turn.room_id,
      requestId: turn.request_id,
      agentId: turn.agent_id,
      generationId: current.generation_id,
      reason: 'the turn stalled',
      reasonKind: 'hiccup',
      liveRestart: true,
      helperAlreadyRestarted: announcedAt > current.created_at.getTime(),
    });
  }
}

export async function announceAgentLifecycle(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string,
  agentId: string,
  metadata: PresenceMetadata & { lifecycleId: string },
): Promise<void> {
  const lifecycle = metadata.lifecycleId;
  const changed = await database.transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`presence:${agentId}`]);
    const previous = (
      await db.query<{ room_id: string; body: Record<string, unknown> }>(
        `SELECT room_id,body FROM live_outputs WHERE agent_id=$1 AND kind='presence'
         ORDER BY updated_at DESC LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    const observedAt = Math.max(
      Math.floor(Date.now() / 1000),
      Number(previous?.body.observedAt ?? 0) + 1,
    );
    const body = {
      status: metadata.available === false ? 'offline' : 'online',
      observedAt,
      evidenceNonce: randomUUID(),
      lifecycleId: lifecycle,
      ...(metadata.releaseVersion ? { releaseVersion: metadata.releaseVersion } : {}),
      ...(metadata.sourceSha ? { sourceSha: metadata.sourceSha } : {}),
    };
    if (previous)
      await db.query(
        `UPDATE live_outputs SET body=$3::jsonb,updated_at=clock_timestamp()
         WHERE room_id=$1 AND agent_id=$2 AND turn_id='presence' AND kind='presence'`,
        [previous.room_id, agentId, JSON.stringify(body)],
      );
    else
      await db.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
         VALUES($1,$2,'presence','presence',$3::jsonb,clock_timestamp())
         ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET
           body=EXCLUDED.body,updated_at=EXCLUDED.updated_at`,
        [roomId, agentId, JSON.stringify(body)],
      );
    // Presence is an agent fact. Change one durable row; the PostgreSQL
    // listener expands its one notification across current Room memberships.
    return true;
  });
  if (changed) await broadcastAgentPresence(database, live, agentId);
}

export async function recordAgentEvidence(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string | undefined,
  agentId: string,
): Promise<void> {
  const changed = await database.query(
    `WITH previous AS MATERIALIZED (
       SELECT output.room_id,output.body FROM live_outputs output
       WHERE output.agent_id=$1 AND output.kind='presence'
       ORDER BY output.updated_at DESC LIMIT 1
     ), target AS MATERIALIZED (
       SELECT membership.room_id,previous.room_id previous_room,previous.body
       FROM (SELECT 1) singleton LEFT JOIN previous ON true
       JOIN memberships membership
         ON membership.room_id=COALESCE($2::uuid,previous.room_id)
        AND membership.identity_id=$1 AND membership.removed_at IS NULL
     ), written AS (
       INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       SELECT COALESCE(previous_room,room_id),$1,'presence','presence',
         COALESCE(body,'{}'::jsonb) || jsonb_build_object(
           'status','online',
           'observedAt',CASE WHEN body->>'status'='offline'
             THEN GREATEST($3::bigint,COALESCE((body->>'observedAt')::bigint,0)+1)
             ELSE $3::bigint END,
           'evidenceNonce',$4::text
         ),clock_timestamp()
       FROM target
       ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET
         body=live_outputs.body || jsonb_build_object(
           'status','online',
           'observedAt',CASE WHEN live_outputs.body->>'status'='offline'
             THEN GREATEST($3::bigint,COALESCE((live_outputs.body->>'observedAt')::bigint,0)+1)
             ELSE $3::bigint END,
           'evidenceNonce',$4::text
         ),updated_at=EXCLUDED.updated_at
       RETURNING 1
     ) SELECT 1 FROM written`,
    [agentId, roomId ?? null, Math.floor(Date.now() / 1000), randomUUID()],
  );
  // One canonical presence row produces one PostgreSQL notification. Local
  // subscribers still receive the same membership-authorized projection.
  if (changed.rowCount) await broadcastAgentPresence(database, live, agentId);
}

async function broadcastAgentPresence(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
): Promise<void> {
  // Production arms listener-owned fanout so the NOTIFY path alone expands one
  // durable row across memberships. A second writer-local query would duplicate
  // that work on every evidence write.
  if (live.listenerOwnsPresenceFanout()) return;
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

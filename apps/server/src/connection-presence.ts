import { commandOwnerExpiredSql } from './turn-ownership.js';
import { endAgentTurn } from './agent-turn-end.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { lockAgentMachine } from './machine-offline.js';
import { freeAgentReachableSql } from './free-agents.js';
import { systemLine } from './system-line.js';
import { notifyAgentConnection } from './postgres-live.js';

export const DELIVERY_PICKUP_WINDOW_MS = 90_000;
/** A server that has not renewed for this long is gone; its connections are released. */
export const SERVER_LEASE_EXPIRY_MS = 90_000;

interface PresenceMetadata {
  releaseVersion?: string;
  sourceSha?: string;
  available?: boolean;
  lifecycleId?: string;
  turnRuntimeId?: string;
}

/** One live helper connection for one agent, held by one server instance. */
interface HeldConnection {
  connectionId: string;
  instanceId: string;
}
/** Presence changes with authenticated traffic and connection lifecycle events. */
export class ConnectionPresence {
  readonly instanceId: string;
  private stopped = false;
  private leaseWrite?: Promise<void>;
  private readonly release: () => void;
  private readonly evidenceWrites = new Map<string, Promise<void>>();
  private readonly ownerChecks = new Map<string, Promise<void>>();
  constructor(private readonly database: SqlDatabase, private readonly live: LiveHub,
    lease: { instanceId?: string } = {}) {
    this.instanceId = lease.instanceId ?? randomUUID();
    this.release = live.subscribeAll(event => {
      if (event.type === 'agent-connection') this.checkOwnedAgent(event.agentId);
    });
  }
  async start(): Promise<void> { await this.renewLease(); }
  holdServerConnection(): () => void {
    void this.renewLease().catch(this.report);
    return () => {};
  }
  async renewLease(): Promise<void> {
    if (this.stopped) return;
    if (this.leaseWrite) return this.leaseWrite;
    const work = this.database.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES($1,clock_timestamp())
      ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at`, [this.instanceId])
      .then(() => {});
    this.leaseWrite = work;
    try { await work; } finally { this.leaseWrite = undefined; }
  }
  async claimConnection(agentId: string, metadata: PresenceMetadata & { connectionId: string }): Promise<number> {
    if (this.stopped) throw new Error('connection presence stopped');
    await this.renewLease();
    const { connectionId, ...presence } = metadata;
    return claimAgentConnection(this.database, this.live, agentId, presence, { connectionId, instanceId: this.instanceId });
  }
  async releaseConnection(agentId: string, connectionId: string, forUpdate = false): Promise<void> {
    if (this.stopped) return;
    await releaseAgentConnection(this.database, this.live, agentId, connectionId, forUpdate);
  }
  async announce(roomId: string, agentId: string, metadata: PresenceMetadata = {}): Promise<void> {
    if (!this.stopped && metadata.lifecycleId)
      await announceAgentLifecycle(this.database, this.live, roomId, agentId, { ...metadata, lifecycleId: metadata.lifecycleId });
  }
  async evidence(roomId: string | undefined, agentId: string): Promise<void> {
    if (this.stopped) return;
    await this.renewLease();
    const running = this.evidenceWrites.get(agentId);
    if (running) return running;
    const work = recordAgentEvidence(this.database, this.live, roomId, agentId);
    this.evidenceWrites.set(agentId, work);
    try { await work; } finally { this.evidenceWrites.delete(agentId); }
  }
  private checkOwnedAgent(agentId: string): void {
    if (this.stopped || this.ownerChecks.has(agentId)) return;
    const work = expireOwnedAgentTurns(this.database, this.live, agentId).then(() => {}, this.report)
      .finally(() => this.ownerChecks.delete(agentId));
    this.ownerChecks.set(agentId, work);
  }
  private readonly report = (error: unknown) => console.error('[presence] connection transition failed', error);
  async stop(): Promise<void> {
    this.stopped = true; this.release();
    await Promise.all([this.leaseWrite, ...this.evidenceWrites.values(), ...this.ownerChecks.values()]);
  }
}

export async function announceAgentLifecycle(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string,
  agentId: string,
  metadata: PresenceMetadata & { lifecycleId: string },
): Promise<void> {
  const announcement = await database.transaction((db) =>
    writeAgentAnnouncement(db, roomId, agentId, metadata),
  );
  await finishAgentAnnouncement(database, agentId, metadata, announcement);
  if (announcement.changed) await broadcastAgentPresence(database, live, agentId);
}

/**
 * Record a newly accepted helper connection and hold the agent's presence
 * online for as long as it lives. The epoch only grows, so whichever instance
 * accepted the newest connection wins, and every other instance drops its own.
 */
export async function claimAgentConnection(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
  metadata: PresenceMetadata,
  connection: HeldConnection,
): Promise<number> {
  const claimedConnection = await database.transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`presence:${agentId}`]);
    await lockAgentMachine(db, agentId);
    const claimed = await db.query<{ epoch: string | number }>(
      `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id,connected_at,released_at,turn_connection_id,turn_connection_epoch,turn_transport_id)
       VALUES($1,1,$2,$3,clock_timestamp(),NULL,$4,CASE WHEN $4::text IS NOT NULL THEN 1 END,$2)
       ON CONFLICT(agent_id) DO UPDATE SET epoch=agent_connections.epoch+1,
         connection_id=EXCLUDED.connection_id,instance_id=EXCLUDED.instance_id,
         connected_at=EXCLUDED.connected_at,released_at=NULL,
         turn_connection_id=EXCLUDED.turn_connection_id,turn_transport_id=EXCLUDED.turn_transport_id,
         turn_connection_epoch=CASE WHEN EXCLUDED.turn_connection_id IS NULL THEN NULL
           WHEN agent_connections.turn_connection_id=EXCLUDED.turn_connection_id THEN agent_connections.turn_connection_epoch
           ELSE agent_connections.epoch+1 END
       RETURNING epoch`,
      [agentId, connection.connectionId, connection.instanceId, metadata.turnRuntimeId ?? null],
    );
    // Pre-upgrade helpers claimed without a connection source. This registration
    // supersedes those claims once; MCP calls/orders retain their own leases.
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,
      lease_expires_at=NULL,claimed_at=NULL,turn_owner_epoch=NULL
      WHERE agent_id=$1 AND state='claimed' AND turn_owner_connection_id IS NULL
        AND reason<>'mcp_call' AND COALESCE(generation_id,'') NOT LIKE 'mcp:%'`,[agentId]);
    const announcement = await writeAgentAnnouncement(db, undefined, agentId, metadata, connection, true);
    // A free agent's Machine is serving again; the wake latency ends here.
    const freeAgent = await db.query<{ previous: string }>(
      `WITH old AS (SELECT agent_id,state FROM free_agents WHERE agent_id=$1 FOR UPDATE)
       UPDATE free_agents f SET state='running',updated_at=now()
       FROM old WHERE f.agent_id=old.agent_id AND f.removed_at IS NULL AND f.state NOT IN ('failed','destroyed')
       RETURNING old.state previous`,
      [agentId],
    );
    if (freeAgent.rows[0])
      await db.query(
        `INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,'connected',$2::jsonb)`,
        [agentId, JSON.stringify({ previous: freeAgent.rows[0].previous })],
      );
    return { epoch: Number(claimed.rows[0]?.epoch ?? 0), announcement };
  });
  const { epoch, announcement } = claimedConnection;
  await finishAgentAnnouncement(database, agentId, metadata, announcement);
  await notifyAgentConnection(database,agentId,epoch);
  live.publish({ type: 'agent-connection', roomId: '', agentId, epoch });
  await broadcastAgentPresence(database, live, agentId);
  return epoch;
}

/** Fenced: a connection that is no longer the agent's newest changes nothing. */
export async function releaseAgentConnection(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
  connectionId: string,
  forUpdate = false,
): Promise<boolean> {
  const released = await database.transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`presence:${agentId}`]);
    await lockAgentMachine(db, agentId);
    const current = await db.query<{ epoch: string | number }>(
      `UPDATE agent_connections SET released_at=clock_timestamp()
       WHERE agent_id=$1 AND connection_id=$2 AND released_at IS NULL RETURNING epoch`,
      [agentId, connectionId],
    );
    if (!current.rowCount) return undefined;
    await db.query(`UPDATE agent_commands command SET state='pending',generation_id=NULL,
      lease_expires_at=NULL,claimed_at=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL
      FROM agent_connections connection WHERE connection.agent_id=$1 AND connection.connection_id=$2
        AND command.agent_id=$1 AND command.state='claimed'
        AND (command.turn_owner_connection_id=COALESCE(connection.turn_connection_id,connection.connection_id)
          OR (command.turn_owner_connection_id IS NULL AND command.reason<>'mcp_call'
            AND COALESCE(command.generation_id,'') NOT LIKE 'mcp:%'))`,[agentId,connectionId]);

    await db.query(
      `UPDATE live_outputs SET body=body || ${releasedPresenceSql('$1')} || jsonb_build_object(
         'observedAt',GREATEST($3::bigint,COALESCE((body->>'observedAt')::bigint,0)+1)),
         updated_at=clock_timestamp()
       WHERE agent_id=$1 AND kind='presence' AND body->>'connectionId'=$2`,
      [agentId, connectionId, Math.floor(Date.now() / 1000)],
    );
    return Number(current.rows[0]!.epoch);
  });
  if (released !== undefined) {
    await notifyAgentConnection(database,agentId,released);
    live.publish({ type: 'agent-connection', roomId: '', agentId, epoch: released });
    await broadcastAgentPresence(database, live, agentId);
  }
  return released !== undefined;
}

/** A lost owner returns commands to pending; it never invents a terminal turn. */
export async function expireOwnedAgentTurns(database:SqlDatabase,_live:LiveHub,agentId:string):Promise<number>{
  const result=await database.query(`UPDATE agent_commands command SET state='pending',generation_id=NULL,
    lease_expires_at=NULL,claimed_at=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL
    WHERE agent_id=$1 AND state='claimed' AND turn_owner_connection_id IS NOT NULL
      AND ${commandOwnerExpiredSql('command')}`,[agentId]);
  return result.rowCount;
}

/**
 * Presence once an agent's connection ends. An ordinary agent goes offline.
 * A free agent's Machine sleeps and is started by its next wake, so it stays
 * reachable (`held`) and is marked `asleep`.
 */
function releasedPresenceSql(agentIdSql: string): string {
  return `(CASE WHEN ${freeAgentReachableSql(agentIdSql)}
    THEN jsonb_build_object('status','online','held',true,'asleep',true)
    ELSE jsonb_build_object('status','offline','held',false) END)`;
}

/**
 * Write one presence announcement inside the caller's transaction. A
 * connection claim marks the presence held by that connection; any other
 * announcement keeps whatever connection already holds it.
 */
type Announcement = { changed: boolean; previous?: Record<string, unknown> };

async function writeAgentAnnouncement(
  db: SqlDatabase,
  roomId: string | undefined,
  agentId: string,
  metadata: PresenceMetadata,
  connection?: HeldConnection,
  locked = false,
): Promise<Announcement> {
  const lifecycle = metadata.lifecycleId;
  if (!locked)
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`presence:${agentId}`]);
  const previous = (
    await db.query<{ room_id: string; body: Record<string, unknown> }>(
      `SELECT room_id,body FROM live_outputs WHERE agent_id=$1 AND kind='presence'
       ORDER BY updated_at DESC LIMIT 1`,
      [agentId],
    )
  ).rows[0];
  const targetRoomId =
    previous?.room_id ??
    roomId ??
    (
      await db.query<{ room_id: string }>(
        `SELECT room_id FROM room_access
         WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL LIMIT 1`,
        [agentId],
      )
    ).rows[0]?.room_id;
  // An agent in no Room has no reader to show presence to.
  if (!targetRoomId) return { changed: false, previous: previous?.body };
  const observedAt = Math.max(
    Math.floor(Date.now() / 1000),
    Number(previous?.body.observedAt ?? 0) + 1,
  );
  const held = connection
    ? { held: true, connectionId: connection.connectionId }
    : {
        ...(typeof previous?.body.held === 'boolean' ? { held: previous.body.held } : {}),
        ...(typeof previous?.body.connectionId === 'string'
          ? { connectionId: previous.body.connectionId }
          : {}),
      };
  const body = {
    status: metadata.available === false ? 'offline' : 'online',
    observedAt,
    evidenceNonce: randomUUID(),
    ...(lifecycle ? { lifecycleId: lifecycle } : {}),
    ...(metadata.releaseVersion || previous?.body.releaseVersion
      ? { releaseVersion: metadata.releaseVersion ?? previous?.body.releaseVersion } : {}),
    ...(metadata.sourceSha || previous?.body.sourceSha
      ? { sourceSha: metadata.sourceSha ?? previous?.body.sourceSha } : {}),
    ...held,
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
      [targetRoomId, agentId, JSON.stringify(body)],
    );
  return { changed: true, previous: previous?.body };
}

/** Command repair and restart receipts can wait on the Workspace journal.
 * Commit presence first so those waits hold neither its row nor its agent lock. */
async function finishAgentAnnouncement(database: SqlDatabase, agentId: string,
  metadata: PresenceMetadata, announcement: Announcement): Promise<void> {
  if (!announcement.changed || !metadata.lifecycleId) return;
  await database.transaction(async db => {
    const lifecycle = metadata.lifecycleId;
    if (!announcement.changed || !lifecycle) return;
    const restarts = await db.query<{
      id: string;
      room_id: string;
      source_message_id: string;
      generation_id: string | null;
      handle: string | null;
      name: string;
    }>(
      `SELECT command.id,command.generation_id,command.room_id,command.source_message_id,identity.handle,identity.name
       FROM agent_commands command JOIN identities identity ON command.agent_id=identity.id
       WHERE command.agent_id=$1
         AND command.action='restart' AND (command.state='claimed' OR (command.state='pending'
           AND EXISTS(SELECT 1 FROM agent_command_generation_owners binding WHERE binding.command_id=command.id)))
         AND command.lifecycle_before IS DISTINCT FROM $2
         AND EXISTS (SELECT 1 FROM live_outputs presence WHERE presence.agent_id=$1 AND presence.kind='presence'
           AND presence.body->>'lifecycleId'=$2)
       FOR UPDATE OF command`,
      [agentId, lifecycle],
    );
    for (const restart of restarts.rows) {
      if (!await endAgentTurn(db,restart,'complete')) continue;
      await db.query('UPDATE agent_commands SET restart_confirmed_at=now() WHERE id=$1',[restart.id]);
      await systemLine(db, {
        id: createHash('sha256')
          .update(`agent-restart-confirmed:${restart.id}:${lifecycle}`)
          .digest('hex'),
        roomId: restart.room_id,
        authorId: agentId,
        subject: {
          kind: 'agent',
          id: agentId,
          name: restart.handle ? systemMessage("connection-presence.agent-mention", restart.handle) : restart.name,
        },
        verb: systemMessage("connection-presence.reconnected-after-restart"),
        afterMessageId: restart.source_message_id,
      });
    }
  });
}

export async function recordAgentEvidence(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string | undefined,
  agentId: string,
): Promise<void> {
  const changed = await database.query(
    // Lock the presence row before INSERT's owner-projection lock, matching
    // lifecycle UPDATE's row-then-projection order.
    `WITH previous AS MATERIALIZED (
       SELECT output.room_id,output.body FROM live_outputs output
       WHERE output.agent_id=$1 AND output.kind='presence'
       ORDER BY output.updated_at DESC LIMIT 1 FOR UPDATE
     ), target AS MATERIALIZED (
       SELECT membership.room_id,previous.room_id previous_room,previous.body
       FROM (SELECT 1) singleton LEFT JOIN previous ON true
       JOIN room_access membership
         ON membership.room_id=COALESCE($2::uuid,previous.room_id)
        AND membership.identity_id=$1 AND membership.removed_at IS NULL
     ), written AS (
       INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       SELECT COALESCE(previous_room,room_id),$1,'presence','presence',
         COALESCE(body,'{}'::jsonb) || jsonb_build_object(
           'status','online',
           'observedAt',GREATEST($3::bigint,COALESCE((body->>'observedAt')::bigint,0)+1),
           'evidenceNonce',$4::text
         ),clock_timestamp()
       FROM target
       ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET
         body=live_outputs.body || jsonb_build_object(
           'status','online',
           'observedAt',GREATEST($3::bigint,COALESCE((live_outputs.body->>'observedAt')::bigint,0)+1),
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
    body: { status: 'online' | 'offline'; observedAt: number; held?: unknown };
  }>(
    `SELECT m.room_id,p.body FROM room_access m
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
      ...(row.body.held === true ? { held: true } : {}),
    });
}

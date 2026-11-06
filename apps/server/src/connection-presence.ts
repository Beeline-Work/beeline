import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { commandOwnerExpiredSql } from './turn-ownership.js';
import { ServerLeaseDeadlines } from './server-lease-deadlines.js';
import { startConnectionWork } from './background-work.js';
import { recoverAdapterReviewsOnHelperChange } from './helper-review-recovery.js';
import { CommanderWakeDeadlines } from './commander-wakes.js';
import { CornerAttentionDeadlines } from './corner-attention.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { lockAgentMachine } from './machine-offline.js';
import { freeAgentReachableSql } from './free-agents.js';
import { systemLine } from './system-line.js';
import { notifyAgentConnection } from './postgres-live.js';
import { renudgeStrandedPendingCommands } from './agent-command.js';

export const DELIVERY_PICKUP_WINDOW_MS = 90_000;
export const PRESENCE_EVIDENCE_MIN_INTERVAL_MS = 30_000;
/** How often a server instance renews its lease row. Constant per instance:
 *  no work here scales with agents or with heartbeat pings. */
export const SERVER_LEASE_RENEW_MS = 30_000;
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
/** Retain only evidence that can still affect a delivery deadline. */
export class RecentIdentityTimes {
  private readonly values = new Map<string, number>();

  constructor(private readonly limit: number, private readonly ttlMs: number) {}

  get(id: string): number | undefined { return this.values.get(id); }

  set(id: string, at: number): void {
    this.values.delete(id);
    this.values.set(id, at);
    for (const [oldestId, oldestAt] of this.values) {
      if (this.values.size <= this.limit && oldestAt > at - this.ttlMs) break;
      this.values.delete(oldestId);
    }
  }

  clear(): void { this.values.clear(); }
  get size(): number { return this.values.size; }
}

/** Presence follows authenticated connection claim/release. Delivery and turn
 * age never override a live connection or terminate its work. */
export class ConnectionPresence {
  readonly instanceId:string;
  readonly #ownedConnections=new Map<string,string>();
  readonly #serverLeaseDeadlines:ServerLeaseDeadlines;
  readonly #attention:CornerAttentionDeadlines;
  readonly #commanderWakes:CommanderWakeDeadlines;
  readonly #release:()=>void;
  readonly #releaseResync:()=>void;
  readonly #evidence=new Map<string,Promise<void>>();
  readonly #leaseRenewMs:number;
  #leaseTimer:(()=>void)|undefined;
  #leaseWrite?:Promise<void>;
  #lastLeaseAt=Number.NEGATIVE_INFINITY;
  #phoneConnections=0;
  #stopped=false;
  constructor(private readonly database:SqlDatabase,private readonly live:LiveHub,
    _pickupWindowMs=DELIVERY_PICKUP_WINDOW_MS,_evidenceMinimumIntervalMs=PRESENCE_EVIDENCE_MIN_INTERVAL_MS,
    private readonly lease:{instanceId?:string;renewMs?:number;expiryMs?:number;connectionWork?:typeof startConnectionWork}={}) {
    this.instanceId=lease.instanceId??randomUUID();
    this.#leaseRenewMs=lease.renewMs??SERVER_LEASE_RENEW_MS;
    this.#attention=new CornerAttentionDeadlines(database,live,this.report);
    this.#commanderWakes=new CommanderWakeDeadlines(database,live,this.report);
    this.#serverLeaseDeadlines=new ServerLeaseDeadlines(database,lease.expiryMs??SERVER_LEASE_EXPIRY_MS,async()=>{
      for(const agentId of await releaseStaleServerConnections(database,lease.expiryMs??SERVER_LEASE_EXPIRY_MS)){
        await expireOwnedAgentTurns(database,live,agentId);
        await broadcastAgentPresence(database,live,agentId);
      }
    },this.report);
    this.#releaseResync=live.subscribeResync(()=>{void this.recoverServerLeases().catch(this.report);});
    this.#release=live.subscribeAll(event=>{
      if(event.type==='agent-connection')void expireOwnedAgentTurns(database,live,event.agentId).catch(this.report);
    });
  }
  private readonly report=(error:unknown)=>console.error('[presence] connection transition failed',error);
  async start():Promise<void>{
    await this.recoverServerLeases();await this.#commanderWakes.start();await this.#attention.start();
  }
  /**
   * Renew one aggregate owner row while this instance holds connections.
   * Expired owners transition through their known one-shot deadlines; a
   * renewal never discovers other connections or publishes phone state.
   */
  startLease(): void {
    if (this.#leaseTimer || this.#stopped || (!this.#ownedConnections.size && !this.#phoneConnections)) return;
    const tick = () => void this.renewLease().catch(this.report);
    this.#leaseTimer = (this.lease.connectionWork ?? startConnectionWork)(tick, this.#leaseRenewMs);
  }

  /** A live phone or composed background owner retains the aggregate lease.
   * Phones also own viewing/push suppression rows. Share the existing helper
   * renewal with an idempotent release, never a separate evidence loop. */
  holdServerConnection():()=>void {
    if(this.#stopped)return ()=>{};
    this.#phoneConnections++;
    void this.renewLease().catch(this.report);
    this.startLease();
    let released=false;
    return ()=>{
      if(released)return;released=true;
      this.#phoneConnections=Math.max(0,this.#phoneConnections-1);
      if(!this.#ownedConnections.size && !this.#phoneConnections){this.#leaseTimer?.();this.#leaseTimer=undefined;}
    };
  }

  async renewLease(): Promise<void> {
    if (this.#stopped) return;
    if(this.#leaseWrite)return this.#leaseWrite;
    if(Date.now()-this.#lastLeaseAt<this.#leaseRenewMs)return;
    const pending=(async()=>{
      await this.database.query(
        `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES($1,clock_timestamp())
         ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at`,
        [this.instanceId],
      );
      this.#lastLeaseAt=Date.now();
      this.#serverLeaseDeadlines.observe(this.instanceId,this.#lastLeaseAt);
    })();
    this.#leaseWrite=pending;
    try{await pending;}finally{if(this.#leaseWrite===pending)this.#leaseWrite=undefined;}
  }

  recoverServerLeases(): Promise<void> { return this.#serverLeaseDeadlines.recover(); }
  observeServerLease(instanceId:string,renewedAt:number,removed=false):void {
    this.#serverLeaseDeadlines.observe(instanceId,renewedAt,removed);
  }

  /**
   * A helper connection for this agent was accepted here. Returns its epoch:
   * larger than every earlier connection's, on any server instance.
   */
  async claimConnection(
    agentId: string,
    metadata: PresenceMetadata & { connectionId: string },
  ): Promise<number> {
    if (this.#stopped) throw new Error('connection presence stopped');
    const { connectionId, ...presence } = metadata;
    // A real reconnect can prove recovery after a failed renewal. The local
    // minimum interval coalesces concurrent registrations into one write.
    await this.renewLease();
    const epoch=await claimAgentConnection(this.database, this.live, agentId, presence, {
      connectionId,
      instanceId: this.instanceId,
    });
    if(!this.#stopped){this.#ownedConnections.set(agentId,connectionId);this.startLease();}
    return epoch;
  }


  async releaseConnection(agentId:string,connectionId:string,forUpdate=false):Promise<void>{
    if(this.#stopped)return;
    if(this.#ownedConnections.get(agentId)===connectionId)this.#ownedConnections.delete(agentId);
    if(!this.#ownedConnections.size&&!this.#phoneConnections){this.#leaseTimer?.();this.#leaseTimer=undefined;}
    await releaseAgentConnection(this.database,this.live,agentId,connectionId,forUpdate);
  }
  async announce(roomId:string,agentId:string,metadata:PresenceMetadata={}):Promise<void>{
    if(this.#stopped||!metadata.lifecycleId)return;
    await announceAgentLifecycle(this.database,this.live,roomId,agentId,{...metadata,lifecycleId:metadata.lifecycleId});
  }
  evidence(roomId:string|undefined,agentId:string):Promise<void>{
    if(this.#stopped)return Promise.resolve();
    const current=this.#evidence.get(agentId);if(current)return current;
    const work=recordAgentEvidence(this.database,this.live,roomId,agentId).finally(()=>{this.#evidence.delete(agentId);});
    this.#evidence.set(agentId,work);return work;
  }
  async stop():Promise<void>{
    this.#stopped=true;this.#leaseTimer?.();this.#attention.stop();this.#commanderWakes.stop();
    this.#release();this.#releaseResync();await this.#leaseWrite?.catch(this.report);
    await this.#serverLeaseDeadlines.stop();await Promise.allSettled(this.#evidence.values());
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
       UPDATE free_agents f SET state='running',last_activity_at=now(),updated_at=now()
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
  await renudgeStrandedPendingCommands(database,agentId);
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

/** Release every connection held by a server instance whose lease expired. */
export async function releaseStaleServerConnections(
  database: SqlDatabase,
  expiryMs: number,
): Promise<string[]> {
  const released = await database.query<{ agent_id: string }>(
    `WITH stale AS (
       UPDATE agent_connections connection SET released_at=clock_timestamp()
       WHERE connection.released_at IS NULL AND NOT EXISTS(
         SELECT 1 FROM live_server_instances server
         WHERE server.instance_id=connection.instance_id
           AND server.renewed_at>clock_timestamp()-make_interval(secs => $1::double precision / 1000))
       RETURNING connection.agent_id,connection.connection_id
     ), demoted AS (
       UPDATE live_outputs presence SET body=presence.body || ${releasedPresenceSql('stale.agent_id')} || jsonb_build_object(
         'observedAt',GREATEST($2::bigint,COALESCE((presence.body->>'observedAt')::bigint,0)+1)),
         updated_at=clock_timestamp()
       FROM stale
       WHERE presence.agent_id=stale.agent_id AND presence.kind='presence'
         AND presence.body->>'connectionId'=stale.connection_id
       RETURNING presence.agent_id
     ) SELECT DISTINCT agent_id FROM demoted`,
    [expiryMs, Math.floor(Date.now() / 1000)],
  );
  await database.query(
    `DELETE FROM live_server_instances WHERE renewed_at<clock_timestamp()-interval '1 day'`,
  );
  return released.rows.map((row) => row.agent_id);
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
  const helperChanged = (['releaseVersion', 'sourceSha'] as const).some(key =>
    typeof announcement.previous?.[key] === 'string' && typeof metadata[key] === 'string' &&
    announcement.previous[key] !== metadata[key]);
  if (!helperChanged && (!announcement.changed || !metadata.lifecycleId)) return;
  await database.transaction(async db => {
    await recoverAdapterReviewsOnHelperChange(db, agentId, announcement.previous, metadata);
    const lifecycle = metadata.lifecycleId;
    if (!announcement.changed || !lifecycle) return;
    const restarts = await db.query<{
      id: string;
      room_id: string;
      source_message_id: string;
      handle: string | null;
      name: string;
    }>(
      `UPDATE agent_commands command SET state='complete',completed_at=now(),restart_confirmed_at=now()
       FROM identities identity
       WHERE command.agent_id=$1 AND command.agent_id=identity.id
         AND command.action='restart' AND command.state='claimed'
         AND command.lifecycle_before IS DISTINCT FROM $2
         AND EXISTS (SELECT 1 FROM live_outputs presence WHERE presence.agent_id=$1 AND presence.kind='presence'
           AND presence.body->>'lifecycleId'=$2)
       RETURNING command.id,command.room_id,command.source_message_id,identity.handle,identity.name`,
      [agentId, lifecycle],
    );
    for (const restart of restarts.rows)
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

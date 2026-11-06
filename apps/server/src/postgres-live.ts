import type { SqlDatabase } from "./database.js";
import type { LiveHub, LiveEvent } from "./live.js";
import { Client } from "pg";
import { notifyCommandCompletion } from "./command-completion.js";
import { readHelperOverlayFrame } from "@beeline/api-contract/helper-overlay";
import type { AgentSignInStep } from "./agent-sign-in.js";
import type { UsageRefreshOutcome } from "@beeline/api-contract/daemon";
import { decodePayload } from './postgres-live-decode-payload.js';
import { X_SIGNUP_DELIVERY_TABLE, MCP_WEBHOOK_TABLE, USAGE_REFRESH_TABLE, USAGE_REFRESH_RESULT_TABLE, decodeUsageRefreshResult, AGENT_SIGN_IN_TABLE, decodeAgentSignInNotification, COMMAND_COMPLETION_CHANNEL, POSTGRES_LIVE_CHANNEL } from './postgres-live-notifications.js';





export function committedCommandNotificationSchema(): string {
  return `CREATE OR REPLACE FUNCTION beeline_notify_committed_command(payload text) RETURNS void
    LANGUAGE sql AS $$ SELECT pg_notify('beeline_command_completion',payload) $$;`;
}


export function liveControlNotificationSchema(): string {
  return `CREATE OR REPLACE FUNCTION beeline_notify_live_control(payload text) RETURNS void
    LANGUAGE sql AS $$ SELECT pg_notify('beeline_live_v1',payload) $$;`;
}



/** A command's SQL transaction owns completion; local callbacks are only hints. */
export async function notifyCommittedCommand(database: Pick<SqlDatabase, 'query'>,
  key: { principal: string; operation: string; commandId: string }): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
}



/** Registration/takeover evidence carries no user-state projection or command
 * authority. The existing listener decodes this named agent_connection hint. */
export async function notifyAgentConnection(database: Pick<SqlDatabase, 'query'>,
  agentId: string, epoch: number): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: 'agent_connection', operation: 'UPDATE', roomId: '', agentId, epoch })]);
}



export const PARENT_ONLY_TABLES: ReadonlySet<string> = new Set([
  'corner_owed', 'corner_follows', 'corner_merge_holds',
]);


export const PARENT_ONLY_SQL = [...PARENT_ONLY_TABLES].map((table) => `'${table}'`).join(',');



/** Publish only committed state; callers pass their current transaction. */
export type PublishedNotification = LiveNotificationPayload
  | (AgentSignInStep & Pick<LiveNotificationPayload, 'table' | 'operation' | 'roomId'>)
  | (LiveNotificationPayload & { outcome: UsageRefreshOutcome });



export async function notifyLive(
  database: Pick<SqlDatabase, 'query'>,
  payload: PublishedNotification,
): Promise<void> {
  await database.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL, JSON.stringify(payload)]);
}



export function notifyMcpWebhook(database: Pick<SqlDatabase, 'query'>, roomId: string) {
  return notifyLive(database, { table: MCP_WEBHOOK_TABLE, operation: 'INSERT', roomId });
}


export function notifySentryWake(database: Pick<SqlDatabase, 'query'>) {
  return notifyLive(database, { table: 'sentry_wake_state', operation: 'UPDATE', roomId: '' });
}


export function notifyConnectorDiscovery(database: Pick<SqlDatabase, 'query'>, ownerId: string) {
  return notifyLive(database, { table: 'connector_discovery_cache', operation: 'UPDATE', roomId: '', ownerId });
}


export function notifyAgentSignIn(database: Pick<SqlDatabase, 'query'>, event: AgentSignInStep) {
  return notifyLive(database, { table: AGENT_SIGN_IN_TABLE, operation: 'UPDATE', roomId: '', ...event });
}


export function publishUsageRefreshResult(database: Pick<SqlDatabase, 'query'>, agentId: string,
  outcome: UsageRefreshOutcome, requestId?: string) {
  return notifyLive(database, { table: USAGE_REFRESH_RESULT_TABLE, operation: 'UPDATE', roomId: '', agentId,
    outcome, ...(requestId ? { requestId } : {}) });
}


export function notifyUsageRefreshRequest(database: Pick<SqlDatabase, 'query'>, agentId: string, requestId: string) {
  return notifyLive(database, { table: USAGE_REFRESH_TABLE, operation: 'UPDATE', roomId: '', agentId, requestId });
}


export function notifyAgentConfigRoom(database: Pick<SqlDatabase, 'query'>, roomId: string, agentId: string) {
  return notifyLive(database, { table: 'agent_config', operation: 'UPDATE', roomId, agentId });
}



/** SQL expressions keep notification and its source write in the same statement. */
export function notifyCornerStateSql(room: 'NEW.room_id' | 'corner'): string {
  return `pg_notify('${POSTGRES_LIVE_CHANNEL}',json_build_object('table','corner_state','operation','UPDATE','roomId',${room})::text)`;
}


export function notifyMcpWakesSql(channel: string): string {
  return `count(pg_notify(${channel}, jsonb_build_object(
        'table','${MCP_WEBHOOK_TABLE}','operation','INSERT','roomId',room_id::text)::text))`;
}



/** Agent-directed Connect / pending_ops wake. Never a catalog or availability. */
export async function notifyConnectorAssignment(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
): Promise<void> {
  await database.query(`SELECT pg_notify($1, $2)`, [
    POSTGRES_LIVE_CHANNEL,
    JSON.stringify({
      table: 'connector_assignment',
      operation: 'UPDATE',
      roomId: '',
      agentId,
    }),
  ]);
}



export async function notifyConnectorHelper(
  database: Pick<SqlDatabase, 'query'>,
  connectorId: string,
): Promise<void> {
  const row = (
    await database.query<{ helper_agent_id: string | null }>(
      `SELECT helper_agent_id FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    )
  ).rows[0];
  if (row?.helper_agent_id) await notifyConnectorAssignment(database, row.helper_agent_id);
}



/**
 * Hot-restart wake: every daemon live subscription of these Rooms filters on
 * the target agent, so idle retained sessions retire and the next turn
 * cold-activates against the current MCP set.
 */
export async function notifyAgentConfigChange(database: Pick<SqlDatabase,'query'>,agentId: string,workspaceId?: string): Promise<void> {
  await notifyAgentConfigChanges(database,[agentId],workspaceId);
}



export interface PgNotification {
  channel: string;
  payload?: string;
}



export interface LivePgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: PgNotification) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}



export type LivePgClientFactory = () => LivePgClient;



export interface LiveNotificationPayload {
  journalStreams?: string[];
  instanceId?:string;
  renewedAt?:number;
  table: string;
  operation: string;
  roomId: string;
  ownerId?: string;
  resourceId?: string;
  accountId?:string;
  usageOnly?:true;
  version?: string;
  squireReportChanged?: boolean;
  squireWorkChanged?: boolean;
  squireAddress?: string;
  messageId?: string;
  requestId?: string;
  turnStatus?: string;
  agentId?: string;
  identityId?: string;
  /** An identities change only its owner may hear: the push level alone. */
  ownerOnly?: boolean;
  workspaceId?: string;
  sourceRoomId?: string;
  needsYouCandidate?: boolean;
  turnId?: string;
  kind?: string;
  observedAt?: number;
  ownerEpoch?: string;
  expiresAt?: number;
  traceId?: string;
  databaseAt?: number;
  parentRoomId?: string;
  openedBy?: string;
  archived?: boolean;
  removed?: boolean;
  closeRequested?: boolean;
  /** Parent Room of a corner whose corner-list row inputs changed. */
  cornerParentId?: string;
  /** A current title/goal also changes the parent transcript's opening-card projection. */
  cornerTextChanged?: boolean;
  pending?: boolean;
  /** An agent_commands row left `claimed`. */
  released?: boolean;
  repositoryChanged?: boolean;
  installationId?: string;
  repositoryId?: string;
  jobId?: string;
  dueAt?: number;
  registryState?: string;
  registryConnectorId?: string;
  registryDueAt?: number;
  releaseVersion?: string;
  releaseSha?: string;
  /** Connection epoch an instance accepted for `agentId` (table `agent_connection`). */
  epoch?: number;
}



/** One session-persistent LISTEN connection for one server machine. */
export class PostgresLiveListener {
  private pushWake?: () => void;
  private xSignupDeliveryWake?:()=>void;
  setXSignupDeliveryWake(wake:()=>void):void {this.xSignupDeliveryWake=wake;}
  setPushWake(wake: () => void): void { this.pushWake = wake; }
  private owedWake?: (source: 'sentry' | 'owed') => void;
  setOwedWake(wake: (source: 'sentry' | 'owed') => void): void { this.owedWake = wake; }
  private mcpWebhookWake?: () => void;
  /** A committed AI-client tag; the wake sends its webhook POST at once. */
  setMcpWebhookWake(wake: () => void): void { this.mcpWebhookWake = wake; }
  private stopped = false;
  private running?: Promise<void>;
  private reconnectPending = false;
  private resumeConnection?: () => void;
  private disconnectActive?: () => void;
  private stopRecovery?: () => void;
  private active?: LivePgClient;
  private connected = false;
  private readonly projectionQueue: Array<{ raw: string; queuedAt: number; key?: string }> = [];
  private activeProjections = 0;
  private readonly activeProjectionSince = new Map<number, number>();
  private nextProjectionTicket = 0;
  private deliveredProjections = 0;
  private failedProjections = 0;
  private lastNotificationAt: number | null = null;
  private lastDeliveredAt: number | null = null;
  private lastDeliveryAgeMs: number | null = null;
  private maxDeliveryAgeMs = 0;
  private readonly deliveryAgeBuckets = [0, 0, 0, 0, 0, 0];

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly clientFactory: LivePgClientFactory,
  ) {}

  projectionHealth() {
    const oldestActive = this.activeProjectionSince.size
      ? Math.min(...this.activeProjectionSince.values()) : undefined;
    return {
      connected: this.connected,
      active: this.activeProjections,
      queued: this.projectionQueue.length,
      oldestActiveAgeMs: oldestActive === undefined
        ? null : Math.max(0, Date.now() - oldestActive),
      oldestQueuedAgeMs: this.projectionQueue[0]
        ? Math.max(0, Date.now() - this.projectionQueue[0].queuedAt) : null,
      dropped: 0,
      delivered: this.deliveredProjections,
      failed: this.failedProjections,
      lastNotificationAt: this.lastNotificationAt,
      lastDeliveredAt: this.lastDeliveredAt,
      lastDeliveryAgeMs: this.lastDeliveryAgeMs,
      maxDeliveryAgeMs: this.maxDeliveryAgeMs,
      /** Cumulative receipt-to-projection ages <=10, 50, 100, 500, 2000 ms, then above. */
      deliveryAgeBuckets: [...this.deliveryAgeBuckets],
      resyncPending: false,
    };
  }

  private enqueueProjection(raw: string | undefined): void {
    if (this.stopped || !raw) return;
    this.lastNotificationAt = Date.now();
    const payload = decodePayload(raw);
    if (!payload) return;
    if (payload.journalStreams?.length) this.live.journalChanged(payload.journalStreams);
    if (payload.table === 'router_source' || payload.table === 'router_authority') return;
    if(payload.table===X_SIGNUP_DELIVERY_TABLE){this.xSignupDeliveryWake?.();return;}
    if (payload.table === 'sentry_wake_state') {
      this.owedWake?.('sentry');
      return;
    }
    if (payload.table === MCP_WEBHOOK_TABLE) {
      this.mcpWebhookWake?.();
      return;
    }
    const pushOnly = payload.table === 'push_devices' ||
      payload.table === 'workspace_join_notifications';
    if ((payload.table === 'messages' && payload.operation !== 'DELETE') ||
        pushOnly || payload.table === 'identities' ||
        (payload.table === 'agent_turns' && payload.operation === 'UPDATE'))
      this.pushWake?.();
    if (pushOnly) return;
    if (payload.table === USAGE_REFRESH_TABLE && payload.agentId) {
      this.live.publish({
        type: 'usage-refresh', roomId: '', agentId: payload.agentId,
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      });
      return;
    }
    if (payload.table === USAGE_REFRESH_RESULT_TABLE) {
      const event = decodeUsageRefreshResult(raw);
      if (event) this.live.publish(event);
      return;
    }
    if (payload.table === AGENT_SIGN_IN_TABLE) {
      // No database work: publish now, and never queue or log the payload.
      const event = decodeAgentSignInNotification(raw);
      if (event) this.live.publish(event);
      return;
    }
    if (payload.table === 'helper_release_notifications' &&
        payload.releaseVersion && payload.releaseSha) {
      this.live.publish({
        type: 'helper-release',
        version: payload.releaseVersion, sha: payload.releaseSha,
      });
      return;
    }
    // These notifications only ask a helper to refresh the latest state or
    // drain durable pending operations; the newest one supersedes earlier ones.
    const key = (payload.table === 'agent_config' || payload.table === 'connector_assignment') &&
        payload.agentId
      ? `${payload.table}:${payload.agentId}`
      : payload.table==='usage_accounts'&&payload.ownerId&&payload.accountId
        ? `usage-account:${payload.ownerId}:${payload.accountId}`
      : PARENT_ONLY_TABLES.has(payload.table) && payload.cornerParentId
        ? `corner-status:${payload.cornerParentId}`
      : (payload.table === 'github_installations' && payload.installationId) ||
          (payload.table === 'github_repositories' && payload.repositoryId)
        ? `${payload.table}:${payload.installationId ?? payload.repositoryId}`
        : undefined;
    if (key) {
      const queued = this.projectionQueue.find((item) => item.key === key);
      if (queued) { queued.raw = raw; return; }
    }
    this.projectionQueue.push({ raw, queuedAt: Date.now(), ...(key ? { key } : {}) });
    this.drainProjections();
  }

  private drainProjections(): void {
    while (!this.stopped && this.projectionQueue.length) {
      const next = this.projectionQueue.shift()!;
      this.activeProjections++;
      const ticket = this.nextProjectionTicket++;
      this.activeProjectionSince.set(ticket, next.queuedAt);
      void this.rebroadcast(next.raw).then(() => {
        const now = Date.now();
        const duration = Math.max(0, now - next.queuedAt);
        this.deliveredProjections++;
        this.lastDeliveredAt = now;
        this.lastDeliveryAgeMs = duration;
        this.maxDeliveryAgeMs = Math.max(this.maxDeliveryAgeMs, duration);
        const bucket = [10, 50, 100, 500, 2_000].findIndex((bound) => duration <= bound);
        this.deliveryAgeBuckets[bucket < 0 ? 5 : bucket]!++;
      }).catch((error) => {
        this.failedProjections++;
        console.error('[live-listener] notification failed', error);
      }).finally(() => {
        this.activeProjectionSince.delete(ticket);
        this.activeProjections--;
        if (this.projectionQueue.length) this.drainProjections();

      });
    }
  }

  static forConnectionString(
    connectionString: string,
    database: SqlDatabase,
    live: LiveHub,
  ): PostgresLiveListener {
    return new PostgresLiveListener(
      database,
      live,
      () => new Client({ connectionString }) as unknown as LivePgClient,
    );
  }

  run(): Promise<void> {
    if (this.stopped) return this.running ?? Promise.resolve();
    if (!this.running) {
      this.stopRecovery = this.database.onRecovery?.(() => {
        if (this.stopped) return;
        if (!this.connected) this.requestConnection();
      });
      this.running = this.runConnections();
    }
    return this.running;
  }

  private requestConnection(): void {
    this.reconnectPending = true;
    this.resumeConnection?.();
  }

  private async runConnections(): Promise<void> {
    while (!this.stopped) {
      this.reconnectPending = false;
      let disconnect!: () => void;
      let released = false;
      const disconnected = new Promise<void>((resolve) => {
        disconnect = () => {
          if(released)return;released=true;
          if (this.connected && !this.stopped) {
            this.requestConnection();
          }
          this.connected=false;
          this.live.projectionUnavailable();
          resolve();
        };
      });
      this.disconnectActive = disconnect;
      const client = this.clientFactory();
      this.active = client;
      client.on('notification', (message) => {
        if (this.stopped || this.active !== client || released) return;
        if (message.channel === COMMAND_COMPLETION_CHANNEL) {
          if (message.payload) notifyCommandCompletion(message.payload);
          return;
        }
        if (message.channel !== POSTGRES_LIVE_CHANNEL) return;
        this.enqueueProjection(message.payload);
      });
      client.on('error', (error) => {
        console.error('[live-listener] connection failed', error.message);
        disconnect();
      });
      client.on('end', disconnect);
      try {
        await client.connect();
        if (this.stopped || this.active !== client) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        await client.query(`LISTEN ${POSTGRES_LIVE_CHANNEL}`);
        if (this.stopped) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        await client.query(`LISTEN ${COMMAND_COMPLETION_CHANNEL}`);
        if (this.stopped) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        this.connected = true;
        console.log('[live-listener] connected');
        if (this.stopped) return;
        if (released) throw new Error('LISTEN connection ended during acquisition');
        this.live.resync();
        await disconnected;
      } catch (error) {
        this.connected = false;
        disconnect();
        console.error(
          '[live-listener] connect failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.connected = false;
        if (this.active === client) this.active = undefined;
        this.disconnectActive = undefined;
        await client.end().catch(() => undefined);
      }
      if (!this.stopped && !this.reconnectPending) {
        await new Promise<void>(resolve => { this.resumeConnection = resolve; });
        this.resumeConnection = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopRecovery?.();
    this.disconnectActive?.();
    this.resumeConnection?.();
    this.projectionQueue.length = 0;
    await this.active?.end().catch(() => undefined);
    await this.running;
  }

  private async rebroadcast(raw: string | undefined): Promise<void> {
    const payload = decodePayload(raw);
    if (!payload) return;
    if(payload.table==='usage_accounts'){
      if(!payload.ownerId||!payload.accountId)return;
      const affected=await this.database.query<{agent_id:string}>(`SELECT agent_id FROM agents
        WHERE owner_id=$1 AND usage_account_id=$2::bigint ORDER BY agent_id`,[payload.ownerId,payload.accountId]);
      for(const agent of affected.rows)this.live.publish({type:'resource-change',roomId:'',ownerId:payload.ownerId,
        resource:'agent',resourceId:agent.agent_id,usageOnly:true});
      return;
    }
    if (payload.ownerId && (payload.table === 'workspace_connectors' ||
      payload.table === 'workspace_connections' || payload.table === 'squire_machines' || payload.table === 'connector_discovery_cache' || payload.table === 'wallet_bindings' || payload.table === 'agents' ||
      payload.table === 'agent_avatars' || payload.table === 'avatar_job' || payload.table === 'free_agent_usage')) {
      this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
        resource: payload.table === 'workspace_connectors' || payload.table === 'squire_machines' ? 'install'
          : payload.table === 'workspace_connections' || payload.table === 'connector_discovery_cache' || payload.table === 'wallet_bindings' ? 'workbench' : 'agent',
        ...(payload.resourceId ? { resourceId: payload.resourceId } : {}),
        ...(payload.usageOnly?{usageOnly:true as const}:{}),
        ...(payload.version ? { version: payload.version } : {}) });
      if (payload.squireReportChanged)
        this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
          resource: 'workbench' });
      // Install status reads both the ceremony and the machine's vault report.
      // The successful vault read can commit after installConnector completes.
      if ((payload.squireWorkChanged || payload.squireReportChanged) && payload.squireAddress)
        this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
          resource: 'install', resourceId: payload.squireAddress });
      return;
    }
    if (payload.table === 'live_outputs' && payload.agentId && payload.turnId) {
      if (payload.operation === 'DELETE') {
        if (payload.kind === 'draft' || payload.kind === 'thought') {
          this.live.publish({
            type: 'retract',
            roomId: payload.roomId,
            agentId: payload.agentId,
            turnId: payload.turnId,
            kind: payload.kind,
          });
        }
        return;
      }
      if (payload.kind === 'presence') {
        const rows = await this.database.query<{
          room_id: string;
          body: Record<string, unknown>;
        }>(
          `SELECT membership.room_id,presence.body
           FROM room_access membership
           JOIN LATERAL(
             SELECT body FROM live_outputs
             WHERE agent_id=$1 AND kind='presence'
             ORDER BY updated_at DESC LIMIT 1
           ) presence ON true
           WHERE membership.identity_id=$1 AND membership.room_id IS NOT NULL
             AND membership.removed_at IS NULL`,
          [payload.agentId],
        );
        for (const row of rows.rows) {
          if (
            (row.body.status !== 'online' && row.body.status !== 'offline') ||
            typeof row.body.observedAt !== 'number'
          )
            continue;
          this.live.publish({
            type: 'presence',
            roomId: row.room_id,
            agentId: payload.agentId,
            status: row.body.status,
            observedAt: row.body.observedAt,
            ...(row.body.held === true ? { held: true } : {}),
          });
        }
        return;
      }
      const row = (
        await this.database.query<{ body: Record<string, unknown> }>(
          `SELECT body FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4`,
          [payload.roomId, payload.agentId, payload.turnId, payload.kind],
        )
      ).rows[0];
      if (!row) return;
      if (payload.kind === 'draft' || payload.kind === 'thought') {
        if (typeof row.body.text !== 'string') return;
        const overlayV1=readHelperOverlayFrame(row.body.overlayV1);
        if(row.body.overlayV1!==undefined && (!overlayV1 || overlayV1.agentId!==payload.agentId ||
            overlayV1.roomId!==payload.roomId || overlayV1.turnId!==payload.turnId || overlayV1.kind!==payload.kind))return;
        if(overlayV1 && (overlayV1.type==='end'||overlayV1.type==='retract')){
          this.live.publish({type:'retract',roomId:payload.roomId,agentId:payload.agentId,turnId:payload.turnId,kind:payload.kind,overlayV1});
          return;
        }
        this.live.publish({
          type: payload.kind,
          roomId: payload.roomId,
          agentId: payload.agentId,
          turnId: payload.turnId,
          text: row.body.text,
          ...(overlayV1?{overlayV1}:{}),
          ...(typeof row.body.latestChunk === 'string'
            ? { latestChunk: row.body.latestChunk } : {}),
        });
        return;
      }
      return;
    }
    if (payload.table === 'agent_connection' && payload.agentId && payload.epoch !== undefined) {
      // Another instance accepted a newer helper connection for this agent.
      this.live.publish({
        type: 'agent-connection', roomId: '', agentId: payload.agentId, epoch: payload.epoch,
      });
      return;
    }
    if (payload.table === 'agent_config' && payload.agentId) {
      // A phone-side model/effort selection change. The synthetic payload is
      // written by PhoneService with a direct pg_notify inside the selection
      // transaction (the agents table carries no Room, so it has no trigger);
      // every daemon subscription of that Room filters on the target agent.
      this.live.publish({
        type: 'invalidate',
        roomId: payload.roomId,
        reason: 'agent-config',
        targetAgentId: payload.agentId,
      });
      return;
    }
    if (payload.table === 'connector_assignment' && payload.agentId) {
      // Connect / pending_ops: one agent-directed wake, never a catalog.
      this.live.publish({
        type: 'invalidate',
        roomId: payload.roomId,
        reason: 'connector-assignment',
        targetAgentId: payload.agentId,
      });
      return;
    }
    if (payload.table === 'registry_mcp_oauth_attempts') {
      if (payload.registryConnectorId) await notifyConnectorHelper(this.database, payload.registryConnectorId);
      return;
    }
    if (PARENT_ONLY_TABLES.has(payload.table)) {
      if (payload.cornerParentId)
        this.live.publish({ type: 'invalidate', roomId: payload.cornerParentId,
          reason: 'corner-status' });
      return;
    }
    if (payload.table === 'github_installations' || payload.table === 'github_repositories') {
      const rooms = await this.database.query<{ id: string }>(
        payload.installationId
          ? `SELECT id FROM rooms WHERE github_installation_id=$1 AND parent_id IS NULL`
          : `SELECT id FROM rooms WHERE repository_key='github:' || $1 AND parent_id IS NULL`,
        [payload.installationId ?? payload.repositoryId],
      );
      for (const room of rooms.rows)
        this.live.publish({ type: 'invalidate', roomId: room.id,
          reason: 'postgres:rooms', repositoryChanged: true });
      return;
    }
    if (payload.table === 'workspaces' || payload.table === 'identities') {
      // ID-only: each phone socket reads the change once and only a viewer
      // who shares that Workspace, or a Workspace or Room with that person, hears it.
      if (payload.table === 'workspaces' && payload.workspaceId)
        this.live.publish({ type: 'invalidate', roomId: '',
          reason: 'postgres:workspaces', workspaceId: payload.workspaceId });
      if (payload.table === 'identities' && payload.identityId)
        this.live.publish({ type: 'invalidate', roomId: '',
          reason: 'postgres:identities', personId: payload.identityId,
          ...(payload.ownerOnly ? { readerId: payload.identityId } : {}) });
      return;
    }
    if (payload.table === 'message_bookmarks' && payload.identityId &&
        payload.workspaceId && payload.messageId) {
      this.live.publish({ type: 'invalidate', roomId: '',
        reason: 'postgres:message_bookmarks', readerId: payload.identityId,
        workspaceId: payload.workspaceId, messageId: payload.messageId,
        operation: payload.operation });
      return;
    }
    if (payload.table === 'needs_you_marks' && payload.identityId &&
        payload.sourceRoomId) {
      this.live.publish({ type: 'invalidate', roomId: '',
        reason: 'postgres:needs_you_marks', readerId: payload.identityId,
        sourceRoomId: payload.sourceRoomId });
      return;
    }
    const event: Extract<LiveEvent, { type: 'invalidate' }> = {
      type: 'invalidate',
      roomId: payload.roomId,
      reason: `postgres:${payload.table}`,
      operation: payload.operation,
      ...(payload.table === 'memberships' && !payload.roomId && payload.identityId
        ? { readerId: payload.identityId }
        : {}),
      ...(payload.table === 'memberships' && payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      ...(payload.messageId ? { messageId: payload.messageId } : {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      ...(payload.turnStatus === 'working' || payload.turnStatus === 'complete' ||
        payload.turnStatus === 'failed' || payload.turnStatus === 'cancelled'
        ? { turnStatus: payload.turnStatus } : {}),
      ...(payload.needsYouCandidate ? { needsYouCandidate: true } : {}),
      ...(payload.table === 'agent_commands' ? { targetAgentId: payload.agentId } : {}),
      ...(payload.table === 'agent_commands' && payload.released ? { commandReleased: true } : {}),
      ...(payload.table === 'memberships' && payload.identityId
        ? { targetAgentId: payload.identityId }
        : {}),
      ...(payload.table === 'room_read_marks' && payload.identityId
        ? { readerId: payload.identityId }
        : {}),
      ...(payload.parentRoomId ? { parentRoomId: payload.parentRoomId } : {}),
      ...(payload.openedBy ? { openedBy: payload.openedBy } : {}),
      ...(payload.archived ? { archived: true } : {}),
      ...(payload.removed ? { removed: true } : {}),
      ...(payload.closeRequested ? { closeRequested: true } : {}),
      ...(payload.repositoryChanged ? { repositoryChanged: true } : {}),
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.traceId && payload.databaseAt
        ? {
            trace: {
              id: payload.traceId,
              databaseAt: payload.databaseAt,
              emittedAt: Date.now(),
            },
          }
        : {}),
    };
    this.live.publish(event);
    // Navigation text also appears in the parent's historical opening-card projection.
    if (payload.cornerParentId && payload.cornerTextChanged) this.live.publish({
      type: 'invalidate', roomId: payload.cornerParentId, reason: 'corner-text',
    });
    // The parent corner list rereads from this id-only hint.
    if (payload.cornerParentId) {
      this.live.publish({
        type: 'invalidate',
        roomId: payload.cornerParentId,
        reason: payload.table === 'agent_schedules' || payload.table === 'agent_subscriptions'
          ? `postgres:${payload.table}` : 'corner-status',
      });
    }
  }
}
export { postgresLiveSchema } from './postgres-live-schema.js';

export { POSTGRES_LIVE_CHANNEL } from './postgres-live-notifications.js';

export async function notifyAgentConfigChanges(database: Pick<SqlDatabase,'query'>,agentIds: readonly string[],workspaceId?: string): Promise<void> {
  if(!agentIds.length) return;
  await database.query(`SELECT pg_notify($1,jsonb_build_object('table','agent_config','operation','UPDATE',
    'roomId',member.room_id,'agentId',member.identity_id)::text)
    FROM room_access member JOIN rooms room ON room.id=member.room_id
    WHERE member.identity_id=ANY($2::text[]) AND ($3::uuid IS NULL OR member.workspace_id=$3)
      AND member.removed_at IS NULL AND room.archived_at IS NULL`,[POSTGRES_LIVE_CHANNEL,agentIds,workspaceId??null]);
}

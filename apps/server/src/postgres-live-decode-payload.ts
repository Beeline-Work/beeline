import { X_SIGNUP_DELIVERY_TABLE, SERVER_LEASE_EVIDENCE_TABLE, AGENT_SIGN_IN_TABLE, decodeAgentSignInNotification, USAGE_REFRESH_TABLE, USAGE_REFRESH_RESULT_TABLE, decodeUsageRefreshResult, MCP_WEBHOOK_TABLE } from './postgres-live-notifications.js';
import { readHelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import { notifyCommandCompletion, recoverCommandCompletions } from './command-completion.js';
import { COMMAND_COMPLETION_CHANNEL, POSTGRES_LIVE_CHANNEL } from './postgres-live-notifications.js';
import { Client } from 'pg';
import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';
import { LiveNotificationPayload, LivePgClient, notifyConnectorHelper, LivePgClientFactory, PARENT_ONLY_TABLES } from './postgres-live.js';



export function decodePayload(value: string | undefined): LiveNotificationPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.table !== 'string' ||
      typeof parsed.operation !== 'string' ||
      typeof parsed.roomId !== 'string'
    )
      return undefined;
    return {
      ...(Array.isArray(parsed.journalStreams)
        ? { journalStreams: parsed.journalStreams.filter((s): s is string => typeof s === 'string') } : {}),
      ...(typeof parsed.instanceId==='string' ? {instanceId:parsed.instanceId} : {}),
      ...(Number.isSafeInteger(parsed.renewedAt) ? {renewedAt:parsed.renewedAt as number} : {}),
      table: parsed.table,
      operation: parsed.operation,
      roomId: parsed.roomId,
      ...(typeof parsed.ownerId === 'string' ? { ownerId: parsed.ownerId } : {}),
      ...(typeof parsed.resourceId === 'string' ? { resourceId: parsed.resourceId } : {}),
      ...(typeof parsed.accountId==='string'&&/^[0-9]{1,20}$/.test(parsed.accountId)?{accountId:parsed.accountId}:{}),
      ...(parsed.usageOnly===true?{usageOnly:true as const}:{}),
      ...(parsed.squireReportChanged === true ? { squireReportChanged: true } : {}),
      ...(parsed.squireWorkChanged === true ? { squireWorkChanged: true } : {}),
      ...(typeof parsed.squireAddress === 'string' ? { squireAddress: parsed.squireAddress } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(typeof parsed.agentId === 'string' ? { agentId: parsed.agentId } : {}),
      ...(typeof parsed.identityId === 'string' ? { identityId: parsed.identityId } : {}),
      ...(parsed.ownerOnly === true ? { ownerOnly: true } : {}),
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId } : {}),
      ...(typeof parsed.sourceRoomId === 'string' ? { sourceRoomId: parsed.sourceRoomId } : {}),
      ...(typeof parsed.needsYouCandidate === 'boolean'
        ? { needsYouCandidate: parsed.needsYouCandidate } : {}),
      ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
      ...(typeof parsed.turnStatus === 'string' ? { turnStatus: parsed.turnStatus } : {}),
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
      ...(typeof parsed.observedAt === 'number' ? { observedAt: parsed.observedAt } : {}),
      ...(typeof parsed.epoch === 'number' ? { epoch: parsed.epoch } : {}),
      ...(typeof parsed.ownerEpoch === 'string' ? { ownerEpoch: parsed.ownerEpoch } : {}),
      ...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
      ...(typeof parsed.traceId === 'string' ? { traceId: parsed.traceId } : {}),
      ...(typeof parsed.databaseAt === 'number' ? { databaseAt: parsed.databaseAt } : {}),
      ...(typeof parsed.parentRoomId === 'string' ? { parentRoomId: parsed.parentRoomId } : {}),
      ...(typeof parsed.openedBy === 'string' ? { openedBy: parsed.openedBy } : {}),
      ...(typeof parsed.archived === 'boolean' ? { archived: parsed.archived } : {}),
      ...(typeof parsed.removed === 'boolean' ? { removed: parsed.removed } : {}),
      ...(typeof parsed.closeRequested === 'boolean'
        ? { closeRequested: parsed.closeRequested }
        : {}),
      ...(typeof parsed.cornerParentId === 'string'
        ? { cornerParentId: parsed.cornerParentId }
        : {}),
      ...(parsed.cornerTextChanged === true ? { cornerTextChanged: true } : {}),
      ...(typeof parsed.pending === 'boolean' ? { pending: parsed.pending } : {}),
      ...(parsed.released === true ? { released: true } : {}),
      ...(typeof parsed.repositoryChanged === 'boolean'
        ? { repositoryChanged: parsed.repositoryChanged } : {}),
      ...(parsed.installationId !== undefined ? { installationId: String(parsed.installationId) } : {}),
      ...(parsed.repositoryId !== undefined ? { repositoryId: String(parsed.repositoryId) } : {}),
      ...(typeof parsed.jobId === 'string' ? { jobId: parsed.jobId } : {}),
      ...(typeof parsed.dueAt === 'number' ? { dueAt: parsed.dueAt } : {}),
      ...(typeof parsed.registryState === 'string' ? { registryState: parsed.registryState } : {}),
      ...(typeof parsed.registryConnectorId === 'string' ? { registryConnectorId: parsed.registryConnectorId } : {}),
      ...(typeof parsed.registryDueAt === 'number' ? { registryDueAt: parsed.registryDueAt } : {}),
      ...(typeof parsed.releaseVersion === 'string' ? { releaseVersion: parsed.releaseVersion } : {}),
      ...(typeof parsed.releaseSha === 'string' ? { releaseSha: parsed.releaseSha } : {}),
    };
  } catch {
    return undefined;
  }
}


/** One session-persistent LISTEN connection for one server machine. */
export class PostgresLiveListener {
  private pushWake?: () => void;
  private xSignupDeliveryWake?:()=>void;
  setXSignupDeliveryWake(wake:()=>void):void {this.xSignupDeliveryWake=wake;}
  private serverLeaseEvidence?: (instance:string,renewedAt:number,removed:boolean)=>void;
  setServerLeaseEvidence(observe:(instance:string,renewedAt:number,removed:boolean)=>void):void { this.serverLeaseEvidence=observe; }

  setPushWake(wake: () => void): void { this.pushWake = wake; }
  private owedWake?: (source: 'sentry' | 'owed') => void;
  setOwedWake(wake: (source: 'sentry' | 'owed') => void): void { this.owedWake = wake; }
  private mcpWebhookWake?: () => void;
  /** A committed AI-client tag; the wake sends its webhook POST at once. */
  setMcpWebhookWake(wake: () => void): void { this.mcpWebhookWake = wake; }
  private stopped = false;
  private running?: Promise<void>;
  private reconnectPending = false;
  private replacementAllowed = true;
  private resumeConnection?: () => void;
  private disconnectActive?: () => void;
  private stopRecovery?: () => void;
  private active?: LivePgClient;
  private connected = false;
  private readonly projectionQueue: Array<{ raw: string; queuedAt: number; key?: string }> = [];
  private activeProjections = 0;
  private readonly activeProjectionSince = new Map<number, number>();
  private nextProjectionTicket = 0;
  private droppedProjections = 0;
  private deliveredProjections = 0;
  private failedProjections = 0;
  private lastNotificationAt: number | null = null;
  private lastDeliveredAt: number | null = null;
  private lastDeliveryAgeMs: number | null = null;
  private maxDeliveryAgeMs = 0;
  private readonly deliveryAgeBuckets = [0, 0, 0, 0, 0, 0];
  private needsProjectionResync = false;
  private readonly registryDue = new Map<string, { connectorId: string; dueAt: number }>();
  private registryDueTimer?: NodeJS.Timeout;

  private scheduleRegistryDue(): void {
    if (this.registryDueTimer) clearTimeout(this.registryDueTimer);
    this.registryDueTimer = undefined;
    if (this.stopped || !this.registryDue.size) return;
    let dueAt = Number.POSITIVE_INFINITY;
    for (const attempt of this.registryDue.values()) dueAt = Math.min(dueAt, attempt.dueAt);
    this.registryDueTimer = setTimeout(() => {
      this.registryDueTimer = undefined;
      const now = Date.now();
      for (const [state, attempt] of this.registryDue) {
        if (attempt.dueAt > now) continue;
        this.registryDue.delete(state);
        void notifyConnectorHelper(this.database, attempt.connectorId).catch((error) =>
          console.error('[live-listener] registry expiry notification failed', error));
      }
      this.scheduleRegistryDue();
    }, Math.max(0, dueAt - Date.now()));
    this.registryDueTimer.unref?.();
  }

  private async restoreRegistryDue(): Promise<void> {
    const rows = await this.database.query<{
      state: string; connector_id: string; expires_at: Date;
    }>(`SELECT state,connector_id,expires_at FROM registry_mcp_oauth_attempts WHERE code IS NULL`);
    this.registryDue.clear();
    for (const row of rows.rows) {
      const dueAt = row.expires_at.getTime();
      if (dueAt <= Date.now()) await notifyConnectorHelper(this.database, row.connector_id);
      else this.registryDue.set(row.state, { connectorId: row.connector_id, dueAt });
    }
    this.scheduleRegistryDue();
  }

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
      dropped: this.droppedProjections,
      delivered: this.deliveredProjections,
      failed: this.failedProjections,
      lastNotificationAt: this.lastNotificationAt,
      lastDeliveredAt: this.lastDeliveredAt,
      lastDeliveryAgeMs: this.lastDeliveryAgeMs,
      maxDeliveryAgeMs: this.maxDeliveryAgeMs,
      /** Cumulative receipt-to-projection ages <=10, 50, 100, 500, 2000 ms, then above. */
      deliveryAgeBuckets: [...this.deliveryAgeBuckets],
      resyncPending: this.needsProjectionResync,
    };
  }

  private enqueueProjection(raw: string | undefined): void {
    if (this.stopped || !raw) return;
    this.lastNotificationAt = Date.now();
    const payload = decodePayload(raw);
    if (!payload) return;
    // A committed cause proves traffic on this incarnation; an opened socket
    // alone never replenishes the one replacement allowance.
    this.replacementAllowed = true;
    if (payload.journalStreams?.length) this.live.journalChanged(payload.journalStreams);
    if (payload.table === 'router_source' || payload.table === 'router_authority') return;
    if(payload.table===X_SIGNUP_DELIVERY_TABLE){this.xSignupDeliveryWake?.();return;}
    if(payload.table===SERVER_LEASE_EVIDENCE_TABLE){
      if(payload.instanceId && payload.renewedAt!==undefined)this.serverLeaseEvidence?.(payload.instanceId,payload.renewedAt,payload.removed===true);
      return;
    }
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
    if (this.projectionQueue.length >= 512) {
      this.droppedProjections++;
      this.needsProjectionResync = true;
      return;
    }
    this.projectionQueue.push({ raw, queuedAt: Date.now(), ...(key ? { key } : {}) });
    this.drainProjections();
  }

  private drainProjections(): void {
    while (!this.stopped && this.activeProjections < 2 && this.projectionQueue.length) {
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
        else if (!this.stopped && this.activeProjections === 0 && this.needsProjectionResync) {
          this.needsProjectionResync = false;
          this.live.resync();
        }
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
        this.replacementAllowed = true;
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
          if (this.connected && this.replacementAllowed && !this.stopped) {
            this.replacementAllowed = false;
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
        recoverCommandCompletions();
        this.xSignupDeliveryWake?.();
        this.connected = true;
        console.log('[live-listener] connected');
        // A reconnect may have missed committed writes while LISTEN was down.
        this.pushWake?.();
        await this.restoreRegistryDue();
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
    if (this.registryDueTimer) clearTimeout(this.registryDueTimer);
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
      payload.table === 'workspace_connections' || payload.table === 'connector_discovery_cache' || payload.table === 'wallet_bindings' || payload.table === 'agents' ||
      payload.table === 'agent_avatars' || payload.table === 'avatar_job' || payload.table === 'free_agent_usage')) {
      this.live.publish({ type: 'resource-change', roomId: '', ownerId: payload.ownerId,
        resource: payload.table === 'workspace_connectors' ? 'install'
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
      if (payload.registryState) {
        if (payload.registryDueAt && payload.registryConnectorId &&
            payload.registryDueAt > Date.now())
          this.registryDue.set(payload.registryState, {
            connectorId: payload.registryConnectorId, dueAt: payload.registryDueAt });
        else {
          this.registryDue.delete(payload.registryState);
          if (payload.registryDueAt && payload.registryConnectorId)
            await notifyConnectorHelper(this.database, payload.registryConnectorId);
        }
        this.scheduleRegistryDue();
      }
      return;
    }
    if (PARENT_ONLY_TABLES.has(payload.table)) {
      if (payload.cornerParentId)
        this.live.publish({ type: 'invalidate', roomId: payload.cornerParentId,
          reason: 'corner-status' });
      // A new owed item may expire before the leader's next cycle.
      if (payload.table === 'corner_owed') this.owedWake?.('owed');
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

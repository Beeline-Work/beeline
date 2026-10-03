import { Client } from 'pg';
import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';

export const POSTGRES_LIVE_CHANNEL = 'beeline_live_v1';

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
export async function notifyAgentConfigChange(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  workspaceId?: string,
): Promise<void> {
  const rooms = await database.query<{ room_id: string }>(
    workspaceId
      ? `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1 AND membership.workspace_id=$2
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`
      : `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`,
    workspaceId ? [agentId, workspaceId] : [agentId],
  );
  for (const room of rooms.rows) {
    await database.query(`SELECT pg_notify($1, $2)`, [
      POSTGRES_LIVE_CHANNEL,
      JSON.stringify({
        table: 'agent_config',
        operation: 'UPDATE',
        roomId: room.room_id,
        agentId,
      }),
    ]);
  }
}

export const POSTGRES_LIVE_SCHEMA = `
CREATE OR REPLACE FUNCTION beeline_notify_live() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'messages' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'messageId', COALESCE(NEW.id, OLD.id),
        'agentId', COALESCE(NEW.author_id, OLD.author_id)
      );
    WHEN 'room_read_marks' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id)
      );
    WHEN 'live_outputs' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'turnId', COALESCE(NEW.turn_id, OLD.turn_id),
        'kind', COALESCE(NEW.kind, OLD.kind)
      );
    WHEN 'agent_commands' THEN
      payload = jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id), 'agentId', COALESCE(NEW.agent_id, OLD.agent_id));
    WHEN 'agent_turns' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'requestId', COALESCE(NEW.request_id, OLD.request_id),
        'cornerParentId', CASE WHEN TG_OP <> 'UPDATE' OR NEW.status IS DISTINCT FROM OLD.status
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.room_id, OLD.room_id)) END
      );
    WHEN 'rooms' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.id, OLD.id),
        'repositoryChanged', CASE WHEN TG_OP = 'UPDATE' THEN
          ROW(NEW.repository_key,NEW.repository_remote,NEW.repository_target_branch,
              NEW.repository_resolution,NEW.github_installation_id)
          IS DISTINCT FROM
          ROW(OLD.repository_key,OLD.repository_remote,OLD.repository_target_branch,
              OLD.repository_resolution,OLD.github_installation_id)
          ELSE false END
      );
    WHEN 'github_installations' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'installationId', COALESCE(NEW.installation_id,OLD.installation_id)
      );
    WHEN 'github_repositories' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'repositoryId', COALESCE(NEW.repository_id,OLD.repository_id)
      );
    WHEN 'registry_mcp_oauth_attempts' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP, 'roomId', '',
        'registryState', COALESCE(NEW.state,OLD.state),
        'registryConnectorId', COALESCE(NEW.connector_id,OLD.connector_id),
        'registryDueAt', CASE WHEN TG_OP = 'DELETE' OR NEW.code IS NOT NULL THEN NULL
          ELSE floor(extract(epoch FROM NEW.expires_at) * 1000)::bigint END
      );
    WHEN 'memberships' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id),
        'removed', CASE
          WHEN TG_OP = 'DELETE' THEN true
          ELSE COALESCE(NEW.removed_at IS NOT NULL, false)
        END
      ) || COALESCE((
        SELECT jsonb_build_object(
          'parentRoomId', room.parent_id,
          'archived', room.archived_at IS NOT NULL,
          'openedBy', CASE WHEN room.parent_id IS NOT NULL THEN COALESCE(
            (SELECT fact.owner_agent_id FROM corner_facts fact WHERE fact.corner_id = room.id),
            room.created_by
          ) END
        )
        FROM rooms room WHERE room.id = COALESCE(NEW.room_id, OLD.room_id)
      ), '{}'::jsonb);
    WHEN 'corner_facts' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.corner_id, OLD.corner_id),
        'cornerId', COALESCE(NEW.corner_id, OLD.corner_id),
        'closeRequested', COALESCE(NEW.close_requested, OLD.close_requested, false),
        'lane', COALESCE(NEW.lane, OLD.lane),
        'laneChanged', CASE WHEN TG_OP = 'UPDATE'
          THEN NEW.lane IS DISTINCT FROM OLD.lane ELSE false END,
        'cornerParentId', CASE WHEN TG_OP <> 'UPDATE'
            OR NEW.lifecycle IS DISTINCT FROM OLD.lifecycle
            OR NEW.close_requested IS DISTINCT FROM OLD.close_requested
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.corner_id, OLD.corner_id)) END
      );
    WHEN 'permission_authority' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.principal_id, OLD.principal_id),
        'permissionId', COALESCE(NEW.permission_id, OLD.permission_id),
        'cornerParentId', CASE WHEN TG_OP <> 'UPDATE' OR NEW.status IS DISTINCT FROM OLD.status
          THEN (SELECT parent_id FROM rooms WHERE id = COALESCE(NEW.room_id, OLD.room_id)) END
      );
    WHEN 'agent_grants' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'grantId', COALESCE(NEW.id, OLD.id)
      );
    WHEN 'agent_schedules' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'scheduleId', COALESCE(NEW.id, OLD.id)
      );
    WHEN 'institutional_memory_jobs' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.source_room_id, OLD.source_room_id),
        'jobId', COALESCE(NEW.id,OLD.id),
        'pending', NEW.status = 'pending' AND NEW.next_attempt_at <= now(),
        'dueAt', CASE WHEN TG_OP = 'DELETE' THEN NULL
          WHEN NEW.status IN ('pending','retry') THEN
            floor(extract(epoch FROM NEW.next_attempt_at) * 1000)::bigint
          WHEN NEW.status = 'claimed' THEN
            floor(extract(epoch FROM NEW.lease_expires_at) * 1000)::bigint
          ELSE NULL END
      );
  END CASE;
  payload = payload || jsonb_build_object(
    'traceId', md5(random()::text || clock_timestamp()::text || txid_current()::text),
    'databaseAt', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
  );
  IF payload->>'roomId' IS NOT NULL THEN
    PERFORM pg_notify('${POSTGRES_LIVE_CHANNEL}', payload::text);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'messages', 'live_outputs', 'agent_turns', 'rooms', 'memberships',
    'corner_facts', 'permission_authority', 'room_read_marks',
    'agent_grants', 'agent_schedules', 'agent_commands',
    'institutional_memory_jobs', 'github_installations', 'github_repositories',
    'registry_mcp_oauth_attempts'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'beeline_notify_live_' || table_name AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION beeline_notify_live()',
        'beeline_notify_live_' || table_name,
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
`;

interface PgNotification {
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

type LivePgClientFactory = () => LivePgClient;

interface LiveNotificationPayload {
  table: string;
  operation: string;
  roomId: string;
  messageId?: string;
  requestId?: string;
  agentId?: string;
  identityId?: string;
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
  lane?: string;
  laneChanged?: boolean;
  /** Parent Room of a corner whose list status inputs (turn status, lifecycle, close) changed. */
  cornerParentId?: string;
  pending?: boolean;
  repositoryChanged?: boolean;
  installationId?: string;
  repositoryId?: string;
  jobId?: string;
  dueAt?: number;
  registryState?: string;
  registryConnectorId?: string;
  registryDueAt?: number;
  /** Connection epoch an instance accepted for `agentId` (table `agent_connection`). */
  epoch?: number;
}

function decodePayload(value: string | undefined): LiveNotificationPayload | undefined {
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
      table: parsed.table,
      operation: parsed.operation,
      roomId: parsed.roomId,
      ...(typeof parsed.agentId === 'string' ? { agentId: parsed.agentId } : {}),
      ...(typeof parsed.identityId === 'string' ? { identityId: parsed.identityId } : {}),
      ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
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
      ...(typeof parsed.lane === 'string' ? { lane: parsed.lane } : {}),
      ...(typeof parsed.laneChanged === 'boolean' ? { laneChanged: parsed.laneChanged } : {}),
      ...(typeof parsed.cornerParentId === 'string'
        ? { cornerParentId: parsed.cornerParentId }
        : {}),
      ...(typeof parsed.pending === 'boolean' ? { pending: parsed.pending } : {}),
      ...(typeof parsed.repositoryChanged === 'boolean'
        ? { repositoryChanged: parsed.repositoryChanged } : {}),
      ...(parsed.installationId !== undefined ? { installationId: String(parsed.installationId) } : {}),
      ...(parsed.repositoryId !== undefined ? { repositoryId: String(parsed.repositoryId) } : {}),
      ...(typeof parsed.jobId === 'string' ? { jobId: parsed.jobId } : {}),
      ...(typeof parsed.dueAt === 'number' ? { dueAt: parsed.dueAt } : {}),
      ...(typeof parsed.registryState === 'string' ? { registryState: parsed.registryState } : {}),
      ...(typeof parsed.registryConnectorId === 'string' ? { registryConnectorId: parsed.registryConnectorId } : {}),
      ...(typeof parsed.registryDueAt === 'number' ? { registryDueAt: parsed.registryDueAt } : {}),
    };
  } catch {
    return undefined;
  }
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

/** One session-persistent LISTEN connection for one server machine. */
export class PostgresLiveListener {
  private stopped = false;
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
  private readonly memoryDue = new Map<string, { roomId: string; dueAt: number }>();
  private memoryDueTimer?: NodeJS.Timeout;
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

  private async pushMemoryJob(roomId: string): Promise<void> {
    const members = await this.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships WHERE room_id=$1 AND removed_at IS NULL`,
      [roomId],
    );
    for (const member of members.rows)
      this.live.publish({ type: 'invalidate', roomId, reason: 'memory-job',
        targetAgentId: member.identity_id });
  }

  private scheduleMemoryDue(): void {
    if (this.memoryDueTimer) clearTimeout(this.memoryDueTimer);
    this.memoryDueTimer = undefined;
    if (this.stopped || !this.memoryDue.size) return;
    let dueAt = Number.POSITIVE_INFINITY;
    for (const job of this.memoryDue.values()) dueAt = Math.min(dueAt, job.dueAt);
    this.memoryDueTimer = setTimeout(() => {
      this.memoryDueTimer = undefined;
      const now = Date.now();
      for (const [id, job] of this.memoryDue) {
        if (job.dueAt > now) continue;
        this.memoryDue.delete(id);
        void this.pushMemoryJob(job.roomId).catch((error) =>
          console.error('[live-listener] memory due notification failed', error));
      }
      this.scheduleMemoryDue();
    }, Math.max(0, dueAt - Date.now()));
    this.memoryDueTimer.unref?.();
  }

  private async restoreMemoryDue(): Promise<void> {
    const rows = await this.database.query<{
      id: string; source_room_id: string; due_at: Date;
    }>(
      `SELECT id,source_room_id,
         CASE WHEN status='claimed' THEN lease_expires_at ELSE next_attempt_at END due_at
       FROM institutional_memory_jobs WHERE status IN ('pending','retry','claimed')`,
    );
    this.memoryDue.clear();
    for (const row of rows.rows) {
      if (!row.due_at) continue;
      const dueAt = row.due_at.getTime();
      if (dueAt <= Date.now()) {
        await this.pushMemoryJob(row.source_room_id);
      } else this.memoryDue.set(row.id, { roomId: row.source_room_id, dueAt });
    }
    this.scheduleMemoryDue();
  }

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly clientFactory: LivePgClientFactory,
    private readonly retryDelayMs = 1_000,
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
    // These notifications only ask a helper to refresh the latest state or
    // drain durable pending operations; the newest one supersedes earlier ones.
    const key = (payload.table === 'agent_config' || payload.table === 'connector_assignment') &&
        payload.agentId
      ? `${payload.table}:${payload.agentId}`
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

  async run(): Promise<void> {
    while (!this.stopped) {
      let disconnect!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        disconnect = resolve;
      });
      const client = this.clientFactory();
      this.active = client;
      client.on('notification', (message) => {
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
        await client.query(`LISTEN ${POSTGRES_LIVE_CHANNEL}`);
        this.connected = true;
        console.log('[live-listener] connected');
        await this.restoreMemoryDue();
        await this.restoreRegistryDue();
        this.live.resync();
        await disconnected;
      } catch (error) {
        console.error(
          '[live-listener] connect failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.connected = false;
        if (this.active === client) this.active = undefined;
        await client.end().catch(() => undefined);
      }
      if (!this.stopped) await wait(this.retryDelayMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.projectionQueue.length = 0;
    if (this.memoryDueTimer) clearTimeout(this.memoryDueTimer);
    if (this.registryDueTimer) clearTimeout(this.registryDueTimer);
    await this.active?.end().catch(() => undefined);
  }

  private async rebroadcast(raw: string | undefined): Promise<void> {
    const payload = decodePayload(raw);
    if (!payload) return;
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
           FROM memberships membership
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
        this.live.publish({
          type: payload.kind,
          roomId: payload.roomId,
          agentId: payload.agentId,
          turnId: payload.turnId,
          text: row.body.text,
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
    if (payload.table === 'institutional_memory_jobs') {
      if (payload.pending === true) await this.pushMemoryJob(payload.roomId);
      if (payload.jobId) {
        if (payload.dueAt && payload.dueAt > Date.now())
          this.memoryDue.set(payload.jobId, { roomId: payload.roomId, dueAt: payload.dueAt });
        else {
          this.memoryDue.delete(payload.jobId);
          if (payload.dueAt && payload.pending !== true)
            await this.pushMemoryJob(payload.roomId);
        }
        this.scheduleMemoryDue();
      }
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
    const event: LiveEvent = {
      type: 'invalidate',
      roomId: payload.roomId,
      reason: `postgres:${payload.table}`,
      operation: payload.operation,
      ...(payload.messageId ? { messageId: payload.messageId } : {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      ...(payload.table === 'agent_commands' ? { targetAgentId: payload.agentId } : {}),
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
      ...(payload.lane ? { lane: payload.lane } : {}),
      ...(payload.laneChanged ? { laneChanged: true } : {}),
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
    // The parent's corner list reads a corner's status from these rows, but
    // their notifications name only the corner. One reason-only hint tells a
    // list watching the parent to re-read; nothing else acts on it.
    if (payload.cornerParentId) {
      this.live.publish({
        type: 'invalidate',
        roomId: payload.cornerParentId,
        reason: 'corner-status',
      });
    }
  }
}

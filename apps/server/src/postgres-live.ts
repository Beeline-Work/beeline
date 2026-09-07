import { Client } from 'pg';
import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';

export const POSTGRES_LIVE_CHANNEL = 'beeline_live_v1';

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
    WHEN 'live_outputs' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'turnId', COALESCE(NEW.turn_id, OLD.turn_id),
        'kind', COALESCE(NEW.kind, OLD.kind)
      );
    WHEN 'agent_turns' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.agent_id, OLD.agent_id),
        'requestId', COALESCE(NEW.request_id, OLD.request_id)
      );
    WHEN 'rooms' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.id, OLD.id)
      );
    WHEN 'memberships' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'identityId', COALESCE(NEW.identity_id, OLD.identity_id)
      );
    WHEN 'corner_facts' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.corner_id, OLD.corner_id),
        'cornerId', COALESCE(NEW.corner_id, OLD.corner_id)
      );
    WHEN 'corner_check_facts' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.corner_id, OLD.corner_id),
        'cornerId', COALESCE(NEW.corner_id, OLD.corner_id)
      );
    WHEN 'permission_authority' THEN
      payload = jsonb_build_object(
        'table', TG_TABLE_NAME, 'operation', TG_OP,
        'roomId', COALESCE(NEW.room_id, OLD.room_id),
        'agentId', COALESCE(NEW.principal_id, OLD.principal_id),
        'permissionId', COALESCE(NEW.permission_id, OLD.permission_id)
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
  END CASE;
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
    'corner_facts', 'corner_check_facts', 'permission_authority',
    'agent_grants', 'agent_schedules'
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
  agentId?: string;
  turnId?: string;
  kind?: string;
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
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
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
  private connectedOnce = false;

  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly clientFactory: LivePgClientFactory,
    private readonly retryDelayMs = 1_000,
  ) {}

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
        void this.rebroadcast(message.payload).catch((error) =>
          console.error('[live-listener] notification failed', error),
        );
      });
      client.on('error', (error) => {
        console.error('[live-listener] connection failed', error.message);
        disconnect();
      });
      client.on('end', disconnect);
      try {
        await client.connect();
        await client.query(`LISTEN ${POSTGRES_LIVE_CHANNEL}`);
        console.log('[live-listener] connected');
        if (this.connectedOnce) this.live.resync();
        this.connectedOnce = true;
        await disconnected;
      } catch (error) {
        console.error(
          '[live-listener] connect failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (this.active === client) this.active = undefined;
        await client.end().catch(() => undefined);
      }
      if (!this.stopped) await wait(this.retryDelayMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
      if (
        payload.kind === 'presence' &&
        (row.body.status === 'online' || row.body.status === 'offline') &&
        typeof row.body.observedAt === 'number'
      ) {
        this.live.publish({
          type: 'presence',
          roomId: payload.roomId,
          agentId: payload.agentId,
          status: row.body.status,
          observedAt: row.body.observedAt,
        });
      }
      return;
    }
    const event: LiveEvent = {
      type: 'invalidate',
      roomId: payload.roomId,
      reason: 'postgres',
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
    };
    this.live.publish(event);
  }
}

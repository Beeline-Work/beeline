import type { SqlDatabase } from './database.js';
import { pushDirectAttentionSql } from './push-attention.js';

/** Write-side indexes keep delivery reads on message primary keys. */
export const PUSH_OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_outbox (
  message_id text NOT NULL,
  device_token text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  not_before timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(message_id,device_token)
);
CREATE INDEX IF NOT EXISTS push_outbox_device_idx ON push_outbox(device_token);
CREATE INDEX IF NOT EXISTS push_outbox_due_idx ON push_outbox(not_before,message_id,device_token);
CREATE INDEX IF NOT EXISTS push_outbox_expiry_idx ON push_outbox(expires_at);
-- Retirement evidence is separate from claims: editing a message may enqueue it again.
CREATE TABLE IF NOT EXISTS push_outbox_retirements (
  message_id text NOT NULL,
  device_token text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  reason text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,device_token)
);
CREATE INDEX IF NOT EXISTS push_outbox_retirements_device_idx ON push_outbox_retirements(device_token);
CREATE INDEX IF NOT EXISTS push_outbox_retirements_time_idx ON push_outbox_retirements(retired_at);
CREATE TABLE IF NOT EXISTS push_message_context (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id text NOT NULL,
  request_id text,
  turn_ids text[] NOT NULL,
  burst_ids text[] NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS push_message_context_expiry_idx ON push_message_context(expires_at);
CREATE INDEX IF NOT EXISTS push_message_context_room_turn_idx
  ON push_message_context(room_id,author_id,request_id);
CREATE OR REPLACE FUNCTION enqueue_message_push(m messages) RETURNS void LANGUAGE plpgsql AS $$
DECLARE collected_turn_ids text[]; collected_burst_ids text[];
  interruption_time messages.created_at%TYPE; interruption_id text;
BEGIN
  IF m.created_at<now()-interval '1 hour' OR m.presentation='activity'
    OR m.deleted_at IS NOT NULL OR btrim(m.text)=''
    OR m.card_type IN ('agent-yolo','grant-auto','turn-failed','workspace-member-joined','agent-command')
    OR (m.card_type='relay' AND m.card->>'direction'='up')
    OR NOT EXISTS (SELECT 1 FROM push_devices LIMIT 1) THEN RETURN; END IF;
  -- Serialize turn context with other committed writes in this Room.
  PERFORM pg_advisory_xact_lock(hashtextextended('push-context:' || m.room_id::text,0));
  -- These history reads happen once on the write path, never in the worker.
  SELECT COALESCE(array_agg(part.id),ARRAY[]::text[]) INTO collected_turn_ids FROM messages part
    WHERE part.room_id=m.room_id AND part.author_id=m.author_id
      AND part.request_id=m.request_id AND m.request_id IS NOT NULL;
  SELECT interruption.created_at,interruption.id INTO interruption_time,interruption_id
    FROM messages interruption WHERE interruption.room_id=m.room_id
      AND interruption.author_id<>m.author_id AND interruption.presentation='message'
      AND interruption.created_at>=m.created_at-interval '20 seconds'
      AND (interruption.created_at,interruption.id)<(m.created_at,m.id)
    ORDER BY interruption.created_at DESC,interruption.id DESC LIMIT 1;
  SELECT COALESCE(array_agg(burst.id),ARRAY[]::text[]) INTO collected_burst_ids FROM messages burst
    WHERE burst.room_id=m.room_id AND burst.author_id=m.author_id
      AND burst.presentation='message' AND burst.deleted_at IS NULL
      AND burst.created_at>=m.created_at-interval '20 seconds'
      AND (burst.created_at,burst.id)<=(m.created_at,m.id)
      AND (interruption_time IS NULL OR (burst.created_at,burst.id)>(interruption_time,interruption_id));
  INSERT INTO push_message_context(message_id,room_id,author_id,request_id,turn_ids,burst_ids,expires_at)
    VALUES(m.id,m.room_id,m.author_id,m.request_id,collected_turn_ids,collected_burst_ids,m.created_at+interval '1 hour')
    ON CONFLICT(message_id) DO UPDATE SET room_id=EXCLUDED.room_id,author_id=EXCLUDED.author_id,
      request_id=EXCLUDED.request_id,turn_ids=EXCLUDED.turn_ids,burst_ids=EXCLUDED.burst_ids;
  UPDATE push_message_context context SET turn_ids=collected_turn_ids
    WHERE context.room_id=m.room_id AND context.author_id=m.author_id
      AND context.request_id=m.request_id AND context.message_id<>m.id;
  INSERT INTO push_outbox(message_id,device_token,expires_at)
    SELECT m.id,device.token,m.created_at+interval '1 hour'
    FROM effective_memberships member
    JOIN push_devices device ON device.identity_id=member.identity_id
      AND device.registered_at<=m.created_at
    JOIN push_delivery_floors floor ON floor.id='message-delivery' AND floor.started_at<=m.created_at
    JOIN identities recipient ON recipient.id=device.identity_id AND recipient.kind='human'
    JOIN rooms room ON room.id=m.room_id
    JOIN identities author ON author.id=m.author_id
    WHERE member.room_id=m.room_id AND member.removed_at IS NULL AND member.identity_id<>m.author_id
      -- Prose stays queued for an Attention/Off -> Full preference change.
      -- Other kinds need direct attention under every possible push level.
      AND ((m.presentation='message' AND m.card_type IS NULL)
        OR ${pushDirectAttentionSql('collected_turn_ids')})
    ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION message_push_outbox_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_message_push(NEW);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS message_push_outbox ON messages;
CREATE TRIGGER message_push_outbox AFTER INSERT OR UPDATE OF text,card,presentation,deleted_at,request_id ON messages
  FOR EACH ROW EXECUTE FUNCTION message_push_outbox_trigger();
CREATE OR REPLACE FUNCTION join_push_outbox_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO push_outbox(message_id,device_token,expires_at)
    SELECT notification.id,NEW.device_token,notification.created_at+interval '1 hour'
    FROM workspace_join_notifications notification
    WHERE notification.id=NEW.notification_id
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS join_push_outbox ON workspace_join_notification_devices;
CREATE TRIGGER join_push_outbox AFTER INSERT ON workspace_join_notification_devices
  FOR EACH ROW EXECUTE FUNCTION join_push_outbox_trigger();
-- Changing a deadline changes the durable queue deadline in the same transaction.
CREATE OR REPLACE FUNCTION retry_push_outbox_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='retryable' THEN
    UPDATE push_outbox SET not_before=NEW.next_retry_at
      WHERE message_id=NEW.message_id AND device_token=NEW.device_token;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS retry_push_outbox ON push_delivery_claims;
CREATE TRIGGER retry_push_outbox AFTER INSERT OR UPDATE OF next_retry_at ON push_delivery_claims
  FOR EACH ROW EXECUTE FUNCTION retry_push_outbox_trigger();
CREATE OR REPLACE FUNCTION person_push_outbox_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE push_outbox queue SET not_before=now() FROM push_devices device
    WHERE device.identity_id=NEW.id AND queue.device_token=device.token;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS person_push_outbox ON identities;
CREATE TRIGGER person_push_outbox AFTER UPDATE OF push_level ON identities
  FOR EACH ROW WHEN (OLD.push_level IS DISTINCT FROM NEW.push_level)
  EXECUTE FUNCTION person_push_outbox_trigger();
CREATE OR REPLACE FUNCTION turn_push_outbox_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE push_outbox queue SET not_before=now() FROM push_message_context context
    WHERE context.room_id=NEW.room_id AND context.author_id=NEW.agent_id
      AND context.request_id=NEW.request_id AND queue.message_id=context.message_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS turn_push_outbox ON agent_turns;
CREATE TRIGGER turn_push_outbox AFTER UPDATE OF status ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION turn_push_outbox_trigger();

`;

/** Idempotent migration-only catch-up; serving workers never scan history. */
export async function backfillPushOutbox(database: SqlDatabase): Promise<void> {
  const messages = await database.query<{ id: string }>(`
    SELECT id FROM messages WHERE created_at>=now()-interval '1 hour'
      AND presentation IS DISTINCT FROM 'activity' ORDER BY created_at,id
  `);
  for (let offset = 0; offset < messages.rows.length; offset += 100) {
    await database.query(`SELECT enqueue_message_push(message) FROM messages message
      WHERE id=ANY($1::text[])`, [messages.rows.slice(offset, offset + 100).map(row => row.id)]);
  }
  await database.query(`INSERT INTO push_outbox(message_id,device_token,expires_at)
    SELECT notification.id,device.device_token,notification.created_at+interval '1 hour'
    FROM workspace_join_notifications notification
    JOIN workspace_join_notification_devices device ON device.notification_id=notification.id
    WHERE notification.created_at>=now()-interval '1 hour' ON CONFLICT DO NOTHING`);
}

import { committedCommandNotificationSchema } from './postgres-live-notifications.js';

export const PENDING_ATTACHMENT_DUE_KEY = { principal: 'attachment', operation: 'retention', commandId: 'pending' } as const;

/** Private eligibility hints, committed with the existing queue and work rows. */
export const PENDING_ATTACHMENT_SOURCE_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE INDEX IF NOT EXISTS agent_pending_attachments_due_idx ON agent_pending_attachments(created_at,id);
CREATE INDEX IF NOT EXISTS agent_pending_attachments_room_due_idx ON agent_pending_attachments(room_id,created_at,id);
CREATE INDEX IF NOT EXISTS agent_pending_attachments_request_idx ON agent_pending_attachments(room_id,agent_id,request_id);
CREATE OR REPLACE FUNCTION beeline_pending_attachment_due_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'agent_pending_attachments' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.room_id,NEW.agent_id,NEW.request_id,NEW.created_at)
     IS NOT DISTINCT FROM ROW(OLD.room_id,OLD.agent_id,OLD.request_id,OLD.created_at) THEN RETURN NULL;END IF;
 WHEN 'rooms' THEN
   IF TG_OP<>'UPDATE' OR NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM agent_pending_attachments WHERE room_id=NEW.id) THEN RETURN NULL;END IF;
 WHEN 'agent_commands' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.room_id,NEW.agent_id,NEW.turn_request_id,
       NEW.action IN ('input','resume','restart') AND NEW.state IN ('pending','claimed'))
     IS NOT DISTINCT FROM ROW(OLD.room_id,OLD.agent_id,OLD.turn_request_id,
       OLD.action IN ('input','resume','restart') AND OLD.state IN ('pending','claimed')) THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM agent_pending_attachments WHERE
     (room_id=NEW.room_id AND agent_id=NEW.agent_id AND request_id=NEW.turn_request_id) OR
     (room_id=OLD.room_id AND agent_id=OLD.agent_id AND request_id=OLD.turn_request_id)) THEN RETURN NULL;END IF;
 WHEN 'agent_turns' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.room_id,NEW.agent_id,NEW.request_id,NEW.status='working')
     IS NOT DISTINCT FROM ROW(OLD.room_id,OLD.agent_id,OLD.request_id,OLD.status='working') THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM agent_pending_attachments WHERE
     (room_id=NEW.room_id AND agent_id=NEW.agent_id AND request_id=NEW.request_id) OR
     (room_id=OLD.room_id AND agent_id=OLD.agent_id AND request_id=OLD.request_id)) THEN RETURN NULL;END IF;
 END CASE;
 PERFORM beeline_notify_committed_command('${JSON.stringify(PENDING_ATTACHMENT_DUE_KEY)}');
 RETURN NULL;
END;
$$;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['agent_pending_attachments','rooms','agent_commands','agent_turns'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_pending_attachment_due ON %I',source);
   EXECUTE format('CREATE TRIGGER beeline_pending_attachment_due AFTER INSERT OR UPDATE OR DELETE ON %I
     FOR EACH ROW EXECUTE FUNCTION beeline_pending_attachment_due_change()',source);
 END LOOP;
END $$;
`;

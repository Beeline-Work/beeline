import { committedCommandNotificationSchema } from './postgres-live.js';
/** Fixed private queue hint on the existing completion channel. No phone fact. */
export const AGENT_SCHEDULE_DUE_KEY = { principal: 'schedule', operation: 'due', commandId: 'pending' } as const;
export const AGENT_SCHEDULE_SOURCE_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE INDEX IF NOT EXISTS agent_schedules_agent_idx ON agent_schedules(agent_id);
CREATE INDEX IF NOT EXISTS agent_schedules_creator_idx ON agent_schedules(creator_id);
CREATE OR REPLACE FUNCTION beeline_agent_schedule_due_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'agent_schedules' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.room_id,NEW.agent_id,NEW.creator_id,NEW.next_run_at,NEW.updated_at,NEW.cadence,NEW.message,NEW.max_runs,NEW.workflow_run,NEW.owner_id,NEW.workflow_slug,NEW.human_command_message_id)
     IS NOT DISTINCT FROM ROW(OLD.room_id,OLD.agent_id,OLD.creator_id,OLD.next_run_at,OLD.updated_at,OLD.cadence,OLD.message,OLD.max_runs,OLD.workflow_run,OLD.owner_id,OLD.workflow_slug,OLD.human_command_message_id)
     THEN RETURN NULL;END IF;
 WHEN 'rooms' THEN
   IF TG_OP<>'UPDATE' OR ROW(NEW.archived_at,NEW.parent_id) IS NOT DISTINCT FROM ROW(OLD.archived_at,OLD.parent_id) THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM agent_schedules WHERE room_id=NEW.id) THEN RETURN NULL;END IF;
 WHEN 'memberships' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.room_id,NEW.identity_id,NEW.removed_at)
     IS NOT DISTINCT FROM ROW(OLD.room_id,OLD.identity_id,OLD.removed_at) THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM agent_schedules WHERE
     ((room_id=NEW.room_id OR room_id IN(SELECT id FROM rooms WHERE parent_id=NEW.room_id))
       AND (agent_id=NEW.identity_id OR creator_id=NEW.identity_id)) OR
     ((room_id=OLD.room_id OR room_id IN(SELECT id FROM rooms WHERE parent_id=OLD.room_id))
       AND (agent_id=OLD.identity_id OR creator_id=OLD.identity_id))) THEN RETURN NULL;END IF;
 WHEN 'identities' THEN
   IF TG_OP<>'UPDATE' OR NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM agent_schedules WHERE agent_id=NEW.id OR creator_id=NEW.id) THEN RETURN NULL;END IF;
 END CASE;
 PERFORM beeline_notify_committed_command('${JSON.stringify(AGENT_SCHEDULE_DUE_KEY)}');
 RETURN NULL;
END;
$$;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['agent_schedules','rooms','memberships','identities'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_agent_schedule_due ON %I',source);
   EXECUTE format('CREATE TRIGGER beeline_agent_schedule_due AFTER INSERT OR UPDATE OR DELETE ON %I
     FOR EACH ROW EXECUTE FUNCTION beeline_agent_schedule_due_change()',source);
 END LOOP;
END $$;
`;

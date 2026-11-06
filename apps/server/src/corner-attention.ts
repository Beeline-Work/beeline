import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { notifyCornerStateSql } from './postgres-live.js';
import { humanReportCornerSql } from './corner-waiting-report.js';

export const CORNER_ATTENTION_SCHEMA = `
ALTER TABLE needs_you_marks ADD COLUMN IF NOT EXISTS reminder_dismissed_at timestamptz;
-- The retired attention triggers; their tables are dropped by the server schema.
DROP TRIGGER IF EXISTS corner_attention_command ON agent_commands;
DROP TRIGGER IF EXISTS corner_attention_turn ON agent_turns;
DROP TRIGGER IF EXISTS corner_attention_reminder_clear ON needs_you_marks;
DROP TRIGGER IF EXISTS corner_attention_head ON corner_facts;
DROP TRIGGER IF EXISTS corner_attention_open ON corner_facts;
DROP TRIGGER IF EXISTS corner_attention_human ON messages;
DROP TRIGGER IF EXISTS corner_state_turn ON agent_turns;
DROP TRIGGER IF EXISTS corner_state_facts ON corner_facts;
DROP TRIGGER IF EXISTS corner_state_report ON agent_commands;
DROP TRIGGER IF EXISTS corner_state_report ON messages;
DROP TRIGGER IF EXISTS corner_state_hold ON corner_merge_holds;
DROP TRIGGER IF EXISTS corner_state_owed ON corner_owed;
DROP TRIGGER IF EXISTS corner_state_schedule ON agent_schedules;
DROP FUNCTION IF EXISTS corner_attention_new_work();
DROP FUNCTION IF EXISTS corner_attention_dismiss_reminder();
DROP FUNCTION IF EXISTS corner_attention_push();
DROP FUNCTION IF EXISTS corner_attention_human();
DROP FUNCTION IF EXISTS corner_state_changed();

-- A turn's end is an execution fact, independent of corner attention.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS ended_at timestamptz;
CREATE OR REPLACE FUNCTION record_agent_turn_end() RETURNS trigger LANGUAGE plpgsql AS $turn$
BEGIN
  IF NEW.status='working' THEN NEW.ended_at=NULL;
  ELSIF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.ended_at=COALESCE(NEW.ended_at,clock_timestamp());
  END IF;
  RETURN NEW;
END $turn$;
DROP TRIGGER IF EXISTS record_agent_turn_end ON agent_turns;
CREATE TRIGGER record_agent_turn_end BEFORE INSERT OR UPDATE OF status ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION record_agent_turn_end();
-- Recover old terminal receipts from their durable completion, never migration time.
UPDATE agent_turns turn SET ended_at=COALESCE(
  (SELECT max(command.completed_at) FROM agent_commands command WHERE command.room_id=turn.room_id
    AND command.agent_id=turn.agent_id AND command.turn_request_id=turn.request_id),turn.created_at)
  WHERE turn.status<>'working' AND turn.ended_at IS NULL;

CREATE OR REPLACE FUNCTION notify_corner_activity() RETURNS trigger LANGUAGE plpgsql AS $state$
DECLARE corner uuid;
BEGIN
  IF TG_TABLE_NAME='agent_commands' THEN
    -- A worker's explicit report starts or answers a derived wait.
    IF NEW.private_payload->>'kind' IS DISTINCT FROM 'report' THEN RETURN NULL; END IF;
    SELECT id INTO corner FROM rooms WHERE id::text=NEW.private_payload->>'fromRoomId';
  ELSIF TG_TABLE_NAME IN ('agent_turns','agent_schedules','messages') THEN
    corner=COALESCE(NEW.room_id,OLD.room_id);
  ELSE corner=COALESCE(NEW.corner_id,OLD.corner_id); END IF;
  IF TG_TABLE_NAME='messages' THEN
   IF NEW.card->>'reportToId' IS NOT NULL OR COALESCE(NEW.card_type='agent-command'
     AND NEW.card->>'kind'='report' AND NEW.card->>'text' ~ '^(needs-decision|blocked):',false) THEN
    SELECT id INTO corner FROM rooms WHERE id::text=${humanReportCornerSql('NEW')};
   ELSIF TG_OP<>'INSERT' OR NOT (
    NEW.presentation='message' AND NEW.system_event IS NULL
    AND NEW.author_id<>'${SYSTEM_IDENTITY_ID}'
    AND EXISTS(SELECT 1 FROM identities WHERE id=NEW.author_id AND kind='human')) THEN RETURN NULL; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM rooms WHERE id=corner AND parent_id IS NOT NULL) THEN RETURN NULL; END IF;
  PERFORM ${notifyCornerStateSql('corner')};
  RETURN NULL;
END $state$;
DROP TRIGGER IF EXISTS corner_activity_human ON messages;
CREATE TRIGGER corner_activity_human AFTER INSERT OR UPDATE OF card,text,deleted_at ON messages
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
DROP TRIGGER IF EXISTS corner_activity_report ON agent_commands;
CREATE TRIGGER corner_activity_report AFTER INSERT OR UPDATE OF private_payload ON agent_commands
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
DROP TRIGGER IF EXISTS corner_activity_turn ON agent_turns;
CREATE TRIGGER corner_activity_turn AFTER INSERT OR UPDATE OF status OR DELETE ON agent_turns
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
DROP TRIGGER IF EXISTS corner_activity_facts ON corner_facts;
DROP TRIGGER IF EXISTS corner_activity_github ON corner_github_cache;
CREATE TRIGGER corner_activity_github AFTER INSERT OR UPDATE OF lifecycle ON corner_github_cache
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
DROP TRIGGER IF EXISTS corner_activity_hold ON corner_merge_holds;
CREATE TRIGGER corner_activity_hold AFTER INSERT OR UPDATE OR DELETE ON corner_merge_holds
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
DROP TRIGGER IF EXISTS corner_activity_owed ON corner_owed;
CREATE TRIGGER corner_activity_owed AFTER INSERT OR UPDATE OR DELETE ON corner_owed
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
DROP TRIGGER IF EXISTS corner_activity_schedule ON agent_schedules;
CREATE TRIGGER corner_activity_schedule AFTER INSERT OR UPDATE OR DELETE ON agent_schedules
 FOR EACH ROW EXECUTE FUNCTION notify_corner_activity();
`;

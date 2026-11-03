import { committedCommandNotificationSchema } from './postgres-live.js';
export const SENTRY_TRIAGE_ROOM = 'a914716f-cd6c-4663-b42a-6e1044dc2bb9';
export const sentryEligibilityKey = (principal: string) => ({ principal, operation: 'sentry-eligibility', commandId: SENTRY_TRIAGE_ROOM });
export const SENTRY_WAKE_SOURCE_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_sentry_eligibility_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sentry_wake_issues WHERE pending) THEN RETURN NULL;END IF;
 CASE TG_TABLE_NAME
 WHEN 'memberships' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.room_id,NEW.identity_id,NEW.removed_at)
     IS NOT DISTINCT FROM ROW(OLD.room_id,OLD.identity_id,OLD.removed_at) THEN RETURN NULL;END IF;
   IF NOT EXISTS(SELECT 1 FROM rooms WHERE id='${SENTRY_TRIAGE_ROOM}'
     AND (id IN(NEW.room_id,OLD.room_id) OR parent_id IN(NEW.room_id,OLD.room_id))) THEN RETURN NULL;END IF;
   FOR recipient IN SELECT DISTINCT identity_id FROM (VALUES(NEW.identity_id),(OLD.identity_id)) ids(identity_id)
     WHERE identity_id IS NOT NULL LOOP
     PERFORM beeline_notify_committed_command(jsonb_build_object('principal',recipient,
       'operation','sentry-eligibility','commandId','${SENTRY_TRIAGE_ROOM}')::text);
   END LOOP;
 WHEN 'identities' THEN
   IF TG_OP<>'UPDATE' OR NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NULL;END IF;
   PERFORM beeline_notify_committed_command(jsonb_build_object('principal',NEW.id,
     'operation','sentry-eligibility','commandId','${SENTRY_TRIAGE_ROOM}')::text);
 WHEN 'corner_owed' THEN
   -- Answering an explicit report can release createAgentCommand's wait gate.
   IF NOT (COALESCE(NEW.corner_id,OLD.corner_id)='${SENTRY_TRIAGE_ROOM}'
     AND (COALESCE(NEW.blocking,false) OR COALESCE(OLD.blocking,false))) THEN RETURN NULL;END IF;
   IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL;END IF;
   PERFORM beeline_notify_committed_command('${JSON.stringify(sentryEligibilityKey('sentry'))}');
 WHEN 'rooms' THEN
   IF COALESCE(NEW.id,OLD.id)<>'${SENTRY_TRIAGE_ROOM}' THEN RETURN NULL;END IF;
   IF TG_OP='UPDATE' AND ROW(NEW.archived_at,NEW.parent_id)
     IS NOT DISTINCT FROM ROW(OLD.archived_at,OLD.parent_id) THEN RETURN NULL;END IF;
   PERFORM beeline_notify_committed_command('${JSON.stringify(sentryEligibilityKey('sentry'))}');
 END CASE;
 RETURN NULL;
END;
$$;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['memberships','identities','rooms','corner_owed'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_sentry_eligibility ON %I',source);
   EXECUTE format('CREATE TRIGGER beeline_sentry_eligibility AFTER INSERT OR UPDATE OR DELETE ON %I
     FOR EACH ROW EXECUTE FUNCTION beeline_sentry_eligibility_change()',source);
 END LOOP;
END $$;
`;

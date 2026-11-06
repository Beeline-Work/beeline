import { committedCommandNotificationSchema } from './postgres-live.js';

/** Each key owns one business family, not the former catch-all repair tick. */
export const backgroundDueKey = (family: string) => ({ principal: 'background', operation: 'source', commandId: family });
// Source events deliver work once. No retention, repair or expiry clock exists.
export const BACKGROUND_DUE_SOURCE_SCHEMA = `
${committedCommandNotificationSchema()}
DO $$ DECLARE source record; BEGIN
 FOR source IN SELECT tgname,tgrelid::regclass AS relation FROM pg_trigger
   WHERE NOT tgisinternal AND tgfoid=to_regprocedure('beeline_background_source()')
 LOOP EXECUTE format('DROP TRIGGER %I ON %s',source.tgname,source.relation); END LOOP;
END $$;
CREATE OR REPLACE FUNCTION beeline_background_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='push_outbox' AND TG_OP='DELETE' THEN RETURN NULL; END IF;
 PERFORM beeline_notify_committed_command('${JSON.stringify(backgroundDueKey('push'))}');
 RETURN NULL;
END $$;
CREATE TRIGGER beeline_background_push AFTER INSERT OR UPDATE ON push_outbox
 FOR EACH ROW EXECUTE FUNCTION beeline_background_source();
CREATE TRIGGER beeline_background_read_clear AFTER INSERT OR UPDATE ON room_read_marks
 FOR EACH ROW EXECUTE FUNCTION beeline_background_source();
`;

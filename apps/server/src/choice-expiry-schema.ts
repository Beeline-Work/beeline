import { committedCommandNotificationSchema } from './postgres-live.js';
/** Only committed deadline/state changes wake the existing background owner. */
export const CHOICE_EXPIRY_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_choice_expiry_source() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.closes_at,NEW.status)
   IS NOT DISTINCT FROM ROW(OLD.closes_at,OLD.status) THEN RETURN NULL;END IF;
 PERFORM beeline_notify_committed_command('{"principal":"choice","operation":"expiry","commandId":"pending"}');
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_choice_expiry_source ON room_choices;
CREATE TRIGGER beeline_choice_expiry_source AFTER INSERT OR UPDATE OR DELETE ON room_choices
 FOR EACH ROW EXECUTE FUNCTION beeline_choice_expiry_source();
`;

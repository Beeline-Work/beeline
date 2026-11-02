/** Existing computer-session owner, existing completion feed. Only committed
 * lease/state changes can recompute its next actual expiry. */
export const COMPUTER_EXPIRY_SCHEMA=`
CREATE OR REPLACE FUNCTION beeline_computer_expiry_source() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.expires_at,NEW.status,NEW.source_session_id,NEW.upstream_url)
   IS NOT DISTINCT FROM ROW(OLD.expires_at,OLD.status,OLD.source_session_id,OLD.upstream_url) THEN RETURN NULL;END IF;
 PERFORM pg_notify('beeline_command_completion','{"principal":"computer","operation":"expiry","commandId":"pending"}');
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_computer_expiry_source ON computer_sessions;
CREATE TRIGGER beeline_computer_expiry_source AFTER INSERT OR UPDATE OR DELETE ON computer_sessions
 FOR EACH ROW EXECUTE FUNCTION beeline_computer_expiry_source();
`;

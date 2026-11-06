import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';

/** Shared membership writer lock protects current helper effects and the separately
 * authenticated MCP stream. Phone reads do not use epochs or certificates. */
export const MEMBERSHIP_AUTHORITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS router_authority (
  scope text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 1
);
CREATE OR REPLACE FUNCTION beeline_router_authority() RETURNS trigger AS $$
DECLARE item jsonb; previous jsonb; workspace text; person text; room text; affected_reader text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='memberships' THEN
      IF ROW(NEW.workspace_id,NEW.room_id,NEW.identity_id,NEW.role,NEW.removed_at)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.room_id,OLD.identity_id,OLD.role,OLD.removed_at) THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='rooms' THEN
      IF ROW(NEW.workspace_id,NEW.parent_id,NEW.archived_at)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.parent_id,OLD.archived_at) THEN RETURN NEW; END IF;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(
    jsonb_build_array(CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,
      CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END)) WHERE value IS NOT NULL AND value<>'null'::jsonb
  LOOP
    workspace := item->>'workspace_id'; person := item->>'identity_id';
    room := CASE WHEN TG_TABLE_NAME='rooms' THEN item->>'id' ELSE item->>'room_id' END;
    IF TG_TABLE_NAME='memberships' AND workspace IS NOT NULL AND person IS NOT NULL THEN
      IF room IS NULL THEN
        INSERT INTO router_authority(scope) VALUES('reader:'||person||':workspace:'||workspace)
        ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
      END IF;
    END IF;
    IF room IS NOT NULL THEN
      INSERT INTO router_authority(scope) VALUES('room:'||room)
      ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_router_authority ON memberships;
CREATE TRIGGER beeline_router_authority BEFORE INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION beeline_router_authority();
DROP TRIGGER IF EXISTS beeline_router_authority ON rooms;
CREATE TRIGGER beeline_router_authority BEFORE INSERT OR UPDATE OR DELETE ON rooms
FOR EACH ROW EXECUTE FUNCTION beeline_router_authority();
INSERT INTO router_authority(scope)
  SELECT DISTINCT 'reader:'||identity_id||':workspace:'||workspace_id FROM memberships ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope) SELECT 'room:'||id FROM rooms ON CONFLICT DO NOTHING;

`;

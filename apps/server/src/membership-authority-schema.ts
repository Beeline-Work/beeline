import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';

/** Atomic authority epochs invalidate prepared MCP deliveries. Phone reads
 * do not use epochs or certificates. */
export const MEMBERSHIP_AUTHORITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS router_authority (
  scope text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 1
);
CREATE OR REPLACE FUNCTION beeline_router_authority() RETURNS trigger AS $$
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
  -- Preceding serving readers need this writer fence until this release drains.
  PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
  INSERT INTO router_authority(scope,epoch)
    SELECT scope,count(*) FROM (
      SELECT CASE WHEN TG_TABLE_NAME='memberships' AND item->>'room_id' IS NULL
        THEN 'reader:'||(item->>'identity_id')||':workspace:'||(item->>'workspace_id')
        ELSE 'room:'||(CASE WHEN TG_TABLE_NAME='rooms' THEN item->>'id' ELSE item->>'room_id' END) END scope
      FROM (SELECT DISTINCT value item FROM jsonb_array_elements(
        jsonb_build_array(CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,
          CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END))
        WHERE value IS NOT NULL AND value<>'null'::jsonb) changed
    ) scopes WHERE scope IS NOT NULL GROUP BY scope ORDER BY scope
    ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+EXCLUDED.epoch;
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

import { liveControlNotificationSchema } from './postgres-live.js';
/** Schema is installed after postgresLiveSchema(). No read path creates rows.
 * Authority writers and final enqueue fences share one lock until scope-lock
 * concurrency has its own real PostgreSQL proof. This conservative lock never
 * covers DTO construction, providers, or socket backpressure waits. */
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
export const ROUTER_PROJECTION_SCHEMA = `
${liveControlNotificationSchema()}
CREATE TABLE IF NOT EXISTS router_authority (
  scope text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 1
);
CREATE OR REPLACE FUNCTION beeline_authority_hint(person text, logical_scope text, authority_scope text) RETURNS void AS $$
BEGIN
  IF person IS NULL OR logical_scope IS NULL OR authority_scope IS NULL THEN RETURN; END IF;
  PERFORM beeline_journal('authority:'||person,jsonb_build_object('kind','authority-change',
    'scope',logical_scope,'authorityScope',authority_scope));
  PERFORM beeline_notify_live_control(jsonb_build_object('table','router_authority','operation','UPDATE',
    'roomId','','journalStreams',jsonb_build_array('authority:'||person))::text);
END;
$$ LANGUAGE plpgsql;
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
      INSERT INTO router_authority(scope) VALUES('reader:'||person||':workspace:'||workspace||':visibility')
        ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
    ELSIF TG_TABLE_NAME='rooms' THEN
      FOR affected_reader IN SELECT DISTINCT identity_id FROM memberships
        WHERE room_id::text=room OR room_id::text=item->>'parent_id'
      LOOP
        INSERT INTO router_authority(scope) VALUES('reader:'||affected_reader||':workspace:'||workspace||':visibility')
          ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
      END LOOP;
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
CREATE OR REPLACE FUNCTION beeline_router_authority_capture() RETURNS trigger AS $$
DECLARE item jsonb; person text; room text; workspace text; parent text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='memberships' THEN
      IF ROW(NEW.workspace_id,NEW.room_id,NEW.identity_id,NEW.role,NEW.removed_at)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.room_id,OLD.identity_id,OLD.role,OLD.removed_at) THEN RETURN NEW; END IF;
    ELSE
      IF ROW(NEW.workspace_id,NEW.parent_id,NEW.archived_at)
        IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.parent_id,OLD.archived_at) THEN RETURN NEW; END IF;
    END IF;
  END IF;
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END))
    WHERE value IS NOT NULL AND value<>'null'::jsonb
  LOOP
    workspace:=item->>'workspace_id';
    IF TG_TABLE_NAME='memberships' THEN
      person:=item->>'identity_id';room:=item->>'room_id';
      PERFORM beeline_authority_hint(person,COALESCE(room,workspace),
        CASE WHEN room IS NULL THEN 'reader:'||person||':workspace:'||workspace ELSE 'room:'||room END);
      PERFORM beeline_authority_hint(person,workspace,'reader:'||person||':workspace:'||workspace||':visibility');
    ELSE
      room:=item->>'id';parent:=item->>'parent_id';
      FOR person IN SELECT DISTINCT identity_id FROM memberships
        WHERE room_id::text=room OR room_id::text=parent
      LOOP
        PERFORM beeline_authority_hint(person,room,'room:'||room);
        PERFORM beeline_authority_hint(person,workspace,'reader:'||person||':workspace:'||workspace||':visibility');
      END LOOP;
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_router_authority_capture ON memberships;
CREATE TRIGGER beeline_router_authority_capture AFTER INSERT OR UPDATE OR DELETE ON memberships
FOR EACH ROW EXECUTE FUNCTION beeline_router_authority_capture();
DROP TRIGGER IF EXISTS beeline_router_authority_capture ON rooms;
CREATE TRIGGER beeline_router_authority_capture AFTER INSERT OR UPDATE OR DELETE ON rooms
FOR EACH ROW EXECUTE FUNCTION beeline_router_authority_capture();
INSERT INTO router_authority(scope)
  SELECT DISTINCT 'reader:'||identity_id||':workspace:'||workspace_id FROM memberships
  ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope)
  SELECT DISTINCT 'reader:'||identity_id||':workspace:'||workspace_id||':visibility' FROM memberships
  ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope) SELECT 'room:'||id FROM rooms ON CONFLICT DO NOTHING;
INSERT INTO live_streams(id) SELECT 'workspace:'||id FROM workspaces ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION beeline_router_workspace_stream() RETURNS trigger AS $$
BEGIN
  INSERT INTO live_streams(id) VALUES('workspace:'||NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_router_workspace_stream ON workspaces;
CREATE TRIGGER beeline_router_workspace_stream AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION beeline_router_workspace_stream();
`;

/** Sources absent from the legacy Room journal still advance their canonical
 * Workspace stream. Payloads retain only dependency/deletion keys. */
export const ROUTER_EXTRA_CAPTURE_SCHEMA = `
${liveControlNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_router_extra_capture() RETURNS trigger AS $$
DECLARE item jsonb; affected text[] := ARRAY[]::text[]; target text; source_room text;
  person text; object_id text; streams text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP='UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='identities' AND TG_OP='UPDATE' THEN
    IF ROW(NEW.name,NEW.handle,NEW.avatar,NEW.face_id) IS NOT DISTINCT FROM ROW(OLD.name,OLD.handle,OLD.avatar,OLD.face_id)
      THEN RETURN NEW; END IF;
  END IF;
  FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END))
    WHERE value IS NOT NULL AND value<>'null'::jsonb
  LOOP
    IF item->>'workspace_id' IS NOT NULL THEN affected:=array_append(affected,item->>'workspace_id'); END IF;
    source_room:=item->>'room_id';
    IF source_room IS NOT NULL THEN
      affected:=affected || ARRAY(SELECT workspace_id::text FROM rooms WHERE id=source_room::uuid);
    END IF;
    IF TG_TABLE_NAME='identities' THEN
      person:=item->>'id';
      affected:=affected || ARRAY(SELECT workspace_id::text FROM memberships WHERE identity_id=person
        UNION SELECT room.workspace_id::text FROM messages message JOIN rooms room ON room.id=message.room_id WHERE message.author_id=person);
    END IF;
    IF TG_TABLE_NAME IN ('objects','object_expirations') THEN
      object_id:=item->>'id';
      affected:=affected || ARRAY(SELECT DISTINCT room.workspace_id::text FROM messages message
        JOIN rooms room ON room.id=message.room_id
        WHERE message.attachments::text LIKE '%'||object_id||'%');
    END IF;
  END LOOP;
  FOR target IN SELECT DISTINCT value FROM unnest(affected) value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM beeline_journal('workspace:'||target,jsonb_strip_nulls(jsonb_build_object(
      'type','invalidate','roomId','','reason','router-source','sourceTable',TG_TABLE_NAME,'operation',TG_OP,
      'sourceRoomId',source_room,'oldRoomId',to_jsonb(OLD)->>'room_id','newRoomId',to_jsonb(NEW)->>'room_id','identityId',COALESCE(to_jsonb(NEW)->>'identity_id',to_jsonb(OLD)->>'identity_id'),
      'recordId',COALESCE(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id'))));
    streams:=array_append(streams,'workspace:'||target);
  END LOOP;
  IF cardinality(streams)>0 THEN PERFORM beeline_notify_live_control(jsonb_build_object(
    'table','router_source','operation',TG_OP,'roomId','','journalStreams',streams)::text); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['identities','chat_dismissals','feedback_items','objects','object_expirations','voice_calls'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='beeline_router_capture_'||table_name AND NOT tgisinternal) THEN
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_router_extra_capture()',
        'beeline_router_capture_'||table_name,table_name);
    END IF;
  END LOOP;
END $$;
`;

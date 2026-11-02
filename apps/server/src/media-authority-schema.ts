import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';

/** Object bytes/version and committed references are authority dependencies.
 * All changes share the existing short final-fence lock; ordinary text-only
 * messages do not acquire it or write authority rows. */
export const MEDIA_AUTHORITY_SCHEMA = `
CREATE OR REPLACE FUNCTION beeline_media_authority() RETURNS trigger AS $$
DECLARE item jsonb; file jsonb; address text; match text[]; scopes text[]:=ARRAY[]::text[]; target text; person text; object_id uuid;
BEGIN
  IF TG_TABLE_NAME='objects' THEN
    IF TG_OP='UPDATE' THEN
      IF ROW(NEW.owner_id,NEW.key,NEW.sha256,NEW.mime,NEW.size,NEW.state,NEW.expires_at)
        IS NOT DISTINCT FROM ROW(OLD.owner_id,OLD.key,OLD.sha256,OLD.mime,OLD.size,OLD.state,OLD.expires_at) THEN RETURN NEW; END IF;
    END IF;
    scopes:=ARRAY['object:'||COALESCE(NEW.id,OLD.id)::text];
  ELSIF TG_TABLE_NAME='object_expirations' THEN
    IF TG_OP='UPDATE' THEN
      IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NEW; END IF;
    END IF;
    scopes:=ARRAY['object:'||COALESCE(NEW.id,OLD.id)::text];
  ELSE
    -- A regrant advances the epoch too: an earlier denied epoch must never
    -- suppress freshly authorized metadata at the same generation.
    IF TG_OP='UPDATE' THEN
      IF ROW(NEW.attachments,NEW.deleted_at) IS NOT DISTINCT FROM ROW(OLD.attachments,OLD.deleted_at) THEN RETURN NEW; END IF;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
      CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW)->'attachments' END,
      CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD)->'attachments' END)) WHERE jsonb_typeof(value)='array'
    LOOP
      FOR file IN SELECT value FROM jsonb_array_elements(item) LOOP
        FOREACH address IN ARRAY ARRAY[file->>'url',file->>'previewUrl',file->>'thumbnailUrl'] LOOP
          match:=regexp_match(address,'/v1/media/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?].*)?$');
          IF match IS NOT NULL THEN scopes:=array_append(scopes,'object:'||lower(match[1])); END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;
  IF cardinality(scopes)>0 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
    FOR target IN SELECT DISTINCT value FROM unnest(scopes) value ORDER BY value LOOP
      INSERT INTO router_authority(scope) VALUES(target) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
      object_id:=substring(target FROM length('object:')+1)::uuid;
      -- Audience comes from current DB references plus the old/new owner.
      -- BEFORE timing retains removed references and former-owner audience.
      FOR person IN
        SELECT owner_id FROM objects WHERE id=object_id
        UNION SELECT CASE WHEN TG_TABLE_NAME='objects' AND TG_OP<>'INSERT' THEN to_jsonb(OLD)->>'owner_id' END
        UNION SELECT CASE WHEN TG_TABLE_NAME='objects' AND TG_OP<>'DELETE' THEN to_jsonb(NEW)->>'owner_id' END
        UNION SELECT access.identity_id FROM messages message JOIN room_access access ON access.room_id=message.room_id
          WHERE access.removed_at IS NULL AND message.deleted_at IS NULL AND message.attachments::text LIKE '%'||object_id::text||'%'
      LOOP
        IF person IS NOT NULL THEN PERFORM beeline_authority_hint(person,object_id::text,target); END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_media_authority ON objects;
CREATE TRIGGER beeline_media_authority BEFORE INSERT OR UPDATE OR DELETE ON objects
FOR EACH ROW EXECUTE FUNCTION beeline_media_authority();
DROP TRIGGER IF EXISTS beeline_media_authority ON object_expirations;
CREATE TRIGGER beeline_media_authority BEFORE INSERT OR UPDATE OR DELETE ON object_expirations
FOR EACH ROW EXECUTE FUNCTION beeline_media_authority();
DROP TRIGGER IF EXISTS beeline_media_authority ON messages;
CREATE TRIGGER beeline_media_authority BEFORE INSERT OR UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION beeline_media_authority();
INSERT INTO router_authority(scope) SELECT 'object:'||id FROM objects UNION SELECT 'object:'||id FROM object_expirations ON CONFLICT DO NOTHING;
`;

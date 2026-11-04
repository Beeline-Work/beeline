import { liveControlNotificationSchema } from './postgres-live.js';
import { readTraySavedTargets, type TraySavedTarget } from './tray-saved-projection.js';

const TABLES=['messages','identities','rooms','memberships'] as const;
type Table=typeof TABLES[number];
type Common={readonly sourceTable:'tray-saved-source';readonly trayReaderId:string;readonly trayWorkspaceId:string;
  readonly table:Table;readonly operation:'INSERT'|'UPDATE'|'DELETE'};
export type TraySavedSourceCause=Common&({readonly classification:'complete';readonly targets:readonly TraySavedTarget[]}|
  {readonly classification:'unavailable';readonly reason:'budget'});
export function readTraySavedSourceCause(value:Record<string,unknown>):TraySavedSourceCause|undefined{
  const common=['sourceTable','trayReaderId','trayWorkspaceId','table','operation','classification'];
  if(value.sourceTable!=='tray-saved-source'||typeof value.trayReaderId!=='string'||!value.trayReaderId||value.trayReaderId.length>128||
    typeof value.trayWorkspaceId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.trayWorkspaceId)||
    !(TABLES as readonly unknown[]).includes(value.table)||!['INSERT','UPDATE','DELETE'].includes(String(value.operation)))return;
  if(value.classification==='complete'&&Object.keys(value).length===common.length+1&&
    Object.keys(value).every(key=>[...common,'targets'].includes(key))&&readTraySavedTargets(value.targets))return value as TraySavedSourceCause;
  if(value.classification==='unavailable'&&value.reason==='budget'&&Object.keys(value).length===common.length+1&&
    Object.keys(value).every(key=>[...common,'reason'].includes(key)))return value as TraySavedSourceCause;
}

const member=`EXISTS(SELECT 1 FROM rooms surface
 JOIN memberships room_member ON room_member.room_id=COALESCE(surface.parent_id,surface.id)
   AND room_member.identity_id=bookmark.identity_id AND room_member.removed_at IS NULL
 JOIN memberships workspace_member ON workspace_member.workspace_id=bookmark.workspace_id AND workspace_member.room_id IS NULL
   AND workspace_member.identity_id=bookmark.identity_id AND workspace_member.removed_at IS NULL
 WHERE surface.id=bookmark.room_id AND surface.workspace_id=bookmark.workspace_id)`;
const workspaceMember=`EXISTS(SELECT 1 FROM memberships workspace_member WHERE workspace_member.workspace_id=bookmark.workspace_id
 AND workspace_member.room_id IS NULL AND workspace_member.identity_id=bookmark.identity_id AND workspace_member.removed_at IS NULL)`;

/** Release-installed exact content/access dependencies for sealed Saved rows,
 * after immutable bookmark metadata and the closed source-plan adapter.
 * No page/held-key inventory, top-N query, provider, deadline or authority epoch
 * write occurs here. Reader targets derive solely from actual private bookmarks.
 * Room archive/identity hidden/usage/member role are not read by Saved's current
 * canonical query, so these hooks do not invent those dependencies. */
export const TRAY_SAVED_SOURCE_SCHEMA=`
${liveControlNotificationSchema()}
CREATE INDEX IF NOT EXISTS message_bookmarks_source_message_idx ON message_bookmarks(message_id);
CREATE INDEX IF NOT EXISTS message_bookmarks_source_room_reader_idx ON message_bookmarks(room_id,identity_id);
CREATE INDEX IF NOT EXISTS messages_saved_author_idx ON messages(author_id,id) WHERE deleted_at IS NULL;
CREATE OR REPLACE FUNCTION beeline_saved_source_targets(source_name text,prior jsonb,item jsonb)
RETURNS TABLE(workspace_id uuid,reader_id text,bookmark_id uuid,message_id text) LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF source_name='messages' THEN
 RETURN QUERY SELECT DISTINCT bookmark.workspace_id,bookmark.identity_id,bookmark.bookmark_id,bookmark.message_id
 FROM message_bookmarks bookmark WHERE bookmark.message_id IN (prior->>'id',item->>'id') AND ${member} AND EXISTS(
   SELECT 1 FROM jsonb_array_elements(jsonb_build_array(prior,item)) image
   WHERE image->>'id'=bookmark.message_id AND image->>'room_id'=bookmark.room_id::text
     AND (image->'deleted_at' IS NULL OR image->'deleted_at'='null'::jsonb));
 ELSIF source_name='identities' THEN
 RETURN QUERY SELECT DISTINCT bookmark.workspace_id,bookmark.identity_id,bookmark.bookmark_id,bookmark.message_id
 FROM messages message JOIN message_bookmarks bookmark ON bookmark.message_id=message.id AND bookmark.room_id=message.room_id
 WHERE message.author_id IN (prior->>'id',item->>'id') AND message.deleted_at IS NULL AND ${member};
 ELSIF source_name='rooms' THEN
 RETURN QUERY SELECT DISTINCT bookmark.workspace_id,bookmark.identity_id,bookmark.bookmark_id,bookmark.message_id
 FROM message_bookmarks bookmark WHERE (bookmark.room_id IN ((prior->>'id')::uuid,(item->>'id')::uuid)
   OR (item IS NULL OR prior->>'id' IS DISTINCT FROM item->>'id') AND bookmark.room_id IN (SELECT child.id FROM rooms child WHERE child.parent_id=(prior->>'id')::uuid))
 AND ${workspaceMember} AND (
   EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(prior,item)) image
     WHERE image->>'id'=bookmark.room_id::text AND image->>'workspace_id'=bookmark.workspace_id::text
       AND EXISTS(SELECT 1 FROM memberships member
         WHERE member.room_id=COALESCE((image->>'parent_id')::uuid,(image->>'id')::uuid)
           AND member.identity_id=bookmark.identity_id AND member.removed_at IS NULL))
   OR ((item IS NULL OR prior->>'id' IS DISTINCT FROM item->>'id') AND ${member}
     AND EXISTS(SELECT 1 FROM rooms child WHERE child.id=bookmark.room_id AND child.parent_id::text=prior->>'id')));
 ELSIF source_name='memberships' THEN
 RETURN QUERY SELECT DISTINCT bookmark.workspace_id,bookmark.identity_id,bookmark.bookmark_id,bookmark.message_id
 FROM message_bookmarks bookmark WHERE bookmark.identity_id IN (prior->>'identity_id',item->>'identity_id') AND
 EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(prior,item)) image
   WHERE image->>'identity_id'=bookmark.identity_id AND (image->'removed_at' IS NULL OR image->'removed_at'='null'::jsonb)
   AND CASE WHEN image->>'room_id' IS NULL THEN image->>'workspace_id'=bookmark.workspace_id::text
     ELSE ${workspaceMember} AND EXISTS(SELECT 1 FROM rooms surface WHERE surface.id=bookmark.room_id
       AND surface.workspace_id=bookmark.workspace_id AND COALESCE(surface.parent_id,surface.id)::text=image->>'room_id') END);
 ELSE RAISE EXCEPTION 'unknown Saved source';END IF;
END;
$$;

CREATE OR REPLACE FUNCTION beeline_saved_source_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb;item jsonb;fields text[];audience record;body jsonb;notified uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN prior:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN item:=to_jsonb(NEW);END IF;
 CASE TG_TABLE_NAME
 WHEN 'messages' THEN fields:=ARRAY['id','room_id','author_id','text','deleted_at'];
 WHEN 'identities' THEN fields:=ARRAY['id','kind','name','handle','avatar','face_id'];
 WHEN 'rooms' THEN fields:=ARRAY['id','workspace_id','parent_id','name'];
 WHEN 'memberships' THEN
   IF TG_OP='UPDATE' AND ROW(OLD.identity_id,OLD.room_id,OLD.removed_at IS NULL,
       CASE WHEN OLD.room_id IS NULL THEN OLD.workspace_id END) IS NOT DISTINCT FROM
     ROW(NEW.identity_id,NEW.room_id,NEW.removed_at IS NULL,CASE WHEN NEW.room_id IS NULL THEN NEW.workspace_id END) THEN RETURN NEW;END IF;
   fields:=ARRAY['identity_id','room_id','removed_at','workspace_id'];
 ELSE RAISE EXCEPTION 'unknown Saved source';
 END CASE;
 IF TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM unnest(fields) field WHERE prior->field IS DISTINCT FROM item->field) THEN RETURN NEW;END IF;
 -- BEFORE sees OLD identities/parents before FK side effects. Both images
 -- describe new message/member eligibility without a second post-write scan.
 FOR audience IN WITH candidates AS MATERIALIZED (
     SELECT * FROM beeline_saved_source_targets(TG_TABLE_NAME,prior,item)
   ), ranked AS (
     SELECT *,row_number() OVER(PARTITION BY workspace_id,reader_id ORDER BY bookmark_id) position FROM candidates
   ) SELECT workspace_id,reader_id,jsonb_agg(jsonb_build_object('bookmarkId',bookmark_id,'messageId',message_id) ORDER BY bookmark_id) targets
     FROM ranked GROUP BY workspace_id,reader_id ORDER BY workspace_id,reader_id
 LOOP
   body:=jsonb_build_object('sourceTable','tray-saved-source','trayReaderId',audience.reader_id,
     'trayWorkspaceId',audience.workspace_id,'table',TG_TABLE_NAME,'operation',TG_OP);
   body:=body||jsonb_build_object('classification','complete','targets',audience.targets);
   PERFORM beeline_journal('workspace:'||audience.workspace_id,body);
   IF notified IS DISTINCT FROM audience.workspace_id THEN
     PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
       'journalStreams',jsonb_build_array('workspace:'||audience.workspace_id))::text);notified:=audience.workspace_id;
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
DO $$ DECLARE source_name text;BEGIN
 FOREACH source_name IN ARRAY ARRAY['messages','identities','rooms','memberships'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_saved_source_before ON %I',source_name);
   EXECUTE format('CREATE TRIGGER beeline_saved_source_before BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION beeline_saved_source_capture()',source_name);
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_saved_source_insert ON %I',source_name);
   EXECUTE format('CREATE TRIGGER beeline_saved_source_insert AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION beeline_saved_source_capture()',source_name);
 END LOOP;
END $$;
`;

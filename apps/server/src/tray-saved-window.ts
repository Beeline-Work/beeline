import { createHash } from 'node:crypto';
import type { SavedRow, SavedWindow } from '@beeline/api-contract/router-protocol';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { liveControlNotificationSchema } from './postgres-live-notifications.js';

const VERSION=1, PAGE=30, MAX_BYTES=64*1024;
/** Bound DB result bytes before assembling a 30-row page or exact-row facts.
 * PostgreSQL left counts Unicode characters, never splitting a codepoint.
 * Each SQL text is at most 1024 UTF-8 bytes; previewText additionally bounds
 * JSON escaping and the visible ellipsis to 1024 encoded bytes. */
export const SAVED_TEXT_COLUMNS_SQL=`
  CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN left(message.text,256) END text,
  CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL
    THEN char_length(left(message.text,257))>256 ELSE false END text_truncated`;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const scalar=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128;
const message=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const micros=(value:unknown):value is string=>typeof value==='string'&&/^-?(0|[1-9][0-9]{0,18})$/.test(value)&&value!=='-0'&&
  BigInt(value)>=-9223372036854775808n&&BigInt(value)<=9223372036854775807n;
const order=(value:unknown):value is string=>{
  if(typeof value!=='string')return false;const pair=value.split(',');return pair.length===2&&micros(pair[0])&&message(pair[1]);
};
export type TraySavedScope=Readonly<{workspaceId:string;readerId:string}>;
export type TraySavedAnchor=Readonly<{bookmarkedUs:string;messageId:string;bookmarkId:string}>;
export type IdentityFormatter=(row:{id:string;kind:'human'|'agent';name:string;handle:string|null;avatar:string|null;face_id:string|null})=>RoomViewIdentity;

function validScope(scope:TraySavedScope){if(!uuid(scope.workspaceId)||!scalar(scope.readerId))throw new Error('invalid_saved_scope');}
function cursor(scope:TraySavedScope,anchor:TraySavedAnchor):string{
  return `saved1.${Buffer.from(JSON.stringify([VERSION,scope.workspaceId.toLowerCase(),scope.readerId,
    anchor.bookmarkedUs,anchor.messageId,anchor.bookmarkId.toLowerCase()])).toString('base64url')}`;
}
/** A cursor carries only ordinary query basis. Authorization is always checked
 * against the authenticated reader/current DB state; no token is a permission.
 * Deleted/replaced anchors remain valid points. Incarnation distinguishes cache
 * window identities after A→B→A without retargeting an old cursor to a new row. */
export function readTraySavedCursor(value:string,scope:TraySavedScope):TraySavedAnchor{
  validScope(scope);
  if(typeof value!=='string'||value.length>1024||!/^saved1\.[a-zA-Z0-9_-]+$/.test(value))throw new Error('invalid_saved_cursor');
  try{
    const body=value.slice(7),decoded=Buffer.from(body,'base64url');
    if(decoded.toString('base64url')!==body)throw new Error();
    const fields:unknown=JSON.parse(decoded.toString('utf8'));
    if(!Array.isArray(fields)||fields.length!==6||fields[0]!==VERSION||fields[1]!==scope.workspaceId.toLowerCase()||fields[2]!==scope.readerId||
      !micros(fields[3])||!message(fields[4])||!uuid(fields[5])||fields[5]!==fields[5].toLowerCase())throw new Error();
    const anchor=Object.freeze({bookmarkedUs:fields[3],messageId:fields[4],bookmarkId:fields[5]});
    if(cursor(scope,anchor)!==value)throw new Error();return anchor;
  }catch{throw new Error('invalid_saved_cursor');}
}

export type TraySavedWindowCause=Readonly<{
  sourceTable:'tray-saved-window';trayReaderId:string;trayWorkspaceId:string;operation:'INSERT'|'UPDATE'|'DELETE';
  oldBookmarkId?:string;newBookmarkId?:string;oldReaderId?:string;newReaderId?:string;
  oldWorkspaceId?:string;newWorkspaceId?:string;oldRoomId?:string;newRoomId?:string;
  oldMessageId?:string;newMessageId?:string;oldOrder?:string;newOrder?:string;
}>;
const optional=['oldBookmarkId','newBookmarkId','oldReaderId','newReaderId','oldWorkspaceId','newWorkspaceId',
  'oldRoomId','newRoomId','oldMessageId','newMessageId','oldOrder','newOrder'] as const;
export function readTraySavedWindowCause(value:Record<string,unknown>):TraySavedWindowCause|undefined{
  if(value.sourceTable!=='tray-saved-window'||!scalar(value.trayReaderId)||!uuid(value.trayWorkspaceId)||
    !['INSERT','UPDATE','DELETE'].includes(String(value.operation))||
    optional.some(key=>value[key]!==undefined&&(key.endsWith('Order')?!order(value[key]):
      key.includes('Bookmark')||key.includes('Workspace')||key.includes('Room')?!uuid(value[key]):key.includes('Message')?!message(value[key]):!scalar(value[key])))||
    Object.keys(value).some(key=>!['sourceTable','trayReaderId','trayWorkspaceId','operation',...optional].includes(key)))return;
  for(const side of ['old','new']){
    const expected=value.operation==='UPDATE'||value.operation===(side==='old'?'DELETE':'INSERT');
    if(optional.filter(key=>key.startsWith(side)).some(key=>expected?value[key]===undefined:value[key]!==undefined))return;
    if(expected&&(value[`${side}Order`] as string).split(',')[1]!==value[`${side}MessageId`])return;
  }
  if(!(value.oldReaderId===value.trayReaderId&&value.oldWorkspaceId===value.trayWorkspaceId||
    value.newReaderId===value.trayReaderId&&value.newWorkspaceId===value.trayWorkspaceId))return;
  return value as TraySavedWindowCause;
}

/** Uninstalled additive metadata. BEFORE INSERT always owns the UUID, including
 * explicit/reused caller values and old-writer upserts. UPDATE of identity or
 * order creates a fresh UUID; display edits keep it, standalone UUID rewriting
 * is refused. No retained bookmark history or epoch-as-invalidation writes.
 * Existing legacy readers ignore the column and retain their exact behavior. */
export const TRAY_SAVED_WINDOW_SCHEMA=`
${liveControlNotificationSchema()}
ALTER TABLE message_bookmarks ADD COLUMN IF NOT EXISTS bookmark_id uuid;
-- An old writer can insert between release DDL statements, including while an
-- existing identity trigger is being replaced. Keep that write valid throughout.
ALTER TABLE message_bookmarks ALTER COLUMN bookmark_id SET DEFAULT gen_random_uuid();
UPDATE message_bookmarks SET bookmark_id=gen_random_uuid() WHERE bookmark_id IS NULL;
ALTER TABLE message_bookmarks ALTER COLUMN bookmark_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS message_bookmarks_incarnation_idx ON message_bookmarks(bookmark_id);
CREATE OR REPLACE FUNCTION beeline_saved_window_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.bookmark_id:=gen_random_uuid();RETURN NEW;END IF;
 IF ROW(OLD.identity_id,OLD.workspace_id,OLD.room_id,OLD.message_id,OLD.created_at)
   IS DISTINCT FROM ROW(NEW.identity_id,NEW.workspace_id,NEW.room_id,NEW.message_id,NEW.created_at) THEN
   NEW.bookmark_id:=gen_random_uuid();
 ELSIF NEW.bookmark_id IS DISTINCT FROM OLD.bookmark_id THEN
   RAISE EXCEPTION 'bookmark incarnation is server owned' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS beeline_saved_window_identity ON message_bookmarks;
CREATE TRIGGER beeline_saved_window_identity BEFORE INSERT OR UPDATE ON message_bookmarks
 FOR EACH ROW EXECUTE FUNCTION beeline_saved_window_identity();
CREATE OR REPLACE FUNCTION beeline_saved_window_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb;current_row jsonb;audience record;cause jsonb;notified uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN prior:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN current_row:=to_jsonb(NEW);END IF;
 IF TG_OP='UPDATE' AND ROW(OLD.identity_id,OLD.workspace_id,OLD.room_id,OLD.message_id,OLD.created_at,OLD.bookmark_id,
   OLD.source_room_name,OLD.source_room_kind,OLD.message_created_at) IS NOT DISTINCT FROM
   ROW(NEW.identity_id,NEW.workspace_id,NEW.room_id,NEW.message_id,NEW.created_at,NEW.bookmark_id,
   NEW.source_room_name,NEW.source_room_kind,NEW.message_created_at) THEN RETURN NEW;END IF;
 FOR audience IN SELECT DISTINCT (item->>'workspace_id')::uuid workspace_id,item->>'identity_id' reader_id
   FROM jsonb_array_elements(jsonb_build_array(prior,current_row)) item WHERE item IS NOT NULL AND item<>'null'::jsonb
   ORDER BY workspace_id,reader_id LOOP
   cause:=jsonb_strip_nulls(jsonb_build_object('sourceTable','tray-saved-window','trayReaderId',audience.reader_id,
     'trayWorkspaceId',audience.workspace_id,'operation',TG_OP,
     'oldBookmarkId',prior->>'bookmark_id','newBookmarkId',current_row->>'bookmark_id',
     'oldReaderId',prior->>'identity_id','newReaderId',current_row->>'identity_id',
     'oldWorkspaceId',prior->>'workspace_id','newWorkspaceId',current_row->>'workspace_id',
     'oldRoomId',prior->>'room_id','newRoomId',current_row->>'room_id',
     'oldMessageId',prior->>'message_id','newMessageId',current_row->>'message_id',
     'oldOrder',CASE WHEN prior IS NOT NULL THEN ((extract(epoch FROM (prior->>'created_at')::timestamptz)*1000000)::bigint)::text||','||(prior->>'message_id') END,
     'newOrder',CASE WHEN current_row IS NOT NULL THEN ((extract(epoch FROM (current_row->>'created_at')::timestamptz)*1000000)::bigint)::text||','||(current_row->>'message_id') END));
   PERFORM beeline_journal('workspace:'||audience.workspace_id,cause);
   IF notified IS DISTINCT FROM audience.workspace_id THEN
     PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation',TG_OP,'roomId','',
       'journalStreams',jsonb_build_array('workspace:'||audience.workspace_id))::text);notified:=audience.workspace_id;
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS beeline_saved_window_capture ON message_bookmarks;
CREATE TRIGGER beeline_saved_window_capture AFTER INSERT OR UPDATE OR DELETE ON message_bookmarks
 FOR EACH ROW EXECUTE FUNCTION beeline_saved_window_capture();
`;

export type BookmarkRow={bookmark_id:string;message_id:string;workspace_id:string;room_id:string;room_name:string;room_kind:'room'|'corner';
  message_created_at:Date|string;bookmarked_at:Date|string;bookmarked_us:string;available:boolean;text:string|null;text_truncated?:boolean|null;
  author_id:string|null;author_kind:'human'|'agent'|null;author_name:string|null;author_handle:string|null;author_avatar:string|null;author_face:string|null};
const unix=(value:Date|string)=>Math.floor((typeof value==='string'?new Date(value):value).getTime()/1000);
/** The SQL prefix is bounded already. Only escaped/multibyte previews need
 * this bounded binary search; no full message or extra read reaches it. */
function previewText(text:string,truncated:boolean):{text:string;textTruncated?:true}{
  const displayed=text+(truncated?'…':'');
  if(Buffer.byteLength(JSON.stringify(displayed))<=1024)return{text:displayed,...(truncated?{textTruncated:true as const}:{})};
  const points=[...text];let low=0,high=points.length;
  while(low<high){
    const middle=Math.ceil((low+high)/2);
    if(Buffer.byteLength(JSON.stringify(points.slice(0,middle).join('')+'…'))<=1024)low=middle;
    else high=middle-1;
  }
  return{text:points.slice(0,low).join('')+'…',textTruncated:true};
}
/** Shared complete server DTO projection for a window and source-key row facts. */
export function projectTraySavedRow(row:BookmarkRow,scope:TraySavedScope,toIdentity:IdentityFormatter):SavedRow{
  if(!uuid(row.bookmark_id)||!micros(row.bookmarked_us)||!message(row.message_id))throw new Error('invalid_saved_row');
  const before=cursor(scope,{bookmarkedUs:row.bookmarked_us,messageId:row.message_id,bookmarkId:row.bookmark_id});
  return{bookmarkId:row.bookmark_id,order:`${row.bookmarked_us},${row.message_id}`,before,value:{
    messageId:row.message_id,workspaceId:row.workspace_id,roomId:row.room_id,roomName:row.room_name,roomKind:row.room_kind,
    messageCreatedAt:unix(row.message_created_at),bookmarkedAt:unix(row.bookmarked_at),available:row.available,
    ...(row.available&&row.text!==null?previewText(row.text,row.text_truncated===true):{}),
    ...(row.available&&row.author_id&&row.author_kind&&row.author_name?{author:toIdentity({id:row.author_id,kind:row.author_kind,name:row.author_name,
      handle:row.author_handle,avatar:row.author_avatar,face_id:row.author_face})}:{}),
  }};
}

/** Pure query only. The caller must supply its read-only RR handle and later
 * perform the shared final current-authority/cut fence. This result alone does
 * not claim canonical coverage, clock consistency or snapshot authorization. */
export async function readTraySavedWindow(db:SqlDatabase,input:Readonly<{workspaceId:string;before?:string}>,
  readerId:string,toIdentity:IdentityFormatter):Promise<SavedWindow>{
  const scope={workspaceId:input.workspaceId.toLowerCase(),readerId};validScope(scope);
  const anchor=input.before===undefined?undefined:readTraySavedCursor(input.before,scope);
  const rows=(await db.query<{bookmarks:BookmarkRow[]}>(`WITH authorized AS (
    SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL
  ), page AS (
    SELECT bookmark.bookmark_id,bookmark.message_id,bookmark.workspace_id,bookmark.room_id,
      CASE WHEN room_member.identity_id IS NOT NULL THEN COALESCE(room.name,bookmark.source_room_name) ELSE bookmark.source_room_name END room_name,
      bookmark.source_room_kind room_kind,
      bookmark.message_created_at,bookmark.created_at bookmarked_at,
      (extract(epoch FROM bookmark.created_at)*1000000)::bigint::text bookmarked_us,
      (message.id IS NOT NULL AND message.deleted_at IS NULL AND room.id IS NOT NULL AND room_member.identity_id IS NOT NULL) available,
      ${SAVED_TEXT_COLUMNS_SQL},
      CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.id END author_id,
      CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.kind END author_kind,
      CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.name END author_name,
      CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.handle END author_handle,
      CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.avatar END author_avatar,
      CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.face_id END author_face
    FROM message_bookmarks bookmark
    LEFT JOIN rooms room ON room.id=bookmark.room_id AND room.workspace_id=bookmark.workspace_id
    LEFT JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id) AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
    LEFT JOIN messages message ON message.id=bookmark.message_id AND message.room_id=room.id
    LEFT JOIN identities author ON author.id=message.author_id
    WHERE bookmark.workspace_id=$1 AND bookmark.identity_id=$2
      ${anchor?'AND ((extract(epoch FROM bookmark.created_at)*1000000)::bigint < $3::bigint OR ((extract(epoch FROM bookmark.created_at)*1000000)::bigint=$3::bigint AND bookmark.message_id>$4))':''}
    ORDER BY bookmark.created_at DESC,bookmark.message_id LIMIT ${PAGE+1}
  ) SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY bookmarked_at DESC,message_id) FROM page),'[]'::jsonb) bookmarks FROM authorized`,
  anchor?[scope.workspaceId,readerId,anchor.bookmarkedUs,anchor.messageId]:[scope.workspaceId,readerId])).rows[0];
  if(!rows)throw new Error('workspace membership required');
  const selected:SavedRow[]=rows.bookmarks.slice(0,PAGE).map(row=>projectTraySavedRow(row,scope,toIdentity));
  const value:SavedWindow={windowId:`saved1:${createHash('sha256').update(JSON.stringify([VERSION,scope.workspaceId,readerId,input.before??null])).digest('hex')}`,
    ...(input.before!==undefined?{before:input.before}:{}),rows:selected,
    ...(rows.bookmarks.length>PAGE&&selected.length?{next:selected.at(-1)!.before}:{})};
  if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)throw new Error('saved_window_budget');
  return value;
}

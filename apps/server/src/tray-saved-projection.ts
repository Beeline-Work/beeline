import type { RouterFact, SavedRowPayload } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import { SAVED_TEXT_COLUMNS_SQL, projectTraySavedRow, type BookmarkRow, type IdentityFormatter } from './tray-saved-window.js';
import { readRouterAuthority, routerAtomicGroup, RouterProjectionUnavailable } from './router-projections.js';

export type TraySavedTarget=Readonly<{bookmarkId:string;messageId:string}>;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
export function readTraySavedTargets(value:unknown):readonly TraySavedTarget[]|undefined{
  if(!Array.isArray(value))return;
  const keys=new Map<string,string>();
  for(const target of value){
    if(!target||typeof target!=='object'||Array.isArray(target)||Object.keys(target).length!==2||!uuid(target.bookmarkId)||
      typeof target.messageId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(target.messageId)||keys.has(target.bookmarkId))return;
    keys.set(target.bookmarkId,target.messageId);
  }
  return value as readonly TraySavedTarget[];
}

/** Exact source keys only. This never lists/rebuilds a page or backfills holes.
 * The caller supplies the existing RR source handle and later final-fences the
 * entire shared needs-you atomic group; no cut is asserted by this function. */
export async function buildTraySavedFacts(db:SqlDatabase,workspaceId:string,readerId:string,
  targets:readonly TraySavedTarget[],toIdentity:IdentityFormatter):Promise<readonly RouterFact[]>{
  if(!readTraySavedTargets(targets))throw new RouterProjectionUnavailable('dependency');
  if(!targets.length)return[];
  const input={family:'needs-you-saved-page' as const,workspaceId},authority=await readRouterAuthority(db,input,readerId);
  const found=(await db.query<BookmarkRow>(`SELECT bookmark.bookmark_id::text,bookmark.message_id,bookmark.workspace_id,bookmark.room_id,
    CASE WHEN room_member.identity_id IS NOT NULL THEN COALESCE(room.name,bookmark.source_room_name) ELSE bookmark.source_room_name END room_name,
    bookmark.source_room_kind room_kind,bookmark.message_created_at,bookmark.created_at bookmarked_at,
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
    JOIN unnest($3::uuid[],$4::text[]) target(bookmark_id,message_id)
      ON target.bookmark_id=bookmark.bookmark_id AND target.message_id=bookmark.message_id
    LEFT JOIN rooms room ON room.id=bookmark.room_id AND room.workspace_id=bookmark.workspace_id
    LEFT JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
      AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
    LEFT JOIN messages message ON message.id=bookmark.message_id AND message.room_id=room.id
    LEFT JOIN identities author ON author.id=message.author_id
    WHERE bookmark.workspace_id=$1 AND bookmark.identity_id=$2 ORDER BY bookmark.bookmark_id`,
  [workspaceId,readerId,targets.map(target=>target.bookmarkId),targets.map(target=>target.messageId)])).rows;
  const rows=new Map(found.map(row=>[row.bookmark_id,row]));
  const facts:RouterFact[]=[...targets].sort((a,b)=>a.bookmarkId.localeCompare(b.bookmarkId)).map(target=>{
    const found=rows.get(target.bookmarkId);
    const payload:SavedRowPayload=found?{kind:'saved-row-replace',scope:workspaceId,
      row:projectTraySavedRow(found,{workspaceId,readerId},toIdentity)}:
      {kind:'saved-row-remove',scope:workspaceId,bookmarkId:target.bookmarkId,messageId:target.messageId};
    const fact={atomicGroup:routerAtomicGroup(input,readerId),authority,payload};
    return fact;
  });
  return facts;
}

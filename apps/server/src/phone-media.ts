import type { MediaMetadata, MediaObjectMetadata } from '@beeline/api-contract/media-metadata';
import type { SqlDatabase } from './database.js';
import { PhoneOperationError } from './phone-operations.js';
import { mediaIdFromUrl } from './media-ttl.js';

type ObjectRow={id:string;owner_id:string;sha256:string;size:string;mime:string;expires_at:Date};
const MAX_OBJECT_BYTES=25*1024*1024,MAX_PREVIEW_BYTES=16*1024;
function missing():never {throw new PhoneOperationError(404,{error:'media_not_found'});}
function objectMetadata(row:ObjectRow):MediaObjectMetadata{
  const size=Number(row.size);
  if(!Number.isSafeInteger(size)||size<=0||size>MAX_OBJECT_BYTES||!/^[0-9a-f]{64}$/.test(row.sha256))missing();
  return {objectId:row.id,sha256:row.sha256,size,mimeType:row.mime,expiresAt:row.expires_at.getTime()};
}
async function objectRow(database:SqlDatabase,id:string):Promise<ObjectRow>{
  const row=(await database.query<ObjectRow>(`SELECT id,owner_id,sha256,size::text,mime,expires_at FROM objects
    WHERE id=$1 AND state='ready' AND expires_at>now() AND NOT EXISTS(SELECT 1 FROM object_expirations WHERE id=$1)`,[id])).rows[0];
  if(!row)missing();return row;
}
/** Owners and current Room members can read file metadata. */
export async function authorizedMediaMetadata(database:SqlDatabase,id:string,viewer:string):Promise<MediaMetadata>{
  const object=await objectRow(database,id);
  let thumbnailUrl:string|undefined;
  if(object.owner_id!==viewer){
    const pattern=`(^https?://[^/]+)?/v1/media/${id}([?].*)?$`;
    const reference=(await database.query<{room_id:string;workspace_id:string;file:{thumbnailUrl?:string}}>(
      `SELECT message.room_id,room.workspace_id,file.value file FROM messages message
       JOIN rooms room ON room.id=message.room_id
       JOIN room_access member ON member.room_id=room.id AND member.identity_id=$1 AND member.removed_at IS NULL
       JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
         AND workspace.identity_id=$1 AND workspace.removed_at IS NULL
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(message.attachments)='array' THEN message.attachments ELSE '[]'::jsonb END) file(value)
       WHERE message.deleted_at IS NULL AND (file.value->>'url'~$2 OR file.value->>'previewUrl'~$2 OR file.value->>'thumbnailUrl'~$2)
       ORDER BY message.room_id,message.id LIMIT 1`,[viewer,pattern])).rows[0];
    if(!reference)missing();
    thumbnailUrl=reference.file.thumbnailUrl;
  }
  const value:MediaMetadata=objectMetadata(object);
  const thumbnailId=thumbnailUrl?mediaIdFromUrl(thumbnailUrl):undefined;
  if(thumbnailId && thumbnailId!==id){
    const thumbnail=(await database.query<ObjectRow>(`SELECT id,owner_id,sha256,size::text,mime,expires_at FROM objects
      WHERE id=$1 AND state='ready' AND size<=$2 AND expires_at>now() AND mime=ANY($3::text[])
      AND NOT EXISTS(SELECT 1 FROM object_expirations WHERE id=$1)`,[thumbnailId,MAX_PREVIEW_BYTES,['image/png','image/jpeg','image/webp','image/gif']])).rows[0];
    if(thumbnail)return {...value,thumbnail:objectMetadata(thumbnail)};
  }
  return value;
}
export async function readMediaMetadata(database:SqlDatabase,id:string,viewer:string):Promise<MediaMetadata>{
  return database.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return authorizedMediaMetadata(tx,id,viewer);});
}

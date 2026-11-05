import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { needsYouItems } from './needs-you.js';

type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];
type Output<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['output'];
type IdentityFormatter = Parameters<typeof needsYouItems>[3];
const BOOKMARK_PAGE = 30;
const unix = (value: Date | string) => Math.floor((typeof value === 'string' ? new Date(value) : value).getTime() / 1000);

/** Shared by the existing paginated read and the pure same-cut Tray builder. */
export async function readMessageBookmarks(database: SqlDatabase, input: Input<'listMessageBookmarks'>,
  viewerId: string, toIdentity: IdentityFormatter): Promise<Output<'listMessageBookmarks'>> {
    const cursor = input.before?.match(/^(\d{1,19}),([a-zA-Z0-9_-]{1,128})$/);
    if (input.before !== undefined && !cursor) throw new Error('invalid_cursor');
    const result = await database.query<{ bookmarks: Array<{
      message_id: string;
      workspace_id: string;
      room_id: string;
      room_name: string;
      room_kind: 'room' | 'corner';
      message_created_at: Date;
      bookmarked_at: Date;
      bookmarked_us: string;
      available: boolean;
      text: string | null;
      author_id: string | null;
      author_kind: 'human' | 'agent' | null;
      author_name: string | null;
      author_handle: string | null;
      author_avatar: string | null;
      author_face: string | null;
    }> }>(
      `WITH authorized AS (
         SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
           AND identity_id=$2 AND removed_at IS NULL
       ), bookmarks AS (
       SELECT bookmark.message_id,bookmark.workspace_id,bookmark.room_id,
         COALESCE(room.name,bookmark.source_room_name) room_name,
         bookmark.source_room_kind room_kind,
         bookmark.message_created_at,bookmark.created_at bookmarked_at,
         (extract(epoch FROM bookmark.created_at)*1000000)::bigint::text bookmarked_us,
         (message.id IS NOT NULL AND message.deleted_at IS NULL AND room.id IS NOT NULL AND room_member.identity_id IS NOT NULL) available,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN message.text END text,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.id END author_id,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.kind END author_kind,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.name END author_name,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.handle END author_handle,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.avatar END author_avatar,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.face_id END author_face
       FROM message_bookmarks bookmark
       LEFT JOIN rooms room ON room.id=bookmark.room_id AND room.workspace_id=bookmark.workspace_id
       LEFT JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
         AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
       LEFT JOIN messages message ON message.id=bookmark.message_id AND message.room_id=room.id
       LEFT JOIN identities author ON author.id=message.author_id
       WHERE bookmark.workspace_id=$1 AND bookmark.identity_id=$2
         ${cursor ? `AND ((extract(epoch FROM bookmark.created_at)*1000000)::bigint < $3::bigint
           OR ((extract(epoch FROM bookmark.created_at)*1000000)::bigint = $3::bigint
             AND bookmark.message_id > $4))` : ''}
       ORDER BY bookmark.created_at DESC,bookmark.message_id
       LIMIT ${BOOKMARK_PAGE + 1}
       )
       SELECT COALESCE((SELECT jsonb_agg(to_jsonb(bookmarks) ORDER BY bookmarked_at DESC,message_id)
         FROM bookmarks),'[]'::jsonb) bookmarks FROM authorized`,
      cursor ? [input.workspaceId, viewerId, cursor[1], cursor[2]] : [input.workspaceId, viewerId],
    );
    if (!result.rows[0]) throw new Error('workspace membership required');
    const page = result.rows[0].bookmarks.slice(0, BOOKMARK_PAGE);
    const last = page.at(-1);
    return {
      ...(result.rows[0].bookmarks.length > BOOKMARK_PAGE && last
        ? { next: `${last.bookmarked_us},${last.message_id}` } : {}),
      bookmarks: page.map((raw) => {
        const row = raw;
        return ({
        messageId: row.message_id,
        workspaceId: row.workspace_id,
        roomId: row.room_id,
        roomName: row.room_name,
        roomKind: row.room_kind,
        messageCreatedAt: unix(row.message_created_at),
        bookmarkedAt: unix(row.bookmarked_at),
        available: row.available,
        ...(row.available && row.text !== null ? { text: row.text } : {}),
        ...(row.available && row.author_id && row.author_kind && row.author_name
          ? {
              author: toIdentity(
                {
                  id: row.author_id,
                  kind: row.author_kind,
                  name: row.author_name,
                  handle: row.author_handle,
                  avatar: row.author_avatar,
                  face_id: row.author_face,
                },
              ),
            }
          : {}),
        });
      }),
    };
}

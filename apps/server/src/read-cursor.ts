import type { SqlDatabase } from './database.js';
import { hiddenWakeCardSql } from './room-choice.js';

export type ViewerReadCursor = {
  readonly messageId: string | null;
  readonly firstUnreadMessageId: string | null;
};

/**
 * One viewer's read boundary, correlated with the authorized Room (`room.id`)
 * and the viewer (`$2`). Every path that reports a boundary reads it from
 * here: the two Room read paths, and the live publish that hands a moved
 * boundary to that reader's other devices. They must never disagree about
 * where the reader is, so there is one definition and no second copy.
 */
export const VIEWER_READ_CURSOR_SQL = `jsonb_build_object(
  'messageId',(SELECT message_id FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),
  'firstUnreadMessageId',(
    SELECT message.id FROM messages message
    WHERE message.room_id=room.id AND message.author_id<>$2
      AND message.presentation<>'activity'
      AND ${hiddenWakeCardSql('message')}
      AND (message.created_at,message.id)>(
        COALESCE((SELECT message_created_at FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),'-infinity'::timestamptz),
        COALESCE((SELECT message_id FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),'')
      )
    ORDER BY message.created_at,message.id LIMIT 1
  ))`;

/** The same boundary, standalone, for a Room this caller has already authorized. */
export async function readViewerCursor(
  database: SqlDatabase,
  roomId: string,
  viewerId: string,
): Promise<ViewerReadCursor | undefined> {
  const cursor = (
    await database.query<{ cursor: ViewerReadCursor }>(
      `SELECT ${VIEWER_READ_CURSOR_SQL} cursor FROM rooms room WHERE room.id=$1`,
      [roomId, viewerId],
    )
  ).rows[0]?.cursor;
  return cursor
    ? {
        messageId: cursor.messageId ?? null,
        firstUnreadMessageId: cursor.firstUnreadMessageId ?? null,
      }
    : undefined;
}

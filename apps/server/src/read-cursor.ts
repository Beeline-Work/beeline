import { hiddenWakeCardSql } from './room-choice.js';

/**
 * Highest tally the cursor reports. Past it the exact number is not something
 * any surface would say out loud, and counting further makes the scan behind a
 * long-abandoned mark grow with the whole backlog.
 */
export const UNREAD_COUNT_CAP = 99;
export const UNREAD_AGENT_TURN_COUNT_CAP = 6;

/**
 * WHAT COUNTS AS UNREAD. One definition, and the only one.
 *
 * Three used to disagree: the read cursor took `presentation<>'activity'`, the
 * deck's boolean took the `('message','system','card')` allowlist, and the
 * phone's own queue counted every folded id with no presentation rule at all.
 * A Room could therefore report a first-unread row that the deck refused to
 * call unread. The allowlist wins — it is closed, so a presentation added
 * later cannot silently become unread mail — and `IS DISTINCT FROM` wins over
 * `<>` because a row with no author is somebody else's, not nobody's.
 *
 * The phone's half of this same rule lives in
 * `apps/mobile/sources/buzz/room-new-message-boundary.ts` (`countsAsUnread`);
 * the two are pinned together by `read-cursor.test.ts`.
 *
 * `$2` is the viewer.
 */
export function unreadMessageSql(alias: string): string {
  const column = (name: string) => `${alias}.${name}`;
  return `${column('presentation')} IN ('message','system','card')
      AND ${hiddenWakeCardSql(alias)}
      AND ${column('author_id')} IS DISTINCT FROM $2`;
}

/** Rows strictly newer than the viewer's mark, by the ordering the mark stores. */
function newerThanMarkSql(alias: string): string {
  return `(${alias}.created_at,${alias}.id)>(
        COALESCE((SELECT message_created_at FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),'-infinity'::timestamptz),
        COALESCE((SELECT message_id FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),'')
      )`;
}

/**
 * One viewer's read boundary, correlated with the authorized Room (`room.id`)
 * and the viewer (`$2`): where they are, what the first thing they have not
 * read is, and how much of it there is. Both Room read paths project it from
 * here, so they can never disagree about where a reader is.
 *
 * `unreadCount` rides along because it answers the same question from the same
 * mark in the same pass — a surface that wants the number never costs a second
 * trip to get it.
 */
export const VIEWER_READ_CURSOR_SQL = `jsonb_build_object(
  'messageId',(SELECT message_id FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),
  'firstUnreadMessageId',(
    SELECT message.id FROM messages message
    WHERE message.room_id=room.id
      AND ${unreadMessageSql('message')}
      AND ${newerThanMarkSql('message')}
    ORDER BY message.created_at,message.id LIMIT 1
  ),
  'unreadCount',(
    SELECT count(*)::int FROM (
      SELECT 1 FROM messages message
      WHERE message.room_id=room.id
        AND ${unreadMessageSql('message')}
        AND ${newerThanMarkSql('message')}
      LIMIT ${UNREAD_COUNT_CAP}
    ) capped
  ),
  'unreadAgentTurnCount',(
    SELECT count(*)::int FROM (
      SELECT 1 FROM agent_turns turn
      WHERE turn.room_id=room.id
        AND turn.status='complete'
        -- created_at moves on every status write, so a complete turn's is
        -- when its answer landed: a turn running when the reader last read
        -- still counts.
        AND turn.created_at>COALESCE(
          (SELECT message_created_at FROM room_read_marks WHERE room_id=room.id AND identity_id=$2),
          '-infinity'::timestamptz
        )
      LIMIT ${UNREAD_AGENT_TURN_COUNT_CAP}
    ) capped
  ))`;

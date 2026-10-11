import type { SqlDatabase } from './database.js';
import {
  askingMessageSql,
  cardExpiresAtSql,
  EXPIRING_CARD_TYPES,
  expiringCardForSql,
  NEEDS_YOU_EXPIRY_HOURS,
  NEEDS_YOU_LOOKBACK,
  questionForSql,
  questionLeavesAtSql,
  viewerMemberSql,
} from './needs-you.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

/** Clock-only changes to the Needs-you tray and corner rows share one database-clock sweep. */
const TAKEOVER_LOOKBACK_MS = 10 * 60_000;

type Due = { identity_id: string; workspace_id: string; room_id: string };

export class DeadlineExpiry {
  #sweptThrough: number | undefined;
  constructor(private readonly database: Pick<SqlDatabase, 'query'>) {}

  /** Re-announce the takeover window, then return milliseconds until either next deadline. */
  async runOnce(newLeader = false): Promise<number | null> {
    const clock = await this.database.query<{ now_ms: string }>(
      `SELECT (extract(epoch FROM now())*1000)::bigint::text now_ms`,
    );
    const through = Number(clock.rows[0]!.now_ms);
    const since = Math.max(newLeader ? through - TAKEOVER_LOOKBACK_MS
      : this.#sweptThrough ?? through - TAKEOVER_LOOKBACK_MS, through - TAKEOVER_LOOKBACK_MS);
    const window = [new Date(since), new Date(through)];
    // Candidates by first sight and by the lookback edge, then the tray's own
    // question rule decides who each one still asked when it left.
    const questions = await this.database.query<Due>(
      `WITH due AS (
         SELECT mark.message_id,mark.identity_id FROM needs_you_marks mark
         WHERE mark.cleared_at IS NULL
           AND mark.first_seen_at>$1::timestamptz-interval '${NEEDS_YOU_EXPIRY_HOURS} hours'
           AND mark.first_seen_at<=$2::timestamptz-interval '${NEEDS_YOU_EXPIRY_HOURS} hours'
         UNION
         SELECT m.id,member.identity_id FROM messages m
         JOIN memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL
         WHERE ${askingMessageSql('m')}
           AND m.created_at>$1::timestamptz-${NEEDS_YOU_LOOKBACK}
           AND m.created_at<=$2::timestamptz-${NEEDS_YOU_LOOKBACK}
       )
       SELECT DISTINCT viewer.id identity_id,room.workspace_id::text workspace_id,room.id::text room_id
       FROM due
       JOIN messages m ON m.id=due.message_id
       JOIN rooms room ON room.id=m.room_id AND room.archived_at IS NULL
       JOIN memberships room_member ON room_member.room_id=room.id
         AND room_member.identity_id=due.identity_id AND room_member.removed_at IS NULL
       JOIN identities viewer ON viewer.id=due.identity_id
       LEFT JOIN needs_you_marks mark ON mark.identity_id=viewer.id AND mark.message_id=m.id
       WHERE ${questionForSql('viewer.id')}
         AND ${viewerMemberSql('room.workspace_id', 'viewer.id')}
         AND ${questionLeavesAtSql()}>$1::timestamptz AND ${questionLeavesAtSql()}<=$2::timestamptz`,
      window,
    );
    const approvals = await this.database.query<Due>(
      `SELECT DISTINCT viewer.identity_id,room.workspace_id::text workspace_id,room.id::text room_id
       FROM messages m
       JOIN rooms room ON room.id=m.room_id AND room.archived_at IS NULL
       JOIN memberships viewer ON viewer.room_id=room.id AND viewer.removed_at IS NULL
       JOIN identities person ON person.id=viewer.identity_id AND person.kind='human'
       WHERE ${expiringCardForSql('m', 'viewer.identity_id')}
         AND ${cardExpiresAtSql('m.card')}>$1 AND ${cardExpiresAtSql('m.card')}<=$2`,
      [since, through],
    );
    for (const row of [...questions.rows, ...approvals.rows])
      await this.database.query(`SELECT pg_notify($1,$2)`, [
        POSTGRES_LIVE_CHANNEL,
        JSON.stringify({
          table: 'needs_you_marks',
          operation: 'UPDATE',
          roomId: '',
          identityId: row.identity_id,
          workspaceId: row.workspace_id,
          sourceRoomId: row.room_id,
        }),
      ]);
    await this.database.query(
      `SELECT count(pg_notify($3, jsonb_build_object(
         'table','corner_owed','operation','UPDATE',
         'roomId',due.corner_id,'cornerParentId',due.parent_id)::text))
       FROM (SELECT DISTINCT owed.corner_id::text corner_id,room.parent_id::text parent_id
         FROM corner_owed owed JOIN rooms room ON room.id=owed.corner_id
         WHERE owed.expires_at>$1 AND owed.expires_at<=$2
           AND room.parent_id IS NOT NULL) due`,
      [window[0], window[1], POSTGRES_LIVE_CHANNEL],
    );
    this.#sweptThrough = through;
    const next = await this.database.query<{ ms: number | null }>(
      `SELECT (extract(epoch FROM LEAST(
           (SELECT min(first_seen_at) FROM needs_you_marks
            WHERE cleared_at IS NULL
              AND first_seen_at>$1::timestamptz-interval '${NEEDS_YOU_EXPIRY_HOURS} hours')
             +interval '${NEEDS_YOU_EXPIRY_HOURS} hours',
           (SELECT min(created_at) FROM messages
            WHERE ${askingMessageSql()} AND created_at>$1::timestamptz-${NEEDS_YOU_LOOKBACK})
             +${NEEDS_YOU_LOOKBACK},
           to_timestamp((SELECT min(${cardExpiresAtSql()}) FROM messages
            WHERE ${EXPIRING_CARD_TYPES} AND deleted_at IS NULL
              AND ${cardExpiresAtSql()}>$2)/1000.0),
           (SELECT min(expires_at) FROM corner_owed WHERE expires_at>now())
         )-now())*1000)::float8 ms`,
      [new Date(through), through],
    );
    return next.rows[0]?.ms ?? null;
  }
}

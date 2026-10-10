import type { SqlDatabase } from './database.js';
import { NEEDS_YOU_EXPIRY_HOURS } from './needs-you.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

/**
 * Some Needs-you cells leave the tray only because a clock passed: a question
 * 24 hours after it was first seen, and Trusty Squire and agent sign-in
 * approvals at their card's `expiresAt`. Nothing is written when that
 * happens, so no trigger tells a connected tray or badge. This sweep finds
 * each deadline that passed since the last sweep and sends the same
 * `needs_you_marks` notification a mark write sends, so each viewer gets a
 * fresh `needs-you-delta` through `sendNeedsYouDelta`.
 *
 * Choice and webhook approvals are not here: their own expiry jobs write the
 * row, and that write already notifies.
 */
const NEEDS_YOU_EXPIRY_SWEEP_INTERVAL_MS = 5_000;
/** How far back a new leader looks for deadlines that passed during the handover. */
export const NEEDS_YOU_EXPIRY_LOOKBACK_MS = 10 * 60_000;

/** A card's `expiresAt` in epoch milliseconds, or NULL; `messages_needs_you_expiry_idx` indexes it. */
export function cardExpiresAtSql(card = 'card'): string {
  return `(CASE WHEN ${card}->>'expiresAt' ~ '^[0-9]{1,15}$' THEN (${card}->>'expiresAt')::bigint END)`;
}
/** The approval cards whose only exit is their `expiresAt`. */
export const EXPIRING_CARD_TYPES = `card_type IN ('squire-approval','agent-sign-in')`;

type Due = { identity_id: string; workspace_id: string; room_id: string };

export class NeedsYouExpiryLoop {
  #sweptThrough: number | undefined;
  #lastSweep = Number.NEGATIVE_INFINITY;
  #nextDueAt: number | null = null;

  constructor(
    private readonly database: Pick<SqlDatabase, 'query'>,
    private readonly intervalMs = NEEDS_YOU_EXPIRY_SWEEP_INTERVAL_MS,
    private readonly lookbackMs = NEEDS_YOU_EXPIRY_LOOKBACK_MS,
  ) {}

  /** Notifies every viewer whose cell expired since the last sweep; returns the next deadline. */
  async runOnce(now = Date.now()): Promise<number | null> {
    const due = this.#nextDueAt !== null && this.#nextDueAt <= now;
    if (!due && now - this.#lastSweep < this.intervalMs) return this.#nextDueAt;
    this.#lastSweep = now;
    const since = Math.max(this.#sweptThrough ?? now - this.lookbackMs, now - this.lookbackMs);
    const window = [new Date(since), new Date(now)];
    const questions = await this.database.query<Due>(
      `SELECT DISTINCT mark.identity_id,mark.workspace_id::text workspace_id,m.room_id::text room_id
       FROM needs_you_marks mark JOIN messages m ON m.id=mark.message_id
       WHERE mark.cleared_at IS NULL
         AND mark.first_seen_at>$1::timestamptz-interval '${NEEDS_YOU_EXPIRY_HOURS} hours'
         AND mark.first_seen_at<=$2::timestamptz-interval '${NEEDS_YOU_EXPIRY_HOURS} hours'`,
      window,
    );
    const approvals = await this.database.query<Due>(
      `SELECT DISTINCT viewer.identity_id,room.workspace_id::text workspace_id,room.id::text room_id
       FROM messages m
       JOIN rooms room ON room.id=m.room_id AND room.archived_at IS NULL
       JOIN memberships viewer ON viewer.room_id=room.id AND viewer.removed_at IS NULL
         AND (m.card_type='squire-approval' OR viewer.identity_id=m.card->>'ownerId')
       JOIN identities person ON person.id=viewer.identity_id AND person.kind='human'
       WHERE m.${EXPIRING_CARD_TYPES} AND m.deleted_at IS NULL
         AND ${cardExpiresAtSql('m.card')}>$1 AND ${cardExpiresAtSql('m.card')}<=$2`,
      [since, now],
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
    this.#sweptThrough = now;
    const next = (
      await this.database.query<{ question_at: Date | null; card_at: string | null }>(
        `SELECT
           (SELECT min(first_seen_at) FROM needs_you_marks
            WHERE cleared_at IS NULL
              AND first_seen_at>$1::timestamptz-interval '${NEEDS_YOU_EXPIRY_HOURS} hours')
             +interval '${NEEDS_YOU_EXPIRY_HOURS} hours' question_at,
           (SELECT min(${cardExpiresAtSql()}) FROM messages
            WHERE ${EXPIRING_CARD_TYPES} AND deleted_at IS NULL
              AND ${cardExpiresAtSql()}>$2)::text card_at`,
        [new Date(now), now],
      )
    ).rows[0];
    const candidates = [
      next?.question_at ? new Date(next.question_at).getTime() : null,
      next?.card_at ? Number(next.card_at) : null,
    ].filter((value): value is number => value !== null);
    this.#nextDueAt = candidates.length ? Math.min(...candidates) : null;
    return this.#nextDueAt;
  }
}

import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

const MINUTE_MS = 60_000;
const MAX_INTERVAL_MINUTES = 366 * 24 * 60;

export function validateScheduleCadence(cadence: unknown): asserts cadence is RoomScheduleCadence {
  if (!cadence || typeof cadence !== 'object') throw new Error('schedule cadence is invalid');
  const value = cadence as Record<string, unknown>;
  if (value.kind === 'interval') {
    if (
      !Number.isSafeInteger(value.everyMinutes) ||
      (value.everyMinutes as number) < 1 ||
      (value.everyMinutes as number) > MAX_INTERVAL_MINUTES
    ) {
      throw new Error('interval must be between 1 minute and 366 days');
    }
    if (
      value.startsAt !== undefined &&
      (!Number.isSafeInteger(value.startsAt) || (value.startsAt as number) < 0)
    )
      throw new Error('interval start is invalid');
    return;
  }
  if (
    value.kind !== 'cron' ||
    typeof value.expression !== 'string' ||
    (value.timeZone !== undefined && typeof value.timeZone !== 'string')
  )
    throw new Error('schedule cadence is invalid');
  const expression = value.expression.trim();
  if (expression.split(/\s+/).length !== 5)
    throw new Error('cron expression must have five fields');
  CronExpressionParser.parse(expression, {
    currentDate: new Date(),
    ...(value.timeZone ? { tz: value.timeZone as string } : {}),
  });
}

/** Returns the first occurrence strictly after `now`, preserving interval phase. */
export function nextScheduleOccurrence(
  cadence: RoomScheduleCadence,
  now: Date,
  phase?: Date,
): Date {
  validateScheduleCadence(cadence);
  if (cadence.kind === 'cron') {
    return CronExpressionParser.parse(cadence.expression.trim(), {
      currentDate: now,
      ...(cadence.timeZone ? { tz: cadence.timeZone } : {}),
    })
      .next()
      .toDate();
  }
  const intervalMs = cadence.everyMinutes * MINUTE_MS;
  const origin =
    phase?.getTime() ?? (cadence.startsAt === undefined ? now.getTime() : cadence.startsAt * 1_000);
  if (origin > now.getTime()) return new Date(origin);
  const elapsed = now.getTime() - origin;
  return new Date(origin + (Math.floor(elapsed / intervalMs) + 1) * intervalMs);
}

type DueSchedule = {
  id: string;
  room_id: string;
  agent_id: string;
  creator_id: string;
  cadence: RoomScheduleCadence;
  message: string;
  next_run_at: Date;
};

export class AgentScheduleLoop {
  constructor(
    private readonly database: SqlDatabase,
    private readonly onPosted?: (roomId: string) => void,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const due = await this.database.query<DueSchedule>(
      `SELECT schedule.id,schedule.room_id,schedule.agent_id,schedule.creator_id,
        schedule.cadence,schedule.message,schedule.next_run_at
       FROM agent_schedules schedule
       JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL
       JOIN identities creator ON creator.id=schedule.creator_id AND creator.kind='human'
       JOIN identities agent ON agent.id=schedule.agent_id AND agent.kind='agent'
       JOIN memberships creator_membership ON creator_membership.room_id=schedule.room_id
         AND creator_membership.identity_id=schedule.creator_id AND creator_membership.removed_at IS NULL
       JOIN memberships agent_membership ON agent_membership.room_id=schedule.room_id
         AND agent_membership.identity_id=schedule.agent_id AND agent_membership.removed_at IS NULL
       WHERE schedule.next_run_at <= $1
       ORDER BY schedule.next_run_at,schedule.id LIMIT 100`,
      [now],
    );
    let posted = 0;
    for (const candidate of due.rows) {
      const roomId = await this.database.transaction(async (database) => {
        const current = (
          await database.query<DueSchedule>(
            `SELECT schedule.id,schedule.room_id,schedule.agent_id,schedule.creator_id,
              schedule.cadence,schedule.message,schedule.next_run_at
             FROM agent_schedules schedule
             JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL
             JOIN identities creator ON creator.id=schedule.creator_id AND creator.kind='human'
             JOIN identities agent ON agent.id=schedule.agent_id AND agent.kind='agent'
             JOIN memberships creator_membership ON creator_membership.room_id=schedule.room_id
               AND creator_membership.identity_id=schedule.creator_id
               AND creator_membership.removed_at IS NULL
             JOIN memberships agent_membership ON agent_membership.room_id=schedule.room_id
               AND agent_membership.identity_id=schedule.agent_id
               AND agent_membership.removed_at IS NULL
             WHERE schedule.id=$1 AND schedule.next_run_at <= $2 FOR UPDATE OF schedule`,
            [candidate.id, now],
          )
        ).rows[0];
        if (!current) return undefined;
        const messageId = randomBytes(32).toString('hex');
        const claim = await database.query(
          `INSERT INTO agent_schedule_occurrences(schedule_id,scheduled_for,message_id)
           VALUES($1,$2,$3) ON CONFLICT(schedule_id,scheduled_for) DO NOTHING RETURNING schedule_id`,
          [current.id, current.next_run_at, messageId],
        );
        if (!claim.rowCount) return undefined;
        await database.query(
          `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
           VALUES($1,$2,$3,$4,$5::jsonb)`,
          [
            messageId,
            current.room_id,
            current.creator_id,
            current.message,
            JSON.stringify([current.agent_id]),
          ],
        );
        const next = nextScheduleOccurrence(current.cadence, now, current.next_run_at);
        await database.query(
          `UPDATE agent_schedules SET next_run_at=$2,updated_at=now() WHERE id=$1`,
          [current.id, next],
        );
        return current.room_id;
      });
      if (!roomId) continue;
      posted += 1;
      this.onPosted?.(roomId);
    }
    return posted;
  }
}

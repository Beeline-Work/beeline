import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import {
  SCHEDULE_RAN_VERB,
  SCHEDULE_SCHEDULER_ID,
  SCHEDULE_SCHEDULER_NAME,
} from '@beeline/api-contract/scheduled-prompts';
import type { SqlDatabase } from './database.js';
import { systemLine } from './system-line.js';

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
  max_runs: number | null;
  run_count: number;
  next_run_at: Date;
  agent_name: string;
};

export class AgentScheduleLoop {
  constructor(
    private readonly database: SqlDatabase,
    private readonly onPosted?: (roomId: string) => void,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const due = await this.database.query<DueSchedule>(
      `SELECT schedule.id,schedule.room_id,schedule.agent_id,schedule.creator_id,
        schedule.cadence,schedule.message,schedule.max_runs,schedule.run_count,schedule.next_run_at
       FROM agent_schedules schedule
       JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL
       JOIN identities creator ON creator.id=schedule.creator_id
         AND (creator.kind='human' OR creator.id=schedule.agent_id)
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
              schedule.cadence,schedule.message,schedule.max_runs,schedule.run_count,schedule.next_run_at,
              agent.name agent_name
             FROM agent_schedules schedule
             JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL
             JOIN identities creator ON creator.id=schedule.creator_id
               AND (creator.kind='human' OR creator.id=schedule.agent_id)
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
        // A schedule created by the target agent itself must not be authored by
        // that agent: its own-authored rows never reach the agent's inbox and the
        // transcript would show the agent talking to itself. A human creator
        // keeps authoring its schedule posts exactly as before.
        const selfCreated = current.creator_id === current.agent_id;
        if (selfCreated) {
          await database.query(
            `INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human',$2,true)
             ON CONFLICT(id) DO NOTHING`,
            [SCHEDULE_SCHEDULER_ID, SCHEDULE_SCHEDULER_NAME],
          );
        }
        if (selfCreated) {
          await systemLine(database, {
            id: messageId,
            roomId: current.room_id,
            subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: SCHEDULE_SCHEDULER_NAME },
            verb: SCHEDULE_RAN_VERB,
            kind: 'schedule-ran',
            object: { text: current.agent_name, id: current.agent_id },
            consequence: current.message,
            mentions: [current.agent_id],
          });
        } else {
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
        }
        const finished = current.max_runs !== null && current.run_count + 1 >= current.max_runs;
        if (finished) {
          await database.query(`DELETE FROM agent_schedules WHERE id=$1`, [current.id]);
        } else {
          const next = nextScheduleOccurrence(current.cadence, now, current.next_run_at);
          await database.query(
            `UPDATE agent_schedules SET next_run_at=$2,run_count=run_count+1,updated_at=now() WHERE id=$1`,
            [current.id, next],
          );
        }
        return current.room_id;
      });
      if (!roomId) continue;
      posted += 1;
      this.onPosted?.(roomId);
    }
    return posted;
  }
}

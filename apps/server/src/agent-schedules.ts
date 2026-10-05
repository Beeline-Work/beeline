import { createAgentCommand } from './agent-command.js';
import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import {
  SCHEDULE_RAN_VERB,
  SCHEDULE_SCHEDULER_HANDLE,
  SCHEDULE_SCHEDULER_ID,
  SCHEDULE_SCHEDULER_NAME,
} from '@beeline/api-contract/scheduled-prompts';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { fireWorkflowTimer, liveWorkflowRun } from './workflow-runs.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { shortRunId } from '@beeline/api-contract/daemon';

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
  owner_id: string | null;
  workflow_slug: string | null;
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

  async nextDueAt(): Promise<Date | undefined> {
    const row = (
      await this.database.query<{ next_run_at: Date | null }>(
        `SELECT min(schedule.next_run_at) next_run_at
         FROM agent_schedules schedule
         JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL`,
      )
    ).rows[0];
    return row?.next_run_at ?? undefined;
  }

  async runOnce(now = new Date()): Promise<number> {
    const due = await this.database.query<DueSchedule>(
      `SELECT schedule.id,schedule.room_id,schedule.agent_id,schedule.creator_id,schedule.owner_id,schedule.workflow_slug,
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
       WHERE schedule.next_run_at <= $1 AND schedule.workflow_run IS NULL
       ORDER BY schedule.next_run_at,schedule.id LIMIT 100`,
      [now],
    );
    let posted = await this.fireWorkflowTimers(now);
    for (const candidate of due.rows) {
      const roomId = await this.database.transaction(async (database) => {
        const current = (
          await database.query<DueSchedule>(
            `SELECT schedule.id,schedule.room_id,schedule.agent_id,schedule.creator_id,schedule.owner_id,schedule.workflow_slug,
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
             WHERE schedule.id=$1 AND schedule.next_run_at <= $2 AND schedule.workflow_run IS NULL
             FOR UPDATE OF schedule`,
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
        const live = current.workflow_slug
          ? await liveWorkflowRun(database, current.room_id, current.workflow_slug)
          : undefined;
        if (live) {
          // One live run per workflow per Room: this tick starts nothing and
          // wakes no one, and says so once.
          await ensureSystemIdentity(database);
          await systemLine(database, {
            id: messageId,
            roomId: current.room_id,
            authorId: SYSTEM_IDENTITY_ID,
            subject: { kind: 'system', name: `The ${current.workflow_slug} schedule` },
            verb: 'skipped a run',
            consequence: `run ${shortRunId(live.runId)} is still live at ${live.state}`,
          });
          await this.advance(database, current, now, false);
          return current.room_id;
        }
        // A schedule created by the target agent itself must not be authored by
        // that agent: its own-authored rows never reach the agent's inbox and the
        // transcript would show the agent talking to itself. A human creator
        // keeps authoring its schedule posts exactly as before.
        const selfCreated = current.creator_id === current.agent_id;
        if (selfCreated) {
          await database.query(
            `INSERT INTO identities(id,kind,name,handle,hidden_from_roster)
             VALUES($1,'human',$2,$3,true)
             ON CONFLICT(id) DO UPDATE SET handle=EXCLUDED.handle`,
            [SCHEDULE_SCHEDULER_ID, SCHEDULE_SCHEDULER_NAME, SCHEDULE_SCHEDULER_HANDLE],
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
            wakes: [current.agent_id],
          });
        } else {
          // The agent is woken by the command created just below, never by a
          // tag: a scheduled prompt is the creator's words, and those words
          // need not name anybody.
          await database.query(
            `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
            [messageId, current.room_id, current.creator_id, current.message],
          );
        }
        await database.query(
          `UPDATE messages SET card=COALESCE(card,'{}'::jsonb) || jsonb_build_object('trigger',jsonb_build_object('scheduleId',$2::text,'period',$3::text)) || $4::jsonb WHERE id=$1`,
          [
            messageId,
            current.id,
            current.next_run_at.toISOString(),
            // The person a run started from this tick reports to.
            JSON.stringify(current.owner_id ? { ownerId: current.owner_id } : {}),
          ],
        );
        await createAgentCommand(database, {
          roomId: current.room_id,
          agentId: current.agent_id,
          sourceMessageId: messageId,
          reason: 'schedule',
        });
        await this.advance(database, current, now, true);
        return current.room_id;
      });
      if (!roomId) continue;
      posted += 1;
      this.onPosted?.(roomId);
    }
    return posted;
  }

  private async advance(
    database: SqlDatabase,
    current: DueSchedule,
    now: Date,
    started: boolean,
  ): Promise<void> {
    const increment = started ? 1 : 0;
    const finished =
      started && current.max_runs !== null && current.run_count + increment >= current.max_runs;
    if (finished) {
      await database.query(`DELETE FROM agent_schedules WHERE id=$1`, [current.id]);
      return;
    }
    const next = nextScheduleOccurrence(current.cadence, now, current.next_run_at);
    await database.query(
      `UPDATE agent_schedules SET next_run_at=$2,run_count=run_count+$3,updated_at=now() WHERE id=$1`,
      [current.id, next, increment],
    );
  }

  /**
   * Workflow engine timers (`workflow_run` set): a step's timeout, a gate's
   * default or a run's deadline. They belong to the run, not to an agent or
   * the schedule's creator, so no membership is required to fire them.
   */
  private async fireWorkflowTimers(now: Date): Promise<number> {
    const due = await this.database.query<{
      id: string;
      room_id: string;
      workflow_run: Parameters<typeof fireWorkflowTimer>[1]['workflow_run'];
    }>(
      `SELECT schedule.id,schedule.room_id,schedule.workflow_run
       FROM agent_schedules schedule
       JOIN rooms room ON room.id=schedule.room_id AND room.archived_at IS NULL
       WHERE schedule.next_run_at <= $1 AND schedule.workflow_run IS NOT NULL
       ORDER BY schedule.next_run_at,schedule.id LIMIT 100`,
      [now],
    );
    let fired = 0;
    for (const row of due.rows) {
      if (!(await fireWorkflowTimer(this.database, row))) continue;
      fired += 1;
      this.onPosted?.(row.room_id);
    }
    return fired;
  }
}

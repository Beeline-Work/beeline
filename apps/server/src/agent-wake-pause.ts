import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { nextScheduleOccurrence } from './agent-schedules.js';

/** Agents manage only their own wake sources, under current Room access. */
export async function setAgentWakePaused(db: SqlDatabase, agentId: string, input: {
  roomId: string; scheduleId?: string; subscriptionId?: string; paused: boolean;
}) {
  if (typeof input.paused !== 'boolean' || Boolean(input.scheduleId) === Boolean(input.subscriptionId))
    throw new Error('give one scheduleId or subscriptionId and paused');
  return db.transaction(async tx => {
    const table = input.scheduleId ? 'agent_schedules' : 'agent_subscriptions';
    const row = (await tx.query<{ id: string; paused_at: Date | null; cadence: RoomScheduleCadence; next_run_at: Date; now_at: Date }>(
      `SELECT wake.*,clock_timestamp() now_at FROM ${table} wake
       JOIN room_access member ON member.room_id=wake.room_id AND member.identity_id=$2 AND member.removed_at IS NULL
       JOIN rooms room ON room.id=wake.room_id AND room.archived_at IS NULL
       WHERE wake.id=$1 AND wake.agent_id=$2
         ${input.scheduleId ? 'AND wake.workflow_run IS NULL' : ''} FOR UPDATE OF wake`,
      [input.scheduleId ?? input.subscriptionId, agentId])).rows[0];
    if (!row) throw new Error('wake source not found');
    if (Boolean(row.paused_at) === input.paused) return;
    if (input.scheduleId) {
      // Preserve interval phase, skip missed occurrences, and leave no catch-up work.
      const next = input.paused ? row.next_run_at : nextScheduleOccurrence(row.cadence, row.now_at, row.next_run_at);
      await tx.query(`UPDATE agent_schedules SET paused_at=$2,next_run_at=$3,updated_at=now() WHERE id=$1`,
        [row.id, input.paused ? row.now_at : null, next]);
    } else await tx.query('UPDATE agent_subscriptions SET paused_at=$2 WHERE id=$1',
      [row.id, input.paused ? row.now_at : null]);
  });
}

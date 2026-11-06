import { webhookDetails, requireScheduledWorkManager, requireScheduledWorkReader } from '../subscription-webhooks.js';
import { listRoomSubscriptions } from '../agent-subscriptions.js';
import { listRoomWorkflowRuns, readWorkflowRun } from '../workflow-run-views.js';
import type { PhoneContext } from './context.js';
import { RoomScheduleRow, Output, Input } from './types.js';
import { roomSchedule } from './read-projection.js';


  export async function phoneListRoomSchedules(ctx: PhoneContext, roomId: string, viewerId: string) {
    await requireScheduledWorkReader(ctx.database, roomId, viewerId);
    const schedules = await ctx.database.query<RoomScheduleRow>(
      `SELECT schedule.id,schedule.workspace_id,schedule.room_id,schedule.agent_id,
              schedule.creator_id,schedule.cadence,schedule.message,schedule.next_run_at,
              schedule.created_at,schedule.workflow_slug,schedule.run_count,schedule.title,schedule.max_runs,schedule.paused_at,
              surface.parent_id surface_parent_id,surface.name surface_name
       FROM agent_schedules schedule
       JOIN rooms surface ON surface.id=schedule.room_id
       WHERE (surface.id=$1 OR surface.parent_id=$1) AND surface.archived_at IS NULL

       ORDER BY schedule.created_at,schedule.id`,
      [roomId],
    );
    return { schedules: schedules.rows.map(roomSchedule) };
  }

  export async function phoneReadScheduledWork(ctx: PhoneContext, roomId: string, viewerId: string): Promise<Output<'readScheduledWork'>> {
    await requireScheduledWorkReader(ctx.database, roomId, viewerId);
    const [room, schedules, subscriptions] = await Promise.all([
      ctx.database.query<{ name: string | null; direct_participants: string[] | null; agent_id: string; agent_name: string }>(
        `SELECT room.name, room.direct_participants, agent.id agent_id, agent.name agent_name
         FROM rooms room
         LEFT JOIN memberships member ON member.room_id=room.id AND member.removed_at IS NULL
         LEFT JOIN identities agent ON agent.id=member.identity_id AND agent.kind='agent'
         WHERE room.id=$1`, [roomId]),
      phoneListRoomSchedules(ctx, roomId, viewerId),
      listRoomSubscriptions(ctx.database, roomId),
    ]);
    const projectedSubscriptions = await Promise.all(subscriptions.subscriptions.map(async (subscription) =>
      subscription.source === 'webhook'
        ? { ...subscription, ...await webhookDetails(ctx.database, roomId, subscription.id, viewerId, ctx.publicOrigin) }
        : subscription));
    return {
      roomName: room.rows[0]?.name ?? null,
      isDirectMessage: Boolean(room.rows[0]?.direct_participants),
      agentNames: room.rows.filter((row) => row.agent_id).map((row) => [row.agent_id, row.agent_name]),
      schedules: schedules.schedules,
      subscriptions: projectedSubscriptions,
    };
  }

  export async function phoneListRoomWorkflowRuns(ctx: PhoneContext, roomId: string, viewerId: string) {
    return listRoomWorkflowRuns(ctx.database, roomId, viewerId, undefined, ctx.publicOrigin);
  }

  export async function phoneReadWorkflowRun(ctx: PhoneContext, input: Input<'readWorkflowRun'>, viewerId: string) {
    const run = await readWorkflowRun(ctx.database, input, viewerId, ctx.publicOrigin);
    if (!run) throw new Error('workflow run not found');
    return run;
  }

  export async function phoneDeleteRoomSchedule(ctx: PhoneContext,
    input: Input<'deleteRoomSchedule'>,
    viewerId: string,
  ): Promise<void> {
    await requireScheduledWorkManager(ctx.database, input.roomId, viewerId);
    const deleted = await ctx.database.query(
      `DELETE FROM agent_schedules schedule USING rooms surface
       WHERE schedule.id=$1 AND surface.id=schedule.room_id
         AND (surface.id=$2 OR surface.parent_id=$2)`,
      [input.scheduleId, input.roomId],
    );
    if (!deleted.rowCount) throw new Error('schedule not found');
  }

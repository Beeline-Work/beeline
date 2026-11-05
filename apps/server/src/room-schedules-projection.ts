import type {RoomScheduleView,ScheduledWorkResult} from '@beeline/api-contract/phone';
import type {SqlDatabase} from './database.js';
import {listRoomSubscriptions} from './agent-subscriptions.js';
import {requireScheduledWorkManager,webhookDetails} from './subscription-webhooks.js';
import {scheduleDisplayTitle} from './schedule-title.js';
import {RouterProjectionUnavailable} from './router-projections.js';

type ScheduleRow={id:string;workspace_id:string;room_id:string;agent_id:string;creator_id:string;
  title:string|null;max_runs:number|null;cadence:RoomScheduleView['cadence'];message:string;
  next_run_at:Date;created_at:Date;surface_parent_id:string|null;surface_name:string|null;
  workflow_slug:string|null;run_count:number};

/** Full existing Scheduled Work display, built only from the caller's coherent
 * transaction. Bounds refuse an oversize surface rather than trim its rows. */
export async function buildRoomSchedulesProjection(db:SqlDatabase,roomId:string,viewer:string,origin:string):Promise<ScheduledWorkResult>{
  await requireScheduledWorkManager(db,roomId,viewer);
  const counts=(await db.query<{entries:number;agents:number;calls:number}>(`WITH surfaces AS MATERIALIZED (
      SELECT * FROM rooms WHERE (id=$1 OR parent_id=$1) AND archived_at IS NULL
    ), entries AS (
      SELECT 1 FROM agent_schedules WHERE room_id IN(SELECT id FROM surfaces) AND workflow_run IS NULL
      UNION ALL SELECT 1 FROM effective_agent_subscriptions subscription JOIN room_access member ON member.room_id=subscription.room_id
        AND member.identity_id=subscription.agent_id AND member.removed_at IS NULL WHERE subscription.room_id IN(SELECT id FROM surfaces)

    ) SELECT (SELECT count(*)::int FROM(SELECT 1 FROM entries LIMIT 51) bounded) entries,
      (SELECT count(*)::int FROM(SELECT 1 FROM memberships member JOIN identities agent ON agent.id=member.identity_id AND agent.kind='agent'
        WHERE member.room_id=$1 AND member.removed_at IS NULL LIMIT 101) bounded) agents,
      (SELECT count(*)::int FROM(SELECT 1 FROM agent_subscriptions subscription JOIN room_access member
          ON member.room_id=subscription.room_id AND member.identity_id=subscription.agent_id AND member.removed_at IS NULL CROSS JOIN LATERAL(
          SELECT 1 FROM subscription_webhook_calls call WHERE call.subscription_id=subscription.id ORDER BY called_at DESC,id DESC LIMIT 50) recent
        WHERE subscription.room_id IN(SELECT id FROM surfaces) AND subscription.source='webhook' LIMIT 51) bounded) calls`,[roomId])).rows[0]!;
  if(counts.entries>50||counts.agents>100||counts.calls>50)throw new RouterProjectionUnavailable('budget');
  const room=(await db.query<{name:string|null;direct_participants:unknown;agent_id:string|null;agent_name:string|null}>(
    `SELECT room.name,room.direct_participants,agent.id agent_id,agent.name agent_name FROM rooms room
     LEFT JOIN LATERAL(SELECT person.id,person.name FROM memberships member JOIN identities person
       ON person.id=member.identity_id AND person.kind='agent'
       WHERE member.room_id=room.id AND member.removed_at IS NULL ORDER BY person.id LIMIT 101) agent ON true
     WHERE room.id=$1 ORDER BY agent.id`,[roomId])).rows;
  const scheduleRows=(await db.query<ScheduleRow>(`SELECT schedule.id,schedule.workspace_id,schedule.room_id,schedule.agent_id,
      schedule.creator_id,schedule.cadence,schedule.message,schedule.next_run_at,schedule.created_at,schedule.workflow_slug,
      schedule.run_count,schedule.title,schedule.max_runs,surface.parent_id surface_parent_id,surface.name surface_name
    FROM agent_schedules schedule JOIN rooms surface ON surface.id=schedule.room_id
    WHERE (surface.id=$1 OR surface.parent_id=$1) AND surface.archived_at IS NULL AND schedule.workflow_run IS NULL
    ORDER BY schedule.created_at,schedule.id`,[roomId])).rows;
  const schedules:RoomScheduleView[]=scheduleRows.map(row=>({id:row.id,workspaceId:row.workspace_id,roomId:row.room_id,
    agentId:row.agent_id,creatorId:row.creator_id,title:scheduleDisplayTitle({title:row.title,workflow:row.workflow_slug,prompt:row.message}),
    ...(row.max_runs!==null?{maxRuns:row.max_runs}:{}),cadence:row.cadence,message:row.message,
    nextRunAt:Math.floor(row.next_run_at.getTime()/1000),createdAt:Math.floor(row.created_at.getTime()/1000),
    ...(row.surface_parent_id&&row.surface_name?{corner:{id:row.room_id,name:row.surface_name}}:{}),
    ...(row.workflow_slug?{workflowSlug:row.workflow_slug}:{}),runCount:row.run_count}));
  const source=await listRoomSubscriptions(db,roomId);
  const subscriptions=await Promise.all(source.subscriptions.map(async subscription=>subscription.source==='webhook'
    ?{...subscription,...await webhookDetails(db,roomId,subscription.id,viewer,origin)}:subscription));
  const value:ScheduledWorkResult={roomName:room[0]?.name??null,isDirectMessage:Boolean(room[0]?.direct_participants),
    agentNames:room.filter((row):row is typeof row&{agent_id:string;agent_name:string}=>Boolean(row.agent_id&&row.agent_name))
      .map(row=>[row.agent_id,row.agent_name] as const),schedules,subscriptions};
  if(Buffer.byteLength(JSON.stringify(value))>64*1024)throw new RouterProjectionUnavailable('budget');
  return value;
}

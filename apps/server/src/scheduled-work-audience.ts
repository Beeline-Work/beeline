import type {SqlDatabase} from './database.js';
import type {routerSourcePlan} from './router-source-plan.js';
import {RouterProjectionUnavailable} from './router-projections.js';
import {scheduledWorkAuthorities} from './scheduled-work-authority.js';
import {ROUTER_ROOM_AUDIENCE_LIMIT} from './router-room-audience.js';

/** Current Room members plus source-proven former recipients. All IDs come from
 * stored permissions/old relationships; no phone subscription/cache report. */
export async function scheduledWorkAudience(db:SqlDatabase,workspace:string,viewer:string,plan:ReturnType<typeof routerSourcePlan>,changedOnly=false){
  if(changedOnly&&!plan.scheduledWorkCauses.length)return [];
  // Compact classification certifies the unchanged complement; its explicit
  // facts are selected only by DB-authored causes, never all authorized Rooms
  // and never a client's held lanes. The established path remains identical.
  const currentAudience=changedOnly?'':`SELECT room.id FROM rooms room CROSS JOIN manager WHERE room.workspace_id=$1 AND room.parent_id IS NULL AND(
        (room.direct_participants IS NULL AND manager.allowed OR room.direct_participants ? $2)
          AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL)) UNION `;
  const candidates=(await db.query<{id:string}>(`WITH manager AS (
      SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2
        AND removed_at IS NULL) allowed
    ), causes AS(SELECT * FROM jsonb_to_recordset($3::jsonb) AS source("roomId" uuid,readers jsonb)), candidates AS(
      ${currentAudience}SELECT causes."roomId" AS id FROM causes CROSS JOIN manager WHERE causes.readers IS NULL AND manager.allowed OR causes.readers ? $2
    ) SELECT id::text FROM candidates ORDER BY id LIMIT $4`,[workspace,viewer,JSON.stringify(plan.scheduledWorkCauses),ROUTER_ROOM_AUDIENCE_LIMIT+1])).rows;
  // The same authority statement covers existing and removed Room IDs. A
  // removed Room uses only the current principal certificate, never a second
  // audience-side authority query or a stored client inventory.
  const {states,principal}=await scheduledWorkAuthorities(db,candidates.map(row=>row.id),viewer);
  return candidates.map(row=>{
    const state=states.get(row.id),authority=state?.authority??principal;
    if(!authority)throw new RouterProjectionUnavailable('authority');
    return {roomId:row.id,state,authority,
      changed:plan.scheduledWorkCauses.some(cause=>cause.roomId===row.id&&(cause.readers===null||cause.readers.includes(viewer)))};
  });
}

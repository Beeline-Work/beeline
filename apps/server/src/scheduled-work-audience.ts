import type {SqlDatabase} from './database.js';
import type {routerSourcePlan} from './router-source-plan.js';
import {routerAuthority,RouterProjectionUnavailable} from './router-projections.js';
import {scheduledWorkAuthorities,scheduledPrincipalDomain} from './scheduled-work-authority.js';
import {ROUTER_ROOM_AUDIENCE_LIMIT} from './router-room-audience.js';

/** Current managers plus source-proven former recipients. All IDs come from
 * stored permissions/old relationships; no phone subscription/cache report. */
export async function scheduledWorkAudience(db:SqlDatabase,workspace:string,viewer:string,plan:ReturnType<typeof routerSourcePlan>,changedOnly=false){
  if(changedOnly&&!plan.scheduledWorkCauses.length)return [];
  // Compact classification certifies the unchanged complement; its explicit
  // facts are selected only by DB-authored causes, never all authorized Rooms
  // and never a client's held lanes. The established path remains identical.
  const currentAudience=changedOnly?'':`SELECT room.id FROM rooms room CROSS JOIN manager WHERE room.workspace_id=$1 AND room.parent_id IS NULL AND(
        room.direct_participants IS NULL AND manager.allowed OR room.direct_participants ? $2
          AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=room.id AND member.identity_id=$2 AND member.removed_at IS NULL)) UNION `;
  const candidates=(await db.query<{id:string}>(`WITH manager AS (
      SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2
        AND removed_at IS NULL AND role IN('owner','admin')) allowed
    ), causes AS(SELECT * FROM jsonb_to_recordset($3::jsonb) AS source("roomId" uuid,readers jsonb)), candidates AS(
      ${currentAudience}SELECT causes."roomId" AS id FROM causes CROSS JOIN manager WHERE causes.readers IS NULL AND manager.allowed OR causes.readers ? $2
    ) SELECT id::text FROM candidates ORDER BY id LIMIT $4`,[workspace,viewer,JSON.stringify(plan.scheduledWorkCauses),ROUTER_ROOM_AUDIENCE_LIMIT+1])).rows;
  if(candidates.length>ROUTER_ROOM_AUDIENCE_LIMIT)throw new RouterProjectionUnavailable('budget');
  const states=await scheduledWorkAuthorities(db,candidates.map(row=>row.id),viewer);
  let fallback;
  if(candidates.some(row=>!states.has(row.id))){
    const row=(await db.query<{epoch:string}>(`SELECT epoch::text FROM router_authority WHERE scope=$1`,[scheduledPrincipalDomain(viewer)])).rows[0];
    if(!row)throw new RouterProjectionUnavailable('authority');
    fallback=routerAuthority([{authorityScope:scheduledPrincipalDomain(viewer),epoch:row.epoch}]);
  }
  return candidates.map(row=>({roomId:row.id,state:states.get(row.id),authority:states.get(row.id)?.authority??fallback!,
    changed:plan.scheduledWorkCauses.some(cause=>cause.roomId===row.id&&(cause.readers===null||cause.readers.includes(viewer)))}));
}

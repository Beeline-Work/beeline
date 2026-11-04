import type {RouterAuthorityCertificate} from '@beeline/api-contract/router-protocol';
import type {SqlDatabase} from './database.js';
import {routerAuthority,RouterProjectionUnavailable} from './router-projections.js';
import type {routerSourcePlan} from './router-source-plan.js';

/** This is a DB permission/source audience, never a phone's Room inventory.
 * Overflow cannot be represented as a complete Workspace interval. */
export const ROUTER_ROOM_AUDIENCE_LIMIT=1_000_000;
export type RouterRoomAudience={readonly roomId:string;readonly parentId:string|null;
  readonly authority:RouterAuthorityCertificate;readonly complete:boolean;
  readonly denied?:{readonly scope:string;readonly authorityScope:string};readonly changed:boolean};

/** One set query reads current permission and all certificate epochs in the
 * caller's RP cut. Former audience comes only from a committed Room relation
 * and this reader's DB membership/source, never arbitrary private Room causes.
 * Unrelated Rooms receive metadata controls without running a DTO builder. */
export async function readRouterRoomAudience(db:SqlDatabase,workspace:string,viewer:string,
  plan:ReturnType<typeof routerSourcePlan>):Promise<readonly RouterRoomAudience[]>{
  const reader=`reader:${viewer}:workspace:${workspace}`;
  const result=await db.query<{id:string;workspace_id:string|null;parent_id:string|null;workspace_allowed:boolean;member_allowed:boolean;
    scopes:{authorityScope:string;epoch:string}[]}>(`WITH prior AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS relation(id uuid,"oldParentId" uuid)
    ), audience AS (
      SELECT room.id FROM rooms room WHERE room.workspace_id=$1 AND EXISTS(
        SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(room.parent_id,room.id)
          AND member.identity_id=$2 AND member.removed_at IS NULL)
      UNION SELECT room.id FROM rooms room WHERE (room.workspace_id=$1 OR room.id=ANY($4::uuid[]))
        AND (room.id=ANY($4::uuid[]) OR room.parent_id=ANY($4::uuid[]))
      UNION SELECT prior.id FROM prior WHERE prior.id=ANY($4::uuid[]) OR prior."oldParentId"=ANY($4::uuid[])
        OR EXISTS(SELECT 1 FROM memberships former WHERE former.identity_id=$2
          AND former.room_id=COALESCE(prior."oldParentId",prior.id))
    ) SELECT audience.id::text,room.workspace_id::text,room.parent_id::text,
      EXISTS(SELECT 1 FROM memberships member WHERE member.workspace_id=$1 AND member.room_id IS NULL
        AND member.identity_id=$2 AND member.removed_at IS NULL) workspace_allowed,
      EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(room.parent_id,room.id)
        AND member.identity_id=$2 AND member.removed_at IS NULL) member_allowed,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('authorityScope',scope,'epoch',epoch::text) ORDER BY scope)
        FROM router_authority WHERE scope=$5 OR scope='room:'||audience.id OR scope='room:'||room.parent_id),'[]'::jsonb) scopes
      FROM audience LEFT JOIN rooms room ON room.id=audience.id ORDER BY audience.id LIMIT $6`,
    [workspace,viewer,JSON.stringify(plan.priorRooms),[...plan.authorityRooms],reader,ROUTER_ROOM_AUDIENCE_LIMIT+1]);
  return result.rows.map(row=>{
    if(!row.scopes.some(scope=>scope.authorityScope===reader))throw new RouterProjectionUnavailable('authority');
    const domains=[reader,`room:${row.id}`,...(row.parent_id?[`room:${row.parent_id}`]:[])];
    const complete=domains.length===row.scopes.length&&domains.every(domain=>row.scopes.some(scope=>scope.authorityScope===domain));
    const allowed=row.workspace_allowed&&row.workspace_id===workspace&&row.member_allowed;
    const deniedScope=!row.workspace_allowed?workspace:row.parent_id??row.id;
    // JSONB canonicalizes object key order (epoch precedes authorityScope).
    // The wire digest is over authorityScope-first objects, as produced by
    // readRouterCertificate and the final enqueue fence; normalize that
    // boundary instead of relabeling equivalent epochs as missing authority.
    const scopes=row.scopes.map(scope=>({authorityScope:scope.authorityScope,epoch:scope.epoch}));
    return {roomId:row.id,parentId:row.parent_id,authority:routerAuthority(scopes),complete,
      ...(!allowed?{denied:{scope:deniedScope,authorityScope:!row.workspace_allowed?reader:`room:${deniedScope}`}}:{}),
      changed:plan.families.has('room-head')&&(plan.allRooms||plan.rooms.has(row.id)||
        row.parent_id!==null&&plan.rooms.has(row.parent_id))};
  });
}

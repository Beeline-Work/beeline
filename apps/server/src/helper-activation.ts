import type { CommandActivationInput, CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import { createHash } from 'node:crypto';
import type { CommandRow } from './agent-command.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import type { SqlDatabase } from './database.js';
import { isCommandOwnerLive } from './turn-ownership.js';

/** Protocol negotiation preserves old helper setup reads during the shared rollout. */
export { networkRouterEnabled as helperActivationEnabled } from './network-router-rollout.js';
export type ActivationValues=Pick<CommandActivationSnapshot,'configuration'|'roster'|'grants'|'repository'|'corner'>;
export type ActivationReader=(db:SqlDatabase,command:CommandRow,isCorner:boolean)=>Promise<ActivationValues>;

function commandRevision(command:CommandRow):string{
  // Actual claimed provenance, excluding renewal/progress bookkeeping. The
  // digest carries no source text or grant material into persistent controls.
  return createHash('sha256').update(JSON.stringify([command.turn_request_id,command.action,command.reason,
    command.root_command_id,command.parent_command_id,command.root_source_message_id,command.source_message_id,
    command.private_payload,command.review_context,command.wake_context,command.coalesced_context,command.coalesced_attachments,
    command.turn_owner_connection_id,command.turn_owner_epoch])).digest('hex');
}

function validIdentity(input:CommandActivationInput):boolean{
  const text=(value:unknown,limit:number)=>typeof value==='string'&&value.length>0&&value.length<=limit;
  return text(input.agentId,128)&&text(input.roomId,128)&&text(input.workspaceId,128)&&text(input.commandId,256)&&
    text(input.generationId,256)&&text(input.source?.connectionId,128)&&Number.isSafeInteger(input.source.epoch)&&input.source.epoch>0;
}
async function currentActor(db:SqlDatabase,input:CommandActivationInput,lock:boolean):Promise<CommandRow>{
  if(!validIdentity(input))throw new Error('Activation identity invalid');
  // This order avoids taking the authority head before an agent update whose
  // AFTER source trigger must update that same head.
  if(!(await db.query(`SELECT 1 FROM agents WHERE agent_id=$1${lock?' FOR SHARE':''}`,[input.agentId])).rowCount)
    throw new Error('Activation actor unavailable');
  if(!(await db.query(`SELECT 1 FROM agent_connections WHERE agent_id=$1 AND connection_id=$2 AND epoch=$3
    AND released_at IS NULL${lock?' FOR SHARE':''}`,[input.agentId,input.source.connectionId,input.source.epoch])).rowCount)
    throw new Error('Activation source ownership changed');
  const command=(await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1 AND agent_id=$2 AND room_id=$3
    AND generation_id=$4 AND state='claimed'${lock?' FOR SHARE':''}`,
    [input.commandId,input.agentId,input.roomId,input.generationId])).rows[0];
  if(!command)throw new Error('Activation command ownership changed');
  return command;
}
async function currentScope(db:SqlDatabase,input:CommandActivationInput):Promise<{isCorner:boolean}>{
  const room=(await db.query<{parent_id:string|null}>(`SELECT room.parent_id FROM rooms room
    JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id) AND parent.archived_at IS NULL
    JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
      AND workspace.identity_id=$1 AND workspace.removed_at IS NULL
    JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
      AND member.identity_id=$1 AND member.removed_at IS NULL
    WHERE room.id=$2 AND room.workspace_id=$3 AND room.archived_at IS NULL`,
    [input.agentId,input.roomId,input.workspaceId])).rows[0];
  if(!room)throw new Error('Activation membership changed');
  return {isCorner:room.parent_id!==null};
}
async function authorityHead(db:SqlDatabase,workspaceId:string,lock:boolean){
  const row=(await db.query<{generation:string;revision:string}>(`SELECT generation,revision::text FROM helper_activation_authority
    WHERE workspace_id=$1${lock?' FOR SHARE':''}`,[workspaceId])).rows[0];
  const revision=Number(row?.revision);
  if(!row||!/^[a-f0-9]{32}$/.test(row.generation)||!Number.isSafeInteger(revision)||revision<1)
    throw new Error('Activation authority unavailable');
  return {generation:row.generation,revision};
}
async function serverTime(db:SqlDatabase):Promise<number>{
  return Number((await db.query<{at:number}>('SELECT EXTRACT(epoch FROM clock_timestamp())::double precision at')).rows[0]!.at);
}
/** All DB-derived setup readers run in this one read-only snapshot. No generic
 * operation dispatcher, provider, credential lookup or journal writer runs here. */
export async function captureCommandActivation(database:SqlDatabase,input:CommandActivationInput,read:ActivationReader):Promise<CommandActivationSnapshot>{
  return CornerAccessDatabase.physical(database).transaction(async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const command=await currentActor(db,input,false);
    const authority=await authorityHead(db,input.workspaceId,false);
    const {isCorner}=await currentScope(db,input);
    const values=await read(db,command,isCorner),capturedAt=await serverTime(db);
    const expiries=values.grants.grants.flatMap(grant=>grant.expiresAt===undefined?[]:[grant.expiresAt]);
    const validUntil=expiries.length?Math.min(...expiries):undefined;
    if(!(await isCommandOwnerLive(db,command.id,capturedAt))||
      validUntil!==undefined&&validUntil<=capturedAt)throw new Error('Activation authority expired');
    const snapshot:CommandActivationSnapshot={...input,v:1,capturedAt,authority:{...authority,commandRevision:commandRevision(command)},...values,...(validUntil!==undefined?{validUntil}:{})};
    return snapshot;
  });
}

/** Recheck committed source/command ownership through the actual synchronous
 * socket enqueue. Rejected captures park; they do not start a replacement read. */
export async function fenceCommandActivationEnqueue(database:SqlDatabase,snapshot:CommandActivationSnapshot,enqueue:(snapshot:CommandActivationSnapshot)=>void):Promise<boolean>{
  return CornerAccessDatabase.physical(database).transaction(async db=>{
    const command=await currentActor(db,snapshot,true);
    const authority=await authorityHead(db,snapshot.workspaceId,true);
    if(authority.generation!==snapshot.authority.generation||authority.revision!==snapshot.authority.revision)return false;
    if(commandRevision(command)!==snapshot.authority.commandRevision)return false;
    await currentScope(db,snapshot);
    const at=await serverTime(db);
    if(!(await isCommandOwnerLive(db,command.id,at))||snapshot.validUntil!==undefined&&snapshot.validUntil<=at)return false;
    enqueue(snapshot);return true;
  });
}

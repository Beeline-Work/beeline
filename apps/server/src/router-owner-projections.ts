import type {RouterFamily,RouterFact,RouterSnapshot,RouterSnapshotInput} from '@beeline/api-contract/router-protocol';
import type {SqlDatabase} from './database.js';
import type {PhoneService} from './phone-service.js';
import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';
import {readRouterStreamCut,routerAuthority,routerAtomicGroup,RouterProjectionUnavailable} from './router-projections.js';

export const ownerFamily=(family:string):family is 'owner-workbench'|'owner-wallet'=>family==='owner-workbench'||family==='owner-wallet';
export async function ownerAuthority(db:SqlDatabase,family:RouterFamily,viewer:string){
  if(!ownerFamily(family))throw new RouterProjectionUnavailable('dependency');
  const scope=`owner:${viewer}:${family}`;
  const row=(await db.query<{epoch:string}>(`SELECT authority.epoch::text FROM router_authority authority
    JOIN identities person ON person.id=$2 AND person.kind='human' AND NOT person.hidden_from_roster
    WHERE authority.scope=$1`,[scope,viewer])).rows[0];
  if(!row)throw new RouterProjectionUnavailable('authority');
  return routerAuthority([{authorityScope:scope,epoch:row.epoch}]);
}
export async function buildOwnerSnapshot(db:SqlDatabase,phone:PhoneService,input:RouterSnapshotInput,viewer:string):Promise<RouterSnapshot>{
  const authority=await ownerAuthority(db,input.family,viewer),cut=await readRouterStreamCut(db,`owner:${viewer}`);
  const value=await phone.buildRouterValue(db,input,viewer);
  if(!value)throw new RouterProjectionUnavailable('dependency');
  const snapshot={kind:'snapshot' as const,family:input.family,scope:viewer,cut,authority,atomicGroup:routerAtomicGroup(input,viewer),value} as RouterSnapshot;
  return snapshot;
}
export async function fenceOwnerProjection(db:SqlDatabase,input:RouterSnapshotInput,viewer:string,
  expected:RouterSnapshot['authority'],enqueue:()=>undefined){
  return fenceOwnerProjections(db,[{family:input.family,authority:expected}],viewer,enqueue);
}
export async function fenceOwnerProjections(db:SqlDatabase,snapshots:readonly Pick<RouterSnapshot,'family'|'authority'>[],viewer:string,enqueue:()=>undefined){
  await db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
    for(const snapshot of snapshots)if((await ownerAuthority(tx,snapshot.family,viewer)).digest!==snapshot.authority.digest)throw new RouterProjectionUnavailable('authority');
    enqueue();
  });
}
export function ownerFact(snapshot:RouterSnapshot):RouterFact{
  return {atomicGroup:snapshot.atomicGroup,authority:snapshot.authority,
    payload:{kind:'scope-replace',family:snapshot.family,scope:snapshot.scope,value:snapshot.value}} as RouterFact;
}

import { ROUTER_PROTOCOL, ROUTER_MAX_PART_BYTES as PART_BYTES, ROUTER_MAX_PARTS as MAX_PARTS, ROUTER_MAX_BATCH_BYTES as MAX_BYTES } from '@beeline/api-contract/router-protocol';
import { createHash, randomUUID } from 'node:crypto';
import type {
  RouterAuthorityCertificate, RouterCut, RouterFact, RouterBatchRecord, RouterFamily, RouterPushFrame,
  RouterSnapshot, RouterSnapshotInput, RouterUnavailable, RouterValues,
} from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';
import {scheduledWorkAuthority,scheduledWorkAuthorities,scheduledRoomDomain} from './scheduled-work-authority.js';
import {readTrayClockBasis} from './tray-clock-basis.js';
import {profileDomain} from './router-profile-source.js';

export class RouterProjectionUnavailable extends Error {
  constructor(readonly reason: RouterUnavailable['reason']) { super(`Router projection unavailable: ${reason}`); }
}
export interface RouterValueBuilder {
  (database: SqlDatabase, input: RouterSnapshotInput, viewerId: string): Promise<RouterValues[RouterFamily] | null>;
}
export function routerAuthority(scopes: RouterAuthorityCertificate['scopes']): RouterAuthorityCertificate {
  const ordered = [...scopes].sort((a,b) => a.authorityScope.localeCompare(b.authorityScope));
  if (!ordered.length || ordered.length > 8 || new Set(ordered.map(s => s.authorityScope)).size !== ordered.length)
    throw new RouterProjectionUnavailable('authority');
  return { digest: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'), scopes: ordered };
}
export function routerAtomicGroup(input: RouterSnapshotInput, viewer: string): string {
  if(input.family.startsWith('owner-'))return `${input.family}:${viewer}`;
  if(input.family==='agent-profile')return `agent-profile:${input.workspaceId}:${input.agentId}:${viewer}`;
  return input.family.startsWith('needs-you') ? `needs-you:${input.workspaceId}:${viewer}`
    : input.family === 'room-head'||input.family==='room-scheduled-work'||input.family==='room-workflows' ? `${input.family}:${input.roomId}:${viewer}` : `${input.family}:${input.workspaceId}:${viewer}`;
}
export type ResolvedRouterSnapshotInput = { readonly family: RouterFamily; readonly workspaceId:string; readonly roomId?:string; readonly before?:string;readonly agentId?:string };
export async function resolveRouterInput(db: SqlDatabase, input: RouterSnapshotInput | ResolvedRouterSnapshotInput): Promise<ResolvedRouterSnapshotInput> {
  if (input.workspaceId) return {...input,workspaceId:input.workspaceId};
  if ((input.family !== 'room-head'&&input.family!=='room-scheduled-work'&&input.family!=='room-workflows') || !input.roomId) throw new RouterProjectionUnavailable('dependency');
  const room=(await db.query<{workspace_id:string}>(`SELECT workspace_id FROM rooms WHERE id=$1`,[input.roomId])).rows[0];
  if (!room) throw new RouterProjectionUnavailable('authority');
  return {...input,workspaceId:room.workspace_id};
}
export async function readRouterCertificate(db: SqlDatabase, args: RouterSnapshotInput | ResolvedRouterSnapshotInput, viewer: string): Promise<RouterAuthorityCertificate> {
  const input = await resolveRouterInput(db,args);
  if(input.family==='room-scheduled-work')return (await scheduledWorkAuthority(db,input.roomId!,viewer)).authority;
  const parent=input.roomId?(await db.query<{parent_id:string|null}>(`SELECT parent_id FROM rooms WHERE id=$1`,[input.roomId])).rows[0]?.parent_id:undefined;
  const scopes = [`reader:${viewer}:workspace:${input.workspaceId}`,
    ...(!input.roomId?[`reader:${viewer}:workspace:${input.workspaceId}:visibility`]:[]),
    ...(input.agentId?[profileDomain(input.workspaceId,input.agentId)]:[]),
    ...(input.roomId ? [`room:${input.roomId}`] : []),...(parent?[`room:${parent}`]:[])];
  const rows = await db.query<{ scope: string; epoch: string }>(
    `SELECT scope,epoch::text FROM router_authority WHERE scope=ANY($1::text[]) ORDER BY scope`, [scopes]);
  if (rows.rows.length !== scopes.length) throw new RouterProjectionUnavailable('authority');
  return routerAuthority(rows.rows.map(row => ({ authorityScope: row.scope, epoch: row.epoch })));
}
export async function readRouterAuthority(db: SqlDatabase, args: RouterSnapshotInput | ResolvedRouterSnapshotInput, viewer: string): Promise<RouterAuthorityCertificate> {
  const input = await resolveRouterInput(db,args);
  if(input.family==='room-scheduled-work'){
    const scope=await scheduledWorkAuthority(db,input.roomId!,viewer);
    if(!scope.allowed||!scope.complete||scope.workspaceId!==input.workspaceId)throw new RouterProjectionUnavailable('authority');
    return scope.authority;
  }
  const certificate = await readRouterCertificate(db,input,viewer);
  const allowed = await db.query(`SELECT 1 FROM memberships member
    WHERE member.workspace_id=$1 AND member.identity_id=$2 AND member.room_id IS NULL AND member.removed_at IS NULL
    AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rooms room JOIN memberships access
      ON access.room_id=COALESCE(room.parent_id,room.id) AND access.identity_id=$2 AND access.removed_at IS NULL
      WHERE room.id=$3 AND room.workspace_id=$1))
    ${input.agentId?`AND EXISTS(SELECT 1 FROM memberships named JOIN identities person ON person.id=named.identity_id
      WHERE named.workspace_id=$1 AND named.room_id IS NULL AND named.identity_id=$4 AND named.removed_at IS NULL
        AND person.kind='agent' AND NOT person.hidden_from_roster)` : ''}`, [input.workspaceId, viewer, input.roomId ?? null,...(input.agentId?[input.agentId]:[])]);
  if (!allowed.rowCount) throw new RouterProjectionUnavailable('authority');
  return certificate;
}
/** The logical resource and the exact denied authority domain are distinct.
 * Workspace denial dominates Room denial, even for a Room snapshot. */
export async function deniedRouterAuthorityScope(db: SqlDatabase, args: RouterSnapshotInput | ResolvedRouterSnapshotInput,
  viewer:string):Promise<{scope:string;authorityScope:string}> {
  const input=await resolveRouterInput(db,args);
  if(input.family==='room-scheduled-work')return (await scheduledWorkAuthority(db,input.roomId!,viewer)).denied;
  const workspace=await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2
    AND room_id IS NULL AND removed_at IS NULL`,[input.workspaceId,viewer]);
  if(!workspace.rowCount)return {scope:input.workspaceId,authorityScope:`reader:${viewer}:workspace:${input.workspaceId}`};
  if(input.agentId)return {scope:input.agentId,authorityScope:profileDomain(input.workspaceId,input.agentId)};
  if(input.roomId){
    const parent=(await db.query<{parent_id:string|null}>(`SELECT parent_id FROM rooms WHERE id=$1`,[input.roomId])).rows[0]?.parent_id;
    return {scope:parent??input.roomId,authorityScope:`room:${parent??input.roomId}`};
  }
  return {scope:input.workspaceId,authorityScope:`reader:${viewer}:workspace:${input.workspaceId}`};
}
export async function readRouterCut(db: SqlDatabase, workspace: string): Promise<RouterCut> {
  return readRouterStreamCut(db,`workspace:${workspace}`);
}
export async function readRouterStreamCut(db:SqlDatabase,stream:string):Promise<RouterCut>{
  const row = (await db.query<{ epoch: string; sequence: string }>(
    `SELECT epoch,sequence::text FROM live_streams WHERE id=$1`, [stream])).rows[0];
  const through = Number(row?.sequence);
  if (!row || !Number.isSafeInteger(through) || through < 0) throw new RouterProjectionUnavailable('dependency');
  return { stream, epoch: row.epoch, through, protocol: ROUTER_PROTOCOL };
}

/** All DTO queries, authority and head share this transaction handle. */
export async function buildRouterSnapshot(database: SqlDatabase, input: RouterSnapshotInput, viewer: string,
  build: RouterValueBuilder,options?:{readonly trayClock?:true}): Promise<RouterSnapshot> {
  return database.transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const resolved = await resolveRouterInput(db,input);
    const clock=options?.trayClock?await readTrayClockBasis(db,resolved.workspaceId):undefined;
    if(options?.trayClock&&(!input.family.startsWith('needs-you')||!clock?.ready))throw new RouterProjectionUnavailable('dependency');
    const authority = await readRouterAuthority(db, resolved, viewer);
    const value = await build(db, input, viewer);
    if (value === null) throw new RouterProjectionUnavailable('authority');
    const snapshot = { kind: 'snapshot' as const, family: input.family, scope: input.agentId??input.roomId ?? input.workspaceId,
      value, cut: await readRouterCut(db, resolved.workspaceId), atomicGroup: routerAtomicGroup(input, viewer), authority,
      ...(clock?{clockVersion:clock.clockVersion}:{}) } as RouterSnapshot;
    const limit = input.family==='agent-profile'?32*1024:input.family === 'needs-you-count' ? 1024 : ['room-head','room-scheduled-work','needs-you-tray','needs-you-saved-page','workspace-roster','room-workflows'].includes(input.family) ? PART_BYTES : MAX_BYTES;
    if (Buffer.byteLength(JSON.stringify(snapshot)) > limit) throw new RouterProjectionUnavailable('budget');
    return snapshot;
  });
}

/** Separate current snapshot and shared lock through the synchronous send.
 * An async enqueue callback is deliberately rejected by the type contract. */
export async function fenceRouterEnqueue(database: SqlDatabase, input: RouterSnapshotInput, viewer: string,
  expected: RouterAuthorityCertificate, enqueue: () => undefined, expectedClockVersion?: string): Promise<void> {
  await database.transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
    if ((await readRouterAuthority(db, input, viewer)).digest !== expected.digest)
      throw new RouterProjectionUnavailable('authority');
    if (expectedClockVersion !== undefined) {
      if (!input.family.startsWith('needs-you') || !input.workspaceId)
        throw new RouterProjectionUnavailable('dependency');
      const clock = await readTrayClockBasis(db, input.workspaceId);
      if (!clock?.ready || clock.clockVersion !== expectedClockVersion)
        throw new RouterProjectionUnavailable('dependency');
    }
    enqueue();
  });
}

/** Packetization preserves indivisible facts and never truncates a group. */
export function encodeRouterBatch(from: RouterCut, to: RouterCut, facts: readonly RouterBatchRecord[]): RouterPushFrame[] {
  if (from.stream !== to.stream || from.epoch !== to.epoch || to.through < from.through)
    throw new RouterProjectionUnavailable('dependency');
  const markers=facts.filter(f=>"kind" in f);
  if(markers.length>1||markers.some(marker=>marker.kind!=='scheduled-work-classification'||marker.version!==1||
    marker.authorityBarrier.protocol!==1||!marker.authorityBarrier.stream.startsWith('authority:')||
    !marker.authorityBarrier.epoch||marker.authorityBarrier.epoch.length>128||!marker.authorityBarrier.segment||marker.authorityBarrier.segment.length>128||
    !Number.isSafeInteger(marker.authorityBarrier.through)||marker.authorityBarrier.through<0))throw new RouterProjectionUnavailable('dependency');
  const domains = new Set(facts.flatMap(f => 'authority' in f?f.authority.scopes.map(s => s.authorityScope):[]));
  if (domains.size > 256) throw new RouterProjectionUnavailable('budget');
  const batchId = randomUUID();
  const contentDigest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const parts: RouterBatchRecord[][] = [[]];
  // Reserve the actual envelope overhead, including the maximum part count.
  const bytes = (part: RouterBatchRecord[]) => Buffer.byteLength(JSON.stringify({kind:'push-part',batchId,from,to,
    partIndex:MAX_PARTS-1,partCount:MAX_PARTS,contentDigest,facts:part}));
  for (const fact of facts) {
    if (bytes([fact]) > PART_BYTES) throw new RouterProjectionUnavailable('budget');
    if (bytes([...parts.at(-1)!, fact]) > PART_BYTES) parts.push([]);
    parts.at(-1)!.push(fact);
  }
  if (parts.length > MAX_PARTS) throw new RouterProjectionUnavailable('budget');
  const frames: RouterPushFrame[] = parts.map((part,index) => ({kind:'push-part',batchId,from,to,
    partIndex:index,partCount:parts.length,contentDigest,facts:part}));
  frames.push({kind:'push-commit',batchId,from,to,partCount:parts.length,contentDigest});
  if (frames.reduce((size,f) => size + Buffer.byteLength(JSON.stringify(f)),0) > MAX_BYTES)
    throw new RouterProjectionUnavailable('budget');
  return frames;
}

/** Independent per-server, non-destructive drain. This actor stores delivery
 * positions and DB audience only; it never knows routes or cached client rows. */
export class RouterProjectionDrain {
  constructor(private readonly database: SqlDatabase, private readonly live: LiveHub) {}
  async subscribe(workspace: string,
    project: (db: SqlDatabase, from: RouterCut, to: RouterCut, causes: readonly Record<string, unknown>[]) => Promise<void | (() => Promise<void>)>,
    unavailable: (reason: RouterUnavailable['reason']) => void): Promise<() => void> {
    return this.subscribeStream(`workspace:${workspace}`,project,unavailable);
  }
  async subscribeStream(stream:string,
    project:(db:SqlDatabase,from:RouterCut,to:RouterCut,causes:readonly Record<string,unknown>[])=>Promise<void|(()=>Promise<void>)>,
    unavailable:(reason:RouterUnavailable['reason'])=>void):Promise<()=>void>{
    let stopped = false, dirty = false, running = false, position: RouterCut | undefined;
    const drain = async () => {
      if (stopped || running || !position) return;
      running = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const built = await this.database.transaction(async db => {
            await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const to = await readRouterStreamCut(db, stream), from = position!;
            if (to.epoch !== from.epoch || to.through < from.through) throw new RouterProjectionUnavailable('retention');
            if (to.through === from.through) return {to,deliver:undefined};
            const entries = await db.query<{sequence: string; event: Record<string, unknown>}>(
              `SELECT sequence::text,event FROM live_journal WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY live_journal.sequence`,
              [stream,from.through,to.through]);
            if (entries.rows.length !== to.through-from.through || entries.rows.some((r,i) => Number(r.sequence)!==from.through+i+1))
              throw new RouterProjectionUnavailable('retention');
            // Builder receives the SAME repeatable-read handle as head/causes.
            const deliver = await project(db, from, to, entries.rows.map(e => e.event));
            return {to,deliver};
          });
          // Release the builder connection before acquiring the independent
          // current-authority fence. A busy pool must not need two slots per
          // queued builder, and PGlite correctly exposes that deadlock.
          if (!stopped && built.deliver) await built.deliver();
          if (!stopped) position = built.to;
        }
      } catch (error) {
        stopped = true;
        unavailable(error instanceof RouterProjectionUnavailable ? error.reason : 'projection');
        release();
      } finally { running = false; }
    };
    const unlisten = this.live.subscribeJournal(streams => { if (streams.includes(stream)) { dirty=true; void drain(); } });
    const unresync = this.live.subscribeResync(() => { dirty=true; void drain(); });
    const unhealth=this.live.subscribeProjectionUnavailable(()=>{if(!stopped){release();unavailable('listener');}});
    const release = () => { stopped=true; unlisten(); unresync(); unhealth(); };
    try { position = await readRouterStreamCut(this.database, stream); void drain(); return release; }
    catch (error) { release(); throw error; }
  }
}

const ROOM_SCOPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function groupInput(group:string,workspace:string,viewer:string):ResolvedRouterSnapshotInput|undefined {
  const profilePrefix=`agent-profile:${workspace}:`,profileSuffix=`:${viewer}`;
  if(group.startsWith(profilePrefix)&&group.endsWith(profileSuffix)){
    const agentId=group.slice(profilePrefix.length,-profileSuffix.length);
    if(agentId.length>0&&agentId.length<=128)return {family:'agent-profile',workspaceId:workspace,agentId};
  }
  if(group===`workspace-roster:${workspace}:${viewer}`)return {family:'workspace-roster',workspaceId:workspace};
  if(group===`room-list:${workspace}:${viewer}`)return {family:'room-list',workspaceId:workspace};
  if(group===`needs-you:${workspace}:${viewer}`)return {family:'needs-you',workspaceId:workspace};
  const prefix='room-head:',suffix=`:${viewer}`;
  const workflows='room-workflows:';
  if(group.startsWith(workflows)&&group.endsWith(suffix)){
    const room=group.slice(workflows.length,-suffix.length);
    if(ROOM_SCOPE.test(room))return {family:'room-workflows',workspaceId:workspace,roomId:room};
  }
  const scheduled='room-scheduled-work:';
  if(group.startsWith(scheduled)&&group.endsWith(suffix)){
    const room=group.slice(scheduled.length,-suffix.length);
    if(ROOM_SCOPE.test(room))return {family:'room-scheduled-work',workspaceId:workspace,roomId:room};
  }
  if(group.startsWith(prefix)&&group.endsWith(suffix)){
    const room=group.slice(prefix.length,-suffix.length);
    if(ROOM_SCOPE.test(room))return {family:'room-head',workspaceId:workspace,roomId:room};
  }
  return undefined;
}
function validGroupCertificate(authority:RouterAuthorityCertificate,readerScope:string,input:ResolvedRouterSnapshotInput):boolean {
  try{
    if(routerAuthority(authority.scopes).digest!==authority.digest||authority.scopes.some(scope=>!/^\d+$/.test(scope.epoch)))return false;
    const domains=authority.scopes.map(scope=>scope.authorityScope);
    if(!domains.includes(readerScope))return false;
    if(input.agentId)return domains.length===3&&domains.includes(`${readerScope}:visibility`)&&domains.includes(profileDomain(input.workspaceId,input.agentId));
    if(!input.roomId)return domains.length===2&&domains.includes(`${readerScope}:visibility`);
    return domains.length>=2&&domains.length<=3&&domains.includes(`room:${input.roomId}`)&&
      domains.every(domain=>domain===readerScope||domain.startsWith('room:')&&ROOM_SCOPE.test(domain.slice(5)));
  }catch{return false;}
}
function validProjectedMember(fact:RouterFact,input:ResolvedRouterSnapshotInput,workspace:string,viewer:string,readerScope:string):boolean {
  const payload=fact.payload,scope=input.agentId??input.roomId??workspace;
  if(payload.kind==='needs-you-rooms-replace')return !input.roomId&&input.family==='needs-you'&&payload.scope===workspace&&
    Number.isSafeInteger(payload.count)&&payload.count===payload.order.length&&payload.order.length<=500&&
    new Set(payload.order).size===payload.order.length&&payload.rooms.length<=128&&
    payload.rooms.every(room=>ROOM_SCOPE.test(room.roomId)&&room.items.every(item=>item.workspaceId===workspace&&item.roomId===room.roomId));
  if(payload.kind==='tray-classification'||payload.kind==='tray-needs-replace'){
    if(input.roomId||payload.scope!==workspace||fact.atomicGroup!==`needs-you:${workspace}:${viewer}`)return false;
    return payload.kind==='tray-classification'?payload.version===1&&/^tray-clock-v1:[a-f0-9]{32}:(0|[1-9][0-9]*)$/.test(payload.clockVersion):payload.value.items.length<=30;
  }
  if(payload.kind==='saved-row-replace'||payload.kind==='saved-row-remove'){
    if(input.roomId||payload.scope!==workspace||fact.atomicGroup!==`needs-you:${workspace}:${viewer}`)return false;
    return payload.kind==='saved-row-remove'
      ?ROOM_SCOPE.test(payload.bookmarkId)&&/^[a-zA-Z0-9_-]{1,128}$/.test(payload.messageId)
      :ROOM_SCOPE.test(payload.row.bookmarkId)&&payload.row.value.workspaceId===workspace&&
        /^[a-zA-Z0-9_-]{1,128}$/.test(payload.row.value.messageId)&&
        payload.row.order.endsWith(`,${payload.row.value.messageId}`);
  }
  if(payload.kind==='authority')return fact.authority.scopes.some(item=>item.authorityScope===payload.authorityScope)&&
    (payload.scope===workspace&&payload.authorityScope===readerScope||ROOM_SCOPE.test(payload.scope)&&payload.authorityScope===`room:${payload.scope}`||
      input.agentId===payload.scope&&payload.authorityScope===profileDomain(workspace,input.agentId));
  if(payload.kind==='authority-fence')return payload.mode==='advance'&&(input.roomId
    ?payload.scope===input.roomId&&payload.authorityScope===`room:${input.roomId}`
    :input.agentId?payload.scope===input.agentId&&payload.authorityScope===profileDomain(workspace,input.agentId)
    :payload.scope===workspace&&payload.authorityScope===`${readerScope}:visibility`);
  return payload.kind==='scope-replace'&&payload.scope===scope&&
    routerAtomicGroup({family:payload.family,workspaceId:workspace,...(payload.family==='agent-profile'?{agentId:scope}:['room-head','room-workflows'].includes(payload.family)?{roomId:scope}:{})} as RouterSnapshotInput,viewer)===fact.atomicGroup;
}

/** One short final fence covers all permitted groups and current content-free
 * controls. A stale group cannot discard another group's authorized data.
 * No per-socket/held-group inventory or delivery rewind is maintained here. */
export async function fenceRouterBatch(database: SqlDatabase, workspace: string, viewer: string,
  facts: readonly RouterFact[], enqueue: (safeFacts:readonly RouterFact[]) => undefined): Promise<void> {
  await database.transaction(async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
    await fenceRouterBatchInTransaction(db,workspace,viewer,facts,enqueue);
  });
}

/** Server-internal worker. Both callers acquire the shared authority lock in
 * READ COMMITTED before entry and retain it through synchronous enqueue. The
 * compact authority actor uses this worker to avoid a second transaction or
 * an unlocked gap between its control barrier and the data enqueue. */
export async function fenceRouterBatchInTransaction(db:SqlDatabase,workspace:string,viewer:string,
  facts:readonly RouterFact[],enqueue:(safeFacts:readonly RouterFact[])=>undefined):Promise<void>{
  const groups=new Map<string,RouterFact[]>();
  for(const fact of facts){
    if(!groups.has(fact.atomicGroup))groups.set(fact.atomicGroup,[]);
    groups.get(fact.atomicGroup)!.push(fact);
  }
  if(groups.size>256||facts.length>512)throw new RouterProjectionUnavailable('budget');
    const inputs=new Map([...groups.keys()].map(group=>[group,groupInput(group,workspace,viewer)]));
    const roomIds=[...new Set([...inputs.values()].flatMap(input=>input?.roomId?[input.roomId]:[]))];
    const profileIds=[...new Set([...inputs.values()].flatMap(input=>input?.agentId?[input.agentId]:[]))];
    const access=(await db.query<{workspace_allowed:boolean;profiles:string[];rooms:{id:string;workspace_id:string;parent_id:string|null;allowed:boolean}[]}>(
      `SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL) workspace_allowed,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id',room.id,'workspace_id',room.workspace_id,'parent_id',room.parent_id,'allowed',
         EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(room.parent_id,room.id)
           AND member.identity_id=$2 AND member.removed_at IS NULL)) ORDER BY room.id)
         FROM rooms room WHERE room.id=ANY($3::uuid[])),'[]'::jsonb) rooms,
       ${profileIds.length?`ARRAY(SELECT member.identity_id FROM memberships member JOIN identities person ON person.id=member.identity_id
         WHERE member.workspace_id=$1 AND member.room_id IS NULL AND member.identity_id=ANY($4::text[]) AND member.removed_at IS NULL
           AND person.kind='agent' AND NOT person.hidden_from_roster)`:'$4::text[]'} profiles`,[workspace,viewer,roomIds,profileIds])).rows[0];
    if(!access)throw new RouterProjectionUnavailable('authority');
    const rooms=new Map(access.rooms.map(room=>[room.id,room]));
    const readerScope=`reader:${viewer}:workspace:${workspace}`;
    const domains=new Set([readerScope,`${readerScope}:visibility`]);
    for(const id of roomIds){domains.add(`room:${id}`);const parent=rooms.get(id)?.parent_id;if(parent)domains.add(`room:${parent}`);}
    for(const id of profileIds)domains.add(profileDomain(workspace,id));
    if(domains.size>512)throw new RouterProjectionUnavailable('budget');
    const rows=await db.query<{scope:string;epoch:string}>(`SELECT scope,epoch::text FROM router_authority WHERE scope=ANY($1::text[])`,[[...domains]]);
    const epochs=new Map(rows.rows.filter(row=>/^\d+$/.test(row.epoch)).map(row=>[row.scope,row.epoch]));
    const certificate=(scopes:readonly string[]):RouterAuthorityCertificate|undefined=>scopes.every(scope=>epochs.has(scope))
      ?routerAuthority(scopes.map(authorityScope=>({authorityScope,epoch:epochs.get(authorityScope)!}))):undefined;
    const readerCertificate=certificate([readerScope]);
    if(!readerCertificate)throw new RouterProjectionUnavailable('authority');
    const safe:RouterFact[]=[];
    const scheduled=await scheduledWorkAuthorities(db,[...inputs.values()].flatMap(input=>input?.family==='room-scheduled-work'?[input.roomId!]:[]),viewer);
    for(const [group,members]of groups){
      const input=inputs.get(group);
      const scope=input?.agentId??input?.roomId??workspace;
      if(input?.family==='room-scheduled-work'){
        const current=scheduled.get(input.roomId!);
        if(!current){
          safe.push({atomicGroup:group,authority:readerCertificate,payload:{kind:'group-unavailable',scope,reason:'authority'}});continue;
        }
        const unavailable=(reason:'authority'|'dependency')=>safe.push({atomicGroup:group,authority:current.authority,payload:{kind:'group-unavailable',scope,reason}});
        if(current.workspaceId!==workspace){unavailable('dependency');continue;}
        if(!current.allowed){
          if(!current.authority.scopes.some(item=>item.authorityScope===current.denied.authorityScope)){unavailable('authority');continue;}
          safe.push({atomicGroup:group,authority:current.authority,payload:{kind:'authority-fence',...current.denied,mode:'deny'}});continue;
        }
        const expected=members[0]!.authority;
        const coherent=current.complete&&members.every(fact=>fact.authority.digest===expected.digest&&
          routerAuthority(fact.authority.scopes).digest===expected.digest&&(fact.payload.kind==='scope-replace'
            ?fact.payload.family==='room-scheduled-work'&&fact.payload.scope===scope
            :fact.payload.kind==='authority-fence'&&fact.payload.mode==='advance'&&fact.payload.scope===scope&&fact.payload.authorityScope===scheduledRoomDomain(scope)));
        if(!coherent){unavailable('authority');continue;}
        if(current.authority.digest===expected.digest){safe.push(...members);continue;}
        const changed=current.authority.scopes.filter(now=>expected.scopes.some(prior=>prior.authorityScope===now.authorityScope&&prior.epoch!==now.epoch));
        if(!changed.length){unavailable('authority');continue;}
        for(const target of changed)safe.push({atomicGroup:group,authority:current.authority,payload:{kind:'authority-fence',
          scope:target.authorityScope.startsWith('scheduled-work-principal:')?viewer:target.authorityScope.includes(':workspace:')?workspace:scope,
          authorityScope:target.authorityScope,mode:'advance'}});
        continue;
      }
      const current=input?certificate([readerScope,...(input.roomId
        ?[`room:${input.roomId}`,...(rooms.get(input.roomId)?.parent_id?[`room:${rooms.get(input.roomId)!.parent_id}`]:[])]
        :[`${readerScope}:visibility`,...(input.agentId?[profileDomain(workspace,input.agentId)]:[])])]):undefined;
      const unavailable=(reason:'authority'|'dependency'='authority')=>safe.push({atomicGroup:group,authority:current??readerCertificate,
        payload:{kind:'group-unavailable',scope,reason}});
      if(!input||!current){unavailable();continue;}
      if(input.roomId&&rooms.has(input.roomId)&&rooms.get(input.roomId)!.workspace_id!==workspace){unavailable('dependency');continue;}
      const allowed=access.workspace_allowed&&(!input.roomId||rooms.get(input.roomId)?.allowed===true)&&(!input.agentId||access.profiles.includes(input.agentId));
      if(!allowed){
        const parent=rooms.get(input.roomId!)?.parent_id;
        if(access.workspace_allowed&&parent){
          // A reparent retires the old child chain. Its new parent decides
          // current access; a later parent regrant need not change child epoch.
          safe.push({atomicGroup:group,authority:current,payload:{kind:'authority-fence',scope:input.roomId!,authorityScope:`room:${input.roomId}`,mode:'advance'}});
        }
        const deniedScope=!access.workspace_allowed?workspace:input.agentId??parent??input.roomId!;
        const domain=!access.workspace_allowed?readerScope:input.agentId?profileDomain(workspace,input.agentId):`room:${deniedScope}`;
        if(!current.scopes.some(item=>item.authorityScope===domain)){unavailable();continue;}
        safe.push({atomicGroup:group,authority:current,payload:{kind:'authority-fence',scope:deniedScope,authorityScope:domain,mode:'deny'}});
        continue;
      }
      const expected=members[0]!.authority;
      const coherent=members.every(fact=>validGroupCertificate(fact.authority,readerScope,input)&&fact.authority.digest===expected.digest&&
        validProjectedMember(fact,input,workspace,viewer,readerScope));
      if(!coherent){unavailable();continue;}
      if(expected.digest===current.digest&&members.every(fact=>['scope-replace','authority-fence','saved-row-replace','saved-row-remove','tray-classification','tray-needs-replace','needs-you-rooms-replace'].includes(fact.payload.kind))){safe.push(...members);continue;}
      const changed=current.scopes.filter(now=>expected.scopes.some(prior=>prior.authorityScope===now.authorityScope&&prior.epoch!==now.epoch));
      if(!changed.length){unavailable();continue;}
      for(const target of changed){
        const logical=target.authorityScope.startsWith('room:')?target.authorityScope.slice(5):
          input.agentId&&target.authorityScope===profileDomain(workspace,input.agentId)?input.agentId:workspace;
        safe.push({atomicGroup:group,authority:current,payload:{kind:'authority-fence',scope:logical,authorityScope:target.authorityScope,mode:'advance'}});
      }
    }
    // This is the final asynchronous read before synchronous enqueue. Cached
    // classification cannot survive an overdue deadline or owner/readiness loss.
    const trayGroups = new Set(safe.filter(fact => ['tray-classification', 'tray-needs-replace',
      'saved-row-replace', 'saved-row-remove'].includes(fact.payload.kind)).map(fact => fact.atomicGroup));
    if (trayGroups.size) {
      const clock = await readTrayClockBasis(db, workspace);
      const invalid = new Set([...trayGroups].filter(group => {
        const markers = safe.filter(fact => fact.atomicGroup === group && fact.payload.kind === 'tray-classification');
        return !clock?.ready || markers.length !== 1 || markers[0]!.payload.kind !== 'tray-classification'
          || markers[0]!.payload.clockVersion !== clock.clockVersion;
      }));
      const emitted = new Set<string>();
      enqueue(safe.flatMap(fact => {
        if (!invalid.has(fact.atomicGroup)) return [fact];
        if (emitted.has(fact.atomicGroup)) return [];
        emitted.add(fact.atomicGroup);
        return [{atomicGroup: fact.atomicGroup, authority: fact.authority,
          payload: {kind: 'group-unavailable' as const, scope: workspace, reason: 'dependency' as const}}];
      }));
      return;
    }
    enqueue(safe);
}

import type {TrayClockAvailability} from './tray-clock-availability.js';
import {readTrayClockBasis} from './tray-clock-basis.js';
import type { AgentUsageCell } from '@beeline/api-contract/helper-usage';
import { helperUsageEnabled, subscribeAgentUsageCells, fenceAgentUsageCellEnqueue } from './helper-usage.js';
import type { MediaMetadata } from '@beeline/api-contract/media-metadata';
import { fenceMediaMetadataEnqueue } from './phone-media.js';
import { subscribeAuthorityFences } from './router-authority-fences.js';
import {ScheduledWorkAuthorityDelivery} from './scheduled-work-authority-delivery.js';
import {readRouterBuildTicket,type RouterBuilderBasis,type RouterBuildCoordinator,type RouterBuildTicket} from './router-build-coordinator.js';
import { fenceCommandReceiptEnqueue } from './router-command-coverage.js';
import type { RouterFamily, RouterSnapshot, RouterSnapshotInput, RouterFact, RouterCapabilities } from '@beeline/api-contract/router-protocol';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import type { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { routerSourcePlan } from './router-source-plan.js';
import {readRouterRoomAudience} from './router-room-audience.js';
import {readRouterProfileAudience} from './router-profile-audience.js';
import {profileDomain} from './router-profile-source.js';
import {readRosterQuery} from './router-roster-query.js';
import {subscribeRosterAuthority} from './router-roster-authority.js';
import {ownerFamily,ownerAuthority,buildOwnerSnapshot,fenceOwnerProjection,fenceOwnerProjections,ownerFact} from './router-owner-projections.js';
import {scheduledWorkAudience} from './scheduled-work-audience.js';
import {scheduledRoomDomain} from './scheduled-work-authority.js';
import type { SqlDatabase } from './database.js';
import { PhoneOperationError } from './phone-operations.js';
import { RouterProjectionDrain, RouterProjectionUnavailable, encodeRouterBatch, fenceRouterBatch, readRouterAuthority, readRouterCertificate, deniedRouterAuthorityScope, resolveRouterInput, routerAtomicGroup, fenceRouterEnqueue } from './router-projections.js';

/** Server composition selects the supported protocols. The committed LISTEN
 * independently gates admission and current authority still fences delivery. */
export interface RouterProjectionPolicy {
  readonly needsYouRoomsV1?:boolean;
  readonly families: readonly RouterFamily[];
  readonly listenerReady: () => boolean;
  /** Installed shared control consumer, not a separate rollout switch. */
  readonly trayClockAvailability?:TrayClockAvailability;
  readonly commandDedupV1?: boolean;
  readonly roomHeadContinuityV1?:boolean;
  /** Closed compact classification needs its independent complete control
   * barrier. This is never inferred from a family or native version. */
  readonly scheduledWorkCoverageV1?:boolean;
  /** One coordinator per server, never one per socket. A caller must certify
   * the complete immutable builder/clock basis before setting this option. */
  readonly sharedBuilds?:{readonly coordinator:RouterBuildCoordinator;readonly basis:RouterBuilderBasis};
}
export function routerSocketProtocol(database: SqlDatabase, viewer: string,
  send: (frame: string) => unknown, policy?: RouterProjectionPolicy,
  sources?: { live: LiveHub; phone: PhoneService; rooms: () => readonly string[]; mediaMetadataV1?:boolean }) {
  const releases: Array<() => void> = [];
  let stopped = false;
  let usageCellV1 = false;
  let scheduledCoverage:ScheduledWorkAuthorityDelivery|undefined;
  // Transient in-flight reply fencing, not a sent/held DTO inventory. Keys are
  // weak and live only as long as the existing bounded socket request result.
  const scheduledReplies=new WeakMap<RouterSnapshot,{generation:number;owner:ScheduledWorkAuthorityDelivery|undefined;segment:string|undefined}>();
  let negotiated: readonly RouterFamily[] = [];
  let generation=0;
  let refreshAudience:(()=>Promise<void>)|undefined;
  let subscribedWorkspaces=new Set<string>();
  const acceptsAuthorityDomain=(domain:string)=>(!domain.startsWith('scheduled-work-')||negotiated.includes('room-scheduled-work'))&&
    (!domain.startsWith('profile:')||negotiated.includes('agent-profile'))&&
    (!domain.startsWith('owner:')||negotiated.some(family=>ownerFamily(family)&&domain===`owner:${viewer}:${family}`));
  return {
    supportsUsage():boolean { return usageCellV1; },
    supports(family:RouterFamily):boolean {return negotiated.includes(family);},
    close(): void { stopped = true; generation++;refreshAudience=undefined;usageCellV1 = false;scheduledCoverage=undefined; for (const release of releases.splice(0)) release(); },
    async handle(message: Record<string, unknown>): Promise<boolean> {
      if (message.type !== 'router-negotiate') return false;
      const requested = message.protocol === 1 && Array.isArray(message.families)
        ? message.families.filter((family): family is RouterFamily =>
          typeof family === 'string' && (ROUTER_FAMILIES as readonly string[]).includes(family)) : [];
      for (const release of releases.splice(0)) release();
      scheduledCoverage=undefined;
      const currentGeneration=++generation;refreshAudience=undefined;subscribedWorkspaces=new Set();
      negotiated = sources && policy?.listenerReady() ? ROUTER_FAMILIES.filter(f => requested.includes(f) && policy.families.includes(f)&&
        (f!=='room-scheduled-work'||message.authorityFencesV1===true&&policy.commandDedupV1===true)) : [];
      let releaseReady!: () => void;
      const ready = new Promise<void>(resolve => { releaseReady = resolve; });
      let authorityFencesV1=message.authorityFencesV1===true&&Boolean(sources)&&policy?.listenerReady()===true
        && (negotiated.length>0||sources?.mediaMetadataV1===true);
      usageCellV1 = message.protocol === 1 && message.usageCellV1 === true && helperUsageEnabled() && !!sources && policy?.listenerReady() === true;
      try {
      if(sources&&negotiated.includes('workspace-roster'))releases.push(subscribeRosterAuthority(database,sources.live,viewer,()=>subscribedWorkspaces,
        frame=>{if(!stopped&&generation===currentGeneration&&send(JSON.stringify(frame))===false)throw new RouterProjectionUnavailable('budget');return undefined;},
        reason=>{if(!stopped&&generation===currentGeneration)for(const workspace of subscribedWorkspaces)
          send(JSON.stringify({kind:'router-unavailable',stream:`workspace:${workspace}`,families:['workspace-roster'],reason}));},ready));
      if(sources&&negotiated.some(ownerFamily)){
        releases.push(await new RouterProjectionDrain(database,sources.live).subscribeStream(`owner:${viewer}`,async(db,from,to,causes)=>{
          const changed=new Set(causes.map(cause=>cause.ownerFamily));
          if([...changed].some(family=>typeof family!=='string'||!ownerFamily(family)))throw new RouterProjectionUnavailable('dependency');
          const snapshots:Pick<RouterSnapshot,'family'|'authority'>[]=[],facts:RouterFact[]=[];
          for(const family of negotiated.filter(ownerFamily)){
            if(changed.has(family)){
              const snapshot=await buildOwnerSnapshot(db,sources.phone,{family},viewer);snapshots.push(snapshot);facts.push(ownerFact(snapshot));
            }else{
              const authority=await ownerAuthority(db,family,viewer);snapshots.push({family,authority});
              facts.push({atomicGroup:routerAtomicGroup({family},viewer),authority,payload:{kind:'authority-fence',scope:viewer,
                authorityScope:`owner:${viewer}:${family}`,mode:'advance'}});
            }
          }
          const frames=encodeRouterBatch(from,to,facts);
          return async()=>{
            await ready;if(stopped||generation!==currentGeneration)return;
            await fenceOwnerProjections(database,snapshots,viewer,()=>{
              for(const frame of frames)if(send(JSON.stringify(frame))===false)throw new RouterProjectionUnavailable('budget');
              return undefined;
            });
          };
        },reason=>{void ready.then(()=>{if(!stopped&&generation===currentGeneration)send(JSON.stringify({
          kind:'router-unavailable',stream:`owner:${viewer}`,families:negotiated.filter(ownerFamily),reason}));});}));
      }
      if (usageCellV1 && sources) {
        await new Promise<void>((resolve, reject) => {
          const unavailable = () => {
            usageCellV1 = false;
            if (!stopped) send(JSON.stringify({ kind: 'usage-unavailable' }));
            reject(new Error('Usage listener unavailable'));
          };
          const release = subscribeAgentUsageCells(database, viewer, cell => {
            if (!stopped && usageCellV1) send(JSON.stringify({ kind: 'usage-cell', cell }));
          }, unavailable, resolve);
          releases.push(release, sources.live.subscribeProjectionUnavailable(() => { release(); unavailable(); }));
        });
      }
      if(authorityFencesV1&&sources&&message.scheduledWorkCoverageV1===true&&policy?.scheduledWorkCoverageV1===true&&negotiated.includes('room-scheduled-work')){
        try{
          const delivery=await ScheduledWorkAuthorityDelivery.open(database,sources.live,viewer,frame=>{
            if(stopped||generation!==currentGeneration)throw new RouterProjectionUnavailable('listener');
            if(frame.kind==='authority-fence'&&!acceptsAuthorityDomain(frame.authorityScope))return undefined;
            if(send(JSON.stringify(frame))===false)throw new RouterProjectionUnavailable('budget');return undefined;
          },reason=>{void ready.then(()=>{
            // This actor also owns ordinary Room/object/reader controls. Losing
            // it retires the whole shared authority source, not just compact
            // Scheduled Work coverage. A segment restart cannot restore that
            // general trust; mixed-family recovery needs new negotiation.
            if(!stopped&&generation===currentGeneration)send(JSON.stringify({kind:'router-unavailable',stream:`authority:${viewer}`,families:[],reason}));
          });},ready);
          if(stopped||generation!==currentGeneration)delivery.close();
          else{scheduledCoverage=delivery;releases.push(()=>delivery.close());}
        }catch{
          // Missing initialized control history cannot establish compact
          // coverage. Keep the established per-group family protocol.
          scheduledCoverage=undefined;
        }
      }
      if(authorityFencesV1&&sources&&!scheduledCoverage){
        const release=await subscribeAuthorityFences(database,sources.live,viewer,frame=>{
          if(!stopped)send(JSON.stringify(frame));return undefined;
        },reason=>{if(!stopped)send(JSON.stringify({kind:'router-unavailable',stream:`authority:${viewer}`,families:[],reason}));},ready,
          acceptsAuthorityDomain);
        if(stopped)release();else releases.push(release);
      }
      if (negotiated.length && sources) {
        const workspaceReleases=new Map<string,()=>void>();
        releases.push(()=>{for(const release of workspaceReleases.values())release();workspaceReleases.clear();});
        let refreshing:Promise<void>|undefined,dirty=false;
        const refresh=()=>{
          dirty=true;
          if(refreshing)return refreshing;
          const next=Promise.resolve().then(async()=>{
          try{while(dirty){
          dirty=false;
          if(stopped||generation!==currentGeneration)return;
          const workspaces = await database.query<{workspace_id:string}>(
            negotiated.includes('room-scheduled-work')?`SELECT workspace_id FROM(
              SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL
              UNION SELECT room.workspace_id FROM rooms room JOIN memberships member ON member.room_id=room.id AND member.identity_id=$1
                AND member.removed_at IS NULL JOIN identities person ON person.id=$1 AND person.kind='human' AND NOT person.hidden_from_roster
                WHERE room.parent_id IS NULL AND room.archived_at IS NULL AND room.direct_participants ? $1
            ) scopes ORDER BY workspace_id`:
            `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY workspace_id`, [viewer]);
          if(stopped||generation!==currentGeneration)return;
        for (const {workspace_id:workspace} of workspaces.rows) {
          if(subscribedWorkspaces.has(workspace))continue;
          const release = await new RouterProjectionDrain(database,sources.live).subscribe(workspace,async (db,from,to,causes) => {
            if (stopped||generation!==currentGeneration) return;
            const coverageOwner=scheduledCoverage,coverageSegment=coverageOwner?.segment;
            if(coverageOwner&&!coverageSegment)throw new RouterProjectionUnavailable('listener');
            const plan = routerSourcePlan(causes,viewer,workspace);
            const facts: RouterFact[] = [];
            const jointTray=negotiated.includes('needs-you-saved-page');
            const scopedNeedsEnabled=message.needsYouRoomsV1===true&&policy?.needsYouRoomsV1===true&&!jointTray&&
              negotiated.includes('needs-you')&&plan.families.has('needs-you')&&!plan.allRooms&&plan.rooms.size>0;
            let scopedNeeds:Awaited<ReturnType<PhoneService['buildRouterNeedsRooms']>>|undefined;
            const clock=jointTray?await readTrayClockBasis(db,workspace):undefined;
            if(jointTray){
              const input={family:'needs-you-tray',workspaceId:workspace} as const;
              const authority=await readRouterCertificate(db,input,viewer),atomicGroup=routerAtomicGroup(input,viewer);
              if(clock?.ready)facts.push({atomicGroup,authority,payload:{kind:'tray-classification',scope:workspace,version:1,clockVersion:clock.clockVersion}});
              else facts.push({atomicGroup,authority,payload:{kind:'group-unavailable',scope:workspace,reason:'dependency'}});
            }
            const roomAudience=negotiated.some(family=>family==='room-head'||family==='room-workflows')?await readRouterRoomAudience(db,workspace,viewer,plan):[];
            const scheduledAudience=negotiated.includes('room-scheduled-work')?await scheduledWorkAudience(db,workspace,viewer,plan,!!coverageOwner):[];
            for (const family of negotiated) {
              if(ownerFamily(family))continue;
              if(family==='agent-profile'){
                const audience=await readRouterProfileAudience(db,workspace,viewer,plan);
                for(const profile of audience){
                  const input={family,workspaceId:workspace,agentId:profile.agentId} as const,atomicGroup=routerAtomicGroup(input,viewer);
                  try{
                    if(!profile.changed){facts.push({atomicGroup,authority:profile.authority,payload:{kind:'authority-fence',scope:profile.agentId,
                      authorityScope:profileDomain(workspace,profile.agentId),mode:'advance'}});continue;}
                    await readRouterAuthority(db,input,viewer);
                    const value=policy?.sharedBuilds
                      ?(await policy.sharedBuilds.coordinator.build(await readRouterBuildTicket(db,input,viewer,policy.sharedBuilds.basis),
                        (tx,args,reader)=>sources.phone.buildRouterValue(tx,args,reader))).value
                      :await sources.phone.buildRouterValue(db,input,viewer);
                    if(!value)throw new RouterProjectionUnavailable('authority');
                    facts.push({atomicGroup,authority:profile.authority,payload:{kind:'scope-replace',family,scope:profile.agentId,value}} as RouterFact);
                  }catch(error){
                    if(!(error instanceof RouterProjectionUnavailable)||error.reason!=='authority')throw error;
                    facts.push({atomicGroup,authority:profile.authority,payload:{kind:'authority',...await deniedRouterAuthorityScope(db,input,viewer),allowed:false}});
                  }
                }
                continue;
              }
              if(jointTray&&!clock?.ready&&family.startsWith('needs-you'))continue;
              if(family==='needs-you-saved-page'){
                const input={family,workspaceId:workspace} as const,atomicGroup=routerAtomicGroup(input,viewer);
                try{
                  if(plan.savedTargets.length&&!plan.savedUnavailable){
                    facts.push(...await sources.phone.buildRouterSavedFacts(db,workspace,viewer,plan.savedTargets));
                    if(plan.savedHeadChanged){
                      const shared=policy?.sharedBuilds,options={trayClock:true as const};
                      const ticket=shared?await readRouterBuildTicket(db,input,viewer,shared.basis,options):undefined;
                      if(ticket&&(ticket.cut.stream!==to.stream||ticket.cut.epoch!==to.epoch||ticket.cut.through!==to.through))
                        throw new RouterProjectionUnavailable('dependency');
                      const value=ticket&&shared
                        ?(await shared.coordinator.build(ticket,(tx,args,reader)=>sources.phone.buildRouterValue(tx,args,reader,options))).value
                        :await sources.phone.buildRouterValue(db,input,viewer,options);
                      if(!value)throw new RouterProjectionUnavailable('authority');
                      facts.push({atomicGroup,authority:ticket?.authority??await readRouterAuthority(db,input,viewer),
                        payload:{kind:'scope-replace',family,scope:workspace,value}} as RouterFact);
                    }
                  }
                  else{
                    const authority=await readRouterAuthority(db,input,viewer);
                    if(plan.savedUnavailable)facts.push({atomicGroup,authority,payload:{kind:'group-unavailable',scope:workspace,reason:'dependency'}});
                    else facts.push({atomicGroup,authority,payload:{kind:'authority-fence',scope:workspace,authorityScope:`reader:${viewer}:workspace:${workspace}:visibility`,mode:'advance'}});
                  }
                }catch(error){
                  if(error instanceof RouterProjectionUnavailable&&error.reason==='authority'){
                    facts.push({atomicGroup,authority:await readRouterCertificate(db,input,viewer),
                      payload:{kind:'authority',...await deniedRouterAuthorityScope(db,input,viewer),allowed:false}});
                  }else if(error instanceof RouterProjectionUnavailable||error instanceof Error&&error.message==='saved_window_budget'){
                    facts.push({atomicGroup,authority:await readRouterCertificate(db,input,viewer),
                      payload:{kind:'group-unavailable',scope:workspace,reason:'dependency'}});
                  }else throw error;
                }
                // Only new incarnations rebuild the shared bounded live head.
                // Anchored history is never queried by a source interval.
                continue;
              }
              if(family==='room-scheduled-work'){
                for(const room of scheduledAudience){
                  const input={family,workspaceId:workspace,roomId:room.roomId} as const,atomicGroup=routerAtomicGroup(input,viewer);
                  if(!room.state||!room.state.complete){facts.push({atomicGroup,authority:room.authority,payload:{kind:'group-unavailable',scope:room.roomId,reason:'authority'}});continue;}
                  if(!room.state.allowed){facts.push({atomicGroup,authority:room.authority,payload:{kind:'authority',...room.state.denied,allowed:false}});continue;}
                  if(!room.changed){facts.push({atomicGroup,authority:room.authority,payload:{kind:'authority-fence',scope:room.roomId,authorityScope:scheduledRoomDomain(room.roomId),mode:'advance'}});continue;}
                  const value=policy?.sharedBuilds
                    ?(await policy.sharedBuilds.coordinator.build(await readRouterBuildTicket(db,input,viewer,policy.sharedBuilds.basis),
                      (tx,args,reader)=>sources.phone.buildRouterValue(tx,args,reader))).value
                    :await sources.phone.buildRouterValue(db,input,viewer);
                  if(!value)throw new RouterProjectionUnavailable('authority');
                  facts.push({atomicGroup,authority:room.authority,payload:{kind:'scope-replace',family,scope:room.roomId,value}} as RouterFact);
                }
                continue;
              }
              const affected=plan.families.has(family);
              // Workspace group names follow DB audience and the closed
              // registry. This is not a report of what a phone caches.
              const roomScoped=family==='room-head'||family==='room-workflows';
              const scopes = roomScoped ? roomAudience.map(room=>room.roomId) : [workspace];
              for (const scope of scopes) {
                const input = (roomScoped ? {family,workspaceId:workspace,roomId:scope} : {family,workspaceId:workspace}) as RouterSnapshotInput;
                const room=roomScoped?roomAudience.find(room=>room.roomId===scope):undefined;
                const changed=family==='room-workflows'?affected&&!!room&&(plan.allRooms||plan.rooms.has(scope)||room.parentId!==null&&plan.rooms.has(room.parentId)):room?.changed??affected;
                if(room&&!room.complete){
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority:room.authority,
                    payload:{kind:'group-unavailable',scope,reason:'authority'}});continue;
                }
                if(room?.denied){
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority:room.authority,
                    payload:{kind:'authority',...room.denied,allowed:false}});continue;
                }
                const options=jointTray&&family.startsWith('needs-you')?{trayClock:true as const}:undefined;
                let authority,ticket:RouterBuildTicket|undefined;
                try {
                  if(changed&&policy?.sharedBuilds&&!(jointTray&&family==='needs-you-tray')){
                    ticket=await readRouterBuildTicket(db,input,viewer,policy.sharedBuilds.basis,options);
                    if(ticket.cut.stream!==to.stream||ticket.cut.epoch!==to.epoch||ticket.cut.through!==to.through)
                      throw new RouterProjectionUnavailable('dependency');
                    authority=ticket.authority;
                  }else authority = room?.authority??await readRouterAuthority(db,input,viewer);
                }
                catch (error) {
                  if (!(error instanceof RouterProjectionUnavailable) || error.reason !== 'authority') throw error;
                  const denied=await deniedRouterAuthorityScope(db,input,viewer);
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority:await readRouterCertificate(db,input,viewer),
                    payload:{kind:'authority',...denied,allowed:false}});
                  continue;
                }
                if(!changed){
                  const group=routerAtomicGroup(input,viewer),domain=roomScoped?`room:${scope}`:family==='workspace-roster'?`roster:${workspace}`:`reader:${viewer}:workspace:${workspace}:visibility`;
                  if(!facts.some(fact=>fact.atomicGroup===group&&fact.payload.kind==='authority-fence'))
                    facts.push({atomicGroup:group,authority,payload:{kind:'authority-fence',scope:roomScoped?scope:workspace,authorityScope:domain,mode:'advance'}});
                  continue;
                }
                if(jointTray&&family==='needs-you-tray'){
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,
                    payload:{kind:'tray-needs-replace',scope:workspace,value:await sources.phone.buildRouterNeedsHead(db,workspace,viewer)}});
                  continue;
                }
                if(scopedNeedsEnabled&&family==='needs-you'){
                  scopedNeeds=await sources.phone.buildRouterNeedsRooms(db,workspace,viewer,[...plan.rooms].sort());
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,payload:scopedNeeds});continue;
                }
                if(scopedNeeds&&family==='needs-you-count'){
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,payload:{kind:'scope-replace',family,scope:workspace,value:{count:scopedNeeds.count}}});continue;
                }
                const value = ticket&&policy?.sharedBuilds
                  ?(await policy.sharedBuilds.coordinator.build(ticket,(tx,args,reader)=>sources.phone.buildRouterValue(tx,args,reader,options))).value
                  :await sources.phone.buildRouterValue(db,input,viewer,options);
                if (!value) throw new RouterProjectionUnavailable('authority');
                facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,
                  payload:{kind:'scope-replace',family,scope,value}} as RouterFact);
              }
            }
            return async () => {
              await ready;
              if (stopped||generation!==currentGeneration) return;
              const enqueue=(records:Parameters<typeof encodeRouterBatch>[2])=>{
                const frames=encodeRouterBatch(from,to,records);
                if (!stopped&&generation===currentGeneration) for (const frame of frames){
                  const accepted=send(JSON.stringify(frame));
                  if(scheduledCoverage&&accepted===false)throw new RouterProjectionUnavailable('budget');
                }
                return undefined;
              };
              if(coverageOwner){
                if(coverageOwner!==scheduledCoverage)throw new RouterProjectionUnavailable('listener');
                await coverageOwner.fenceBatch(workspace,facts,coverageSegment!,(safeFacts,authorityBarrier)=>
                  enqueue([...safeFacts,{kind:'scheduled-work-classification',version:1,authorityBarrier}]));
              }
              else await fenceRouterBatch(database,workspace,viewer,facts,enqueue);
            };
          }, reason => {
            if(generation!==currentGeneration)return;
            subscribedWorkspaces.delete(workspace);
            workspaceReleases.delete(workspace);
            if (!stopped) send(JSON.stringify({kind:'router-unavailable',stream:`workspace:${workspace}`,families:negotiated,reason}));
          });
          if (stopped||generation!==currentGeneration) release(); else {subscribedWorkspaces.add(workspace);workspaceReleases.set(workspace,release);}
        }
          }}finally{refreshing=undefined;}
          });refreshing=next;
          // One error observer per actor run, not one retained callback per
          // notification joining the same in-flight membership query.
          void next.catch(()=>{
            if(!stopped&&generation===currentGeneration)send(JSON.stringify({kind:'router-unavailable',stream:'',families:negotiated,reason:'dependency'}));
          });
          return next;
        };
        refreshAudience=refresh;
        releases.push(sources.live.subscribeJournal(streams=>{
          if(streams.includes(`authority:${viewer}`))void refresh();
        }));
        await refresh();
      }
      } catch {
        const affected = negotiated;
        negotiated = [];
        scheduledCoverage=undefined;
        authorityFencesV1=false; usageCellV1=false;
        for (const release of releases.splice(0)) release();
        send(JSON.stringify({kind:'router-unavailable',stream:'',families:affected,reason:'listener'}));
      }
      const capabilities: RouterCapabilities = { protocol: 1, families: negotiated,
        ...(message.needsYouRoomsV1===true&&policy?.needsYouRoomsV1===true&&negotiated.includes('needs-you')?{needsYouRoomsV1:true}:{}),
        ...(scheduledCoverage?{scheduledWorkCoverageV1:{version:1 as const,authorityStart:scheduledCoverage.start}}:{}),
        ...(message.roomHeadContinuityV1===true&&policy?.roomHeadContinuityV1===true&&authorityFencesV1&&negotiated.includes('room-head')?{roomHeadContinuityV1:true}:{}),
        ...(usageCellV1 ? {usageCellV1:true} : {}), commandDedupV1: policy?.commandDedupV1 === true,mediaMetadataV1:sources?.mediaMetadataV1===true&&authorityFencesV1,authorityFencesV1 };
      send(JSON.stringify({ type: 'router-capabilities', ...capabilities }));
      releaseReady();
      return true;
    },
    requireUsage(): void {
      if (!usageCellV1 || !policy?.listenerReady()) throw new PhoneOperationError(409, { error: 'usage_cell_unavailable' });
    },
    requireSnapshot(args: Record<string, unknown>): void {
      if(args.family==='workspace-roster')readRosterQuery(args.query);
      if (!policy?.listenerReady() || !negotiated.includes(args.family as RouterFamily))
        throw new PhoneOperationError(409, { error: 'router_family_unavailable' });
    },
    async snapshot(input:RouterSnapshotInput):Promise<RouterSnapshot>{
      this.requireSnapshot({...input});
      const requestGeneration=generation,coverageOwner=scheduledCoverage;
      const requestSegment=coverageOwner?.segment;
      if(input.family==='room-scheduled-work'&&coverageOwner&&!requestSegment)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      if(!sources)throw new PhoneOperationError(409,{error:'router_family_unavailable'});
      if(ownerFamily(input.family))return database.transaction(async db=>{
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return buildOwnerSnapshot(db,sources.phone,input,viewer);
      });
      const resolved=await resolveRouterInput(database,input);
      if(input.family==='room-scheduled-work'&&requestGeneration!==generation)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      const scopedInput:RouterSnapshotInput=input.family==='room-head'||input.family==='room-scheduled-work'||input.family==='room-workflows'?{...input,workspaceId:resolved.workspaceId}:input;
      if(!subscribedWorkspaces.has(resolved.workspaceId))await refreshAudience?.();
      // The subscribe-before-head barrier must already cover this server
      // scope before opening its snapshot. A concurrent new grant can fail
      // closed; it cannot relabel a snapshot whose prior interval was missed.
      if(!subscribedWorkspaces.has(resolved.workspaceId))throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      if(input.family==='room-head'||input.family==='room-workflows'){
        try{await readRouterRoomAudience(database,resolved.workspaceId,viewer,routerSourcePlan([],viewer));}
        catch(error){if(error instanceof RouterProjectionUnavailable)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});throw error;}
      }
      if(input.family==='room-scheduled-work'&&!coverageOwner){
        try{await scheduledWorkAudience(database,resolved.workspaceId,viewer,routerSourcePlan([],viewer));}
        catch(error){if(error instanceof RouterProjectionUnavailable)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});throw error;}
      }
      const options=negotiated.includes('needs-you-saved-page')&&input.family.startsWith('needs-you')?{trayClock:true as const}:undefined;
      const shared=policy?.sharedBuilds;
      const result=!shared?await sources.phone.readRouterSnapshot(scopedInput,viewer,options):await database.transaction(async tx=>{
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const ticket=await readRouterBuildTicket(tx,scopedInput,viewer,shared.basis,options);
        return shared.coordinator.build(ticket,(db,args,reader)=>sources.phone.buildRouterValue(db,args,reader,options));
      });
      if(input.family==='room-scheduled-work'){
        if(requestGeneration!==generation||coverageOwner!==scheduledCoverage||coverageOwner&&requestSegment!==coverageOwner.segment)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
        scheduledReplies.set(result,{generation:requestGeneration,owner:coverageOwner,segment:requestSegment});
      }
      return result;
    },
    async fenceReply(operation: string, args: Record<string, unknown>, result: unknown, enqueue: (safeResult?: unknown) => undefined): Promise<void> {
      if(operation==='readRoomTools'){
        await fenceRouterEnqueue(database,{family:'room-head',roomId:String(args.roomId)},viewer,
          (result as import('@beeline/api-contract/phone').RoomToolPage).authority,()=>enqueue());return;
      }
      if (operation === 'readAgentUsageCell') { this.requireUsage(); await fenceAgentUsageCellEnqueue(database, viewer, result as AgentUsageCell, cell => enqueue(cell)); return; }
      if(['readMediaMetadata','readMediaLink','readMediaPlayback'].includes(operation)){
        await fenceMediaMetadataEnqueue(database,String(args.objectId),viewer,
          operation==='readMediaMetadata'?(result as MediaMetadata).authority:undefined,()=>enqueue());return;
      }
      if (operation !== 'readRouterSnapshot') { await fenceCommandReceiptEnqueue(database,viewer,result,enqueue); return; }
      this.requireSnapshot(args);
      const snapshot = result as RouterSnapshot;
      if (snapshot?.kind !== 'snapshot' || snapshot.family !== args.family)
        throw new PhoneOperationError(503, { error: 'router_projection_unavailable' });
      if(ownerFamily(snapshot.family)){
        await fenceOwnerProjection(database,{family:snapshot.family},viewer,snapshot.authority,enqueue);return;
      }
      const pending=scheduledReplies.get(snapshot);
      if(snapshot.family==='room-scheduled-work'&&(pending&&pending.generation!==generation||scheduledCoverage&&pending?.owner!==scheduledCoverage))
        throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      if(snapshot.family==='room-scheduled-work'&&scheduledCoverage){
        if(!pending?.segment)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
        try{await scheduledCoverage.fenceSnapshot(args as RouterSnapshotInput,snapshot,pending.segment,safe=>enqueue(safe));}
        finally{scheduledReplies.delete(snapshot);}return;
      }
      await fenceRouterEnqueue(database, args as RouterSnapshotInput, viewer, snapshot.authority, enqueue, 'clockVersion' in snapshot ? snapshot.clockVersion : undefined);
    },
  };
}

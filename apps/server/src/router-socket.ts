import type {TrayClockAvailability} from './tray-clock-availability.js';
import {ROUTER_TRAY_CLOCK_STREAM} from '@beeline/api-contract/router-protocol';
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
import {scheduledWorkAudience} from './scheduled-work-audience.js';
import {scheduledRoomDomain} from './scheduled-work-authority.js';
import type { SqlDatabase } from './database.js';
import { PhoneOperationError } from './phone-operations.js';
import { RouterProjectionDrain, RouterProjectionUnavailable, encodeRouterBatch, fenceRouterBatch, readRouterAuthority, readRouterCertificate, deniedRouterAuthorityScope, resolveRouterInput, routerAtomicGroup, fenceRouterEnqueue } from './router-projections.js';

/** An explicit rollout policy, independently gated on the committed LISTEN.
 * Defaults advertise no families until capture/fence/differential proofs pass. */
export interface RouterProjectionPolicy {
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
        (f!=='room-scheduled-work'||message.authorityFencesV1===true&&policy.commandDedupV1===true)&&
        (!['needs-you-tray','needs-you-saved-page'].includes(f)||policy.trayClockAvailability!==undefined)) : [];
      let releaseReady!: () => void;
      const ready = new Promise<void>(resolve => { releaseReady = resolve; });
      let protocolReady=false,trayLossPending=false;
      const flushTrayLoss=()=>{
        if(!protocolReady||!trayLossPending||stopped||generation!==currentGeneration)return;
        trayLossPending=false;
        send(JSON.stringify({kind:'router-unavailable',stream:ROUTER_TRAY_CLOCK_STREAM,
          families:negotiated.filter(family=>family.startsWith('needs-you')),reason:'dependency'}));
      };
      if(sources&&negotiated.includes('needs-you-saved-page'))releases.push(sources.live.subscribeTrayClockUnavailable(()=>{
        trayLossPending=true;flushTrayLoss();
      }));
      let authorityFencesV1=message.authorityFencesV1===true&&Boolean(sources)&&policy?.listenerReady()===true
        && (negotiated.length>0||sources?.mediaMetadataV1===true);
      usageCellV1 = message.protocol === 1 && message.usageCellV1 === true && helperUsageEnabled() && !!sources && policy?.listenerReady() === true;
      try {
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
          domain=>!domain.startsWith('scheduled-work-')||negotiated.includes('room-scheduled-work'));
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
            ) scopes ORDER BY workspace_id LIMIT 129`:
            `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY workspace_id LIMIT 129`, [viewer]);
          if(stopped||generation!==currentGeneration)return;
          if(workspaces.rows.length>128)throw new RouterProjectionUnavailable('budget');
        for (const {workspace_id:workspace} of workspaces.rows) {
          if(subscribedWorkspaces.has(workspace))continue;
          if(subscribedWorkspaces.size>=128)throw new RouterProjectionUnavailable('budget');
          const release = await new RouterProjectionDrain(database,sources.live).subscribe(workspace,async (db,from,to,causes) => {
            if (stopped||generation!==currentGeneration) return;
            const coverageOwner=scheduledCoverage,coverageSegment=coverageOwner?.segment;
            if(coverageOwner&&!coverageSegment)throw new RouterProjectionUnavailable('listener');
            const plan = routerSourcePlan(causes,viewer,workspace);
            const facts: RouterFact[] = [];
            const jointTray=negotiated.includes('needs-you-saved-page');
            const clock=jointTray&&policy?.trayClockAvailability?.ready()?await readTrayClockBasis(db,workspace):undefined;
            if(jointTray){
              const input={family:'needs-you-tray',workspaceId:workspace} as const;
              const authority=await readRouterCertificate(db,input,viewer),atomicGroup=routerAtomicGroup(input,viewer);
              if(clock?.ready)facts.push({atomicGroup,authority,payload:{kind:'tray-classification',scope:workspace,version:1,clockVersion:clock.clockVersion}});
              else facts.push({atomicGroup,authority,payload:{kind:'group-unavailable',scope:workspace,reason:'dependency'}});
            }
            const roomAudience=negotiated.includes('room-head')?await readRouterRoomAudience(db,workspace,viewer,plan):[];
            const scheduledAudience=negotiated.includes('room-scheduled-work')?await scheduledWorkAudience(db,workspace,viewer,plan,!!coverageOwner):[];
            for (const family of negotiated) {
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
              const scopes = family === 'room-head' ? roomAudience.map(room=>room.roomId) : [workspace];
              for (const scope of scopes) {
                const input = (family==='room-head' ? {family,workspaceId:workspace,roomId:scope} : {family,workspaceId:workspace}) satisfies RouterSnapshotInput;
                const room=family==='room-head'?roomAudience.find(room=>room.roomId===scope):undefined;
                const changed=room?.changed??affected;
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
                  const group=routerAtomicGroup(input,viewer),domain=family==='room-head'?`room:${scope}`:`reader:${viewer}:workspace:${workspace}:visibility`;
                  if(!facts.some(fact=>fact.atomicGroup===group&&fact.payload.kind==='authority-fence'))
                    facts.push({atomicGroup:group,authority,payload:{kind:'authority-fence',scope:family==='room-head'?scope:workspace,authorityScope:domain,mode:'advance'}});
                  continue;
                }
                if(jointTray&&family==='needs-you-tray'){
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,
                    payload:{kind:'tray-needs-replace',scope:workspace,value:await sources.phone.buildRouterNeedsHead(db,workspace,viewer)}});
                  continue;
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
        ...(scheduledCoverage?{scheduledWorkCoverageV1:{version:1 as const,authorityStart:scheduledCoverage.start}}:{}),
        ...(message.roomHeadContinuityV1===true&&policy?.roomHeadContinuityV1===true&&authorityFencesV1&&negotiated.includes('room-head')?{roomHeadContinuityV1:true}:{}),
        ...(usageCellV1 ? {usageCellV1:true} : {}), commandDedupV1: policy?.commandDedupV1 === true,mediaMetadataV1:sources?.mediaMetadataV1===true&&authorityFencesV1,authorityFencesV1 };
      send(JSON.stringify({ type: 'router-capabilities', ...capabilities }));
      protocolReady=true;releaseReady();flushTrayLoss();
      return true;
    },
    requireUsage(): void {
      if (!usageCellV1 || !policy?.listenerReady()) throw new PhoneOperationError(409, { error: 'usage_cell_unavailable' });
    },
    requireSnapshot(args: Record<string, unknown>): void {
      if(negotiated.includes('needs-you-saved-page')&&typeof args.family==='string'&&args.family.startsWith('needs-you')&&
        policy?.trayClockAvailability?.ready()!==true)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      if (!policy?.listenerReady() || !negotiated.includes(args.family as RouterFamily))
        throw new PhoneOperationError(409, { error: 'router_family_unavailable' });
    },
    async snapshot(input:RouterSnapshotInput):Promise<RouterSnapshot>{
      this.requireSnapshot({...input});
      const requestGeneration=generation,coverageOwner=scheduledCoverage;
      const requestSegment=coverageOwner?.segment;
      if(input.family==='room-scheduled-work'&&coverageOwner&&!requestSegment)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      if(!sources)throw new PhoneOperationError(409,{error:'router_family_unavailable'});
      const resolved=await resolveRouterInput(database,input);
      if(input.family==='room-scheduled-work'&&requestGeneration!==generation)throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      const scopedInput:RouterSnapshotInput=input.family==='room-head'||input.family==='room-scheduled-work'?{...input,workspaceId:resolved.workspaceId}:input;
      if(!subscribedWorkspaces.has(resolved.workspaceId))await refreshAudience?.();
      // The subscribe-before-head barrier must already cover this server
      // scope before opening its snapshot. A concurrent new grant can fail
      // closed; it cannot relabel a snapshot whose prior interval was missed.
      if(!subscribedWorkspaces.has(resolved.workspaceId))throw new PhoneOperationError(503,{error:'router_projection_unavailable'});
      if(input.family==='room-head'){
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

import type { SavedRowPayload, TrayGroupPayload, NeedsYouRoomsPayload,RouterFamily,RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
import { trayFamily } from './tray-group.js';
import { ProjectionGroups, type GroupCell, type GroupProposal } from './projection-groups.js';
import { jsonBytes as bytes } from './staging-bounds.js';
import { LaneStaging, sameStream } from './lane-staging.js';
/** Local state only. No transport, clock, scheduler, native module or server inventory. */
export type LaneFamily=RouterFamily;
export type LaneRequest=RouterSnapshotInput;
export type LaneCut = Readonly<{ stream: string; epoch: string; through: number; protocol: 1 }>;
export type LaneAuthority = Readonly<{ digest: string; scopes: readonly Readonly<{ authorityScope: string; epoch: string }>[] }>;
export type LaneSnapshot = Readonly<{ kind: 'snapshot'; value: unknown; cut: LaneCut; atomicGroup: string; authority: LaneAuthority;clockVersion?:string }>;
export type LaneState = 'ABSENT' | 'OPENING' | 'LIVE' | 'PARKED' | 'INACTIVE_CACHED' | 'REVOKED';
export type LaneView = Readonly<{ state: LaneState; value: unknown | null; error: string | null; cut: LaneCut | null }>;
export type LaneFact = Readonly<{ atomicGroup: string; authority: LaneAuthority; payload:SavedRowPayload|TrayGroupPayload|NeedsYouRoomsPayload
  | { kind: 'scope-replace'; family: LaneFamily; scope: string; value: unknown }
  | { kind: 'authority'; scope: string; authorityScope?: string; allowed: boolean }
  | {kind:'authority-fence';scope:string;authorityScope:string;mode:'deny'|'advance'}
  | {kind:'group-unavailable';scope:string;reason:'authority'|'dependency'} }>;
export type LaneAuthorityPosition = Readonly<{stream: `authority:${string}`; epoch: string; segment: string; through: number; protocol: 1}>;
export type LaneClassification = Readonly<{kind: 'scheduled-work-classification'; version: 1; authorityBarrier: LaneAuthorityPosition}>;
export type LaneBatch = Readonly<{ from: LaneCut; to: LaneCut; facts: readonly LaneFact[]; scheduledWorkClassification?: LaneClassification;contentDigest?:string }>;
export type LaneIdentity = Readonly<{ origin: string; principal: string; sessionEpoch: number }>;
export type LanePermit = Readonly<{ isCurrent(): boolean }>;
export type LaneStorage = {
  /** One encoded atomic consistency group, including data and coverage. */
  write(key: string, encoded: string): Promise<void>;
  /** Fences are outside response LRU. This completes before a removal publishes. */
  fence(scope: string, epoch: string): Promise<void>;
  /** Minimum allowed authority epoch; equality remains authorized. */
  floor?(scope:string,epoch:string):Promise<void>;
  remove(key: string): Promise<void>;
};
type Owner = { permit: LanePermit; active: boolean };
type Arrival={batch:LaneBatch;session:number;generation:number;replay:boolean;done():void;promise:Promise<void>};
type Entry=GroupCell&{owners:Map<object,Owner>;listeners:Set<()=>void>};
const SCHEDULED_FAMILY='room-scheduled-work';
const ABSENT_VIEW: LaneView = Object.freeze({ state: 'ABSENT', value: null, error: null, cut: null });
const absent = (): LaneView => ABSENT_VIEW;
const liveOwner = (entry: Entry): boolean => [...entry.owners.values()].some(owner => owner.active && owner.permit.isCurrent());
const roomFamily=(family:LaneFamily):boolean=>family==='room-head'||family===SCHEDULED_FAMILY||family==='room-workflows';
// The original projection cohort has no proven inactive Room feed. Only an
// explicitly negotiated DB-audience feed can lift that conservative guard.


/** An executor is installed only by the negotiated connection owner. Demand
 * arrives only after admission has atomically consumed a real owner pass.
 * Missed or unreadable updates re-read their affected demand in place.
 */
const AUTHORITY_FENCE_KIND='authority-fence';
const UNAVAILABLE='Projection unavailable; Retry.', ACCESS_REMOVED='Access removed.';
export class ReadLanes {
  private get entries():Map<string,Entry>{return this.groups.cells;}
  private readonly fences = new Map<string, string>();
  private readonly floors = new Map<string,string>();
  private readonly joined = new WeakMap<object, { key: string; entry: Entry }>();
  private generation = -1;
  private session = 0;
  private executor?: (request: LaneRequest) => Promise<LaneSnapshot>;
  private families = new Set<LaneFamily>();
  private continuousRooms=false;
  private scheduledCoverage=false;
  private serial: Promise<void> = Promise.resolve();
  private readonly staging=new LaneStaging();
  private readonly groups:ProjectionGroups<Entry>;
  private arrivals:Arrival[]=[];
  private activeArrival?:Arrival;
  private draining=false;
  private readonly interrupted=new Set<string>();

  constructor(private readonly identity: LaneIdentity,
    private readonly validate: (request: LaneRequest, value: unknown) => boolean,
    private readonly storage?: LaneStorage) {this.groups=new ProjectionGroups(identity.principal,validate,authority=>this.authorized(authority),this.staging,(cell,error)=>this.repair(cell,error));}

  key(request: LaneRequest): string {
    return JSON.stringify([this.identity.origin, this.identity.principal, this.identity.sessionEpoch,
      request.family, roomFamily(request.family) ? '' : request.workspaceId,
      request.family==='workspace-roster'&&request.query?JSON.stringify(request.query):request.family==='needs-you-saved-page'?request.before??'':request.agentId??request.roomId??'',1]);
  }
  /** Optional caller-known Workspace is a constraint on the canonical Room
   * identity, never another Room-head cache address or read budget.
   */
  constrain(request: LaneRequest): void { this.entry(request); }
  supports(family: LaneFamily): boolean { return this.families.has(family); }
  peek(request: LaneRequest): LaneView {
    const entry = this.entries.get(this.key(request));
    const installed=entry?.snapshot??entry?.baseline;
    if (entry && roomFamily(request.family) && request.workspaceId &&
        (entry.expectedWorkspace && entry.expectedWorkspace !== request.workspaceId ||
         installed && installed.cut.stream !== `workspace:${request.workspaceId}`)) throw new Error('Room Workspace mismatch');
    return entry?.view ?? absent();
  }
  subscribe(request: LaneRequest, listener: () => void): () => void {
    const entry = this.entry(request);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  /** Every real successful socket epoch gets one frozen recovery demand set.
   * Focus attachment during recovery joins the same flight. No hidden lane is read.
   */
  connected(generation: number, families: readonly LaneFamily[], execute: (request: LaneRequest) => Promise<LaneSnapshot>,
    options?:{readonly roomHeadContinuityV1?:boolean; readonly scheduledWorkCoverageV1?:boolean}): void {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) throw new Error('stale lane connection');
    this.generation = generation;
    for(const item of this.arrivals)item.done();this.arrivals=[];this.interrupted.clear();
    for(const entry of this.entries.values()){entry.revision++;entry.flight=undefined;this.clearQueued(entry);}
    this.groups.clear();
    this.executor = execute;
    this.families = new Set(families);this.groups.configure(this.jointMode());
    this.continuousRooms=options?.roomHeadContinuityV1===true;
    this.scheduledCoverage=options?.scheduledWorkCoverageV1===true;
    if(this.jointMode()){
      const changed=[...this.entries.values()].filter(entry=>this.joint(entry));
      for(const entry of changed){entry.snapshot=undefined;entry.baseline=undefined;entry.classified=undefined;entry.covered=false;entry.view=absent();}
      for(const entry of changed)this.notify(entry);
    }
    const demanded = [...this.entries.values()].filter(liveOwner);
    for (const entry of demanded) {
      entry.revision += 1;
      entry.flight = undefined;
      this.clearQueued(entry);
      if (this.supports(entry.request.family)) this.open(entry);
      else this.publish(entry, { ...absent(), state: 'PARKED', error: 'Projection unavailable.' });
    }
  }

  /** Interruption hides private data until a newly authorized snapshot. */
  disconnected(): void {
    for(const item of this.arrivals)item.done();this.arrivals=[];this.interrupted.clear();
    this.groups.clear();
    this.executor = undefined;
    this.families.clear();
    this.continuousRooms=false;this.scheduledCoverage=false;
    for (const entry of this.entries.values()) {
      this.transition(entry,{...absent(),state:'PARKED',error:'Connection interrupted; Retry.'});this.notify(entry);
    }
  }

  /** Replaying effect setup with the same token only reattaches its owner.
   * The caller spends a pass before the first invocation, including joins.
   */
  demand(request: LaneRequest, token: object, permit: LanePermit): () => void {
    const key = this.key(request);
    const previous = this.joined.get(token);
    if (previous && previous.key !== key) throw new Error('lane owner key changed');
    this.constrain(request);
    const entry = previous?.entry ?? this.entry(request);
    if (!previous) this.joined.set(token, { key, entry });
    const owner: Owner = { permit, active: true };
    entry.owners.set(token, owner);
    if(permit.isCurrent()&&this.continuouslyFed(request.family)&&entry.view.state==='INACTIVE_CACHED'&&entry.snapshot&&entry.covered&&
      entry.connection===this.generation&&!entry.flight&&!entry.committing&&!entry.queued.size&&
      this.supports(request.family)&&this.authorized(entry.snapshot.authority))
      this.publish(entry,{state:'LIVE',value:entry.snapshot.value,cut:entry.snapshot.cut,error:null});
    if (permit.isCurrent() && !entry.flight && entry.view.state !== 'LIVE' && !previous && this.supports(request.family)) this.open(entry);
    return () => {
      if (entry.owners.get(token) !== owner) return;
      owner.active = false; entry.owners.delete(token);
      if (!liveOwner(entry)) {
        // LIVE+covered is published only after a successful coherent commit.
        // The opening promise may still be unwinding after that notification;
        // its tail cannot invalidate this coverage when no facts are queued.
        const reusable=this.continuouslyFed(entry.request.family)&&entry.view.state==='LIVE'&&entry.covered&&!entry.committing&&!entry.queued.size;
        if(!reusable)entry.covered=false;
        // A pending reply can no longer paint or restore authority.
        entry.revision += 1; entry.flight = undefined;
        this.clearQueued(entry);
        if(!this.continuouslyFed(entry.request.family)){
          entry.snapshot=undefined;entry.baseline=undefined;
          const state=entry.view.state==='REVOKED'?'REVOKED':'PARKED';
          this.publish(entry,{...absent(),state,error:state==='REVOKED'?ACCESS_REMOVED:UNAVAILABLE});
          this.evict();return;
        }
        const state=entry.view.state==='PARKED'||entry.view.state==='REVOKED'?entry.view.state:
          reusable?'INACTIVE_CACHED':entry.snapshot?'PARKED':'ABSENT';
        this.publish(entry, { ...entry.view, state,error:state==='PARKED'?(entry.view.error??'Connection interrupted; Retry.'):entry.view.error });
      }
      this.evict();
    };
  }
  private continuouslyFed(family:LaneFamily):boolean{return family!=='room-head'||this.continuousRooms;}

  /** Explicit Retry is passed an independently spent synchronous gesture. */
  retry(request: LaneRequest, permit: LanePermit): void {
    const entry = this.entry(request);
    if (!permit.isCurrent() || !liveOwner(entry) || !this.supports(request.family) || entry.flight) return;
    this.open(entry);
  }

  /** Complete, digest-verified logical batches only. The assembly owner never
   * sends partial facts here. Serialize persistence and publication in stream order.
   */
  accept(batch: LaneBatch): Promise<void> {return this.queueBatch(batch,false);}
  private queueBatch(batch:LaneBatch,replay:boolean):Promise<void>{
    const stream=batch.to.stream;
    if(this.interrupted.has(stream))return Promise.resolve();
    try{batch=JSON.parse(JSON.stringify(batch)) as LaneBatch;}catch{this.parkStream(stream,'Invalid projection; Retry.');return Promise.resolve();}
    const held=[...(this.activeArrival?[this.activeArrival]:[]),...this.arrivals];
    const duplicate=held.find(item=>item.generation===this.generation&&item.session===this.session&&item.replay===replay&&item.batch.from.through===batch.from.through&&
      item.batch.to.through===batch.to.through&&sameStream(item.batch.to,batch.to));
    if(duplicate){
      if(JSON.stringify(duplicate.batch)!==JSON.stringify(batch)){this.interrupted.add(stream);this.parkStream(stream,'Conflicting projection; Retry.');}
      return duplicate.promise;
    }
    let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve;});
    this.arrivals.push({batch,session:this.session,generation:this.generation,replay,done,promise});this.drainArrivals();return promise;
  }
  private drainArrivals():void{
    if(this.draining||!this.arrivals.length)return;
    this.draining=true;
    const item=this.arrivals.shift()!;this.activeArrival=item;
    const work=this.serial.then(()=>this.applyBatch(item.batch,item.session,item.generation,item.replay));
    this.serial=work.catch(()=>{if(item.session===this.session&&item.generation===this.generation)this.parkStream(item.batch.to.stream,'Projection storage failed; Retry.');});
    void this.serial.finally(()=>{item.done();this.activeArrival=undefined;this.draining=false;this.drainArrivals();});
  }
  private async applyBatch(batch:LaneBatch,session:number,generation:number,replay:boolean):Promise<void>{
      if (session !== this.session||generation!==this.generation) return;
      for (const fact of batch.facts) {
        if(fact.payload.kind==='group-unavailable'){
          await this.unavailableGroup(batch.to.stream,fact.atomicGroup);continue;
        }
        if(fact.payload.kind!==AUTHORITY_FENCE_KIND&&(fact.payload.kind!=='authority'||fact.payload.allowed))continue;
        const mode=fact.payload.kind===AUTHORITY_FENCE_KIND?fact.payload.mode:'deny';
        const logicalScope = fact.payload.scope;
        // Wire removal separates logical resource scope from the exact
        // denied permission domain. Never infer denial from another domain
        // that merely shares this complete certificate.
        const targetDomain = fact.payload.authorityScope;
        const streamWorkspace = batch.to.stream.startsWith('workspace:') ? batch.to.stream.slice('workspace:'.length) : undefined;
        const readerFits=!!streamWorkspace&&fact.authority.scopes.some(scope=>scope.authorityScope===`reader:${this.identity.principal}:workspace:${streamWorkspace}`);
        const roomFits = targetDomain === `room:${logicalScope}` && readerFits;
        const domainFits = roomFits || batch.to.stream === `workspace:${logicalScope}`&&
          (targetDomain === `reader:${this.identity.principal}:workspace:${logicalScope}`||
            targetDomain===`roster:${logicalScope}`&&fact.atomicGroup.startsWith('workspace-roster:')||
            mode==='advance'&&targetDomain===`reader:${this.identity.principal}:workspace:${logicalScope}:visibility`);
        const scheduledFits=fact.atomicGroup.startsWith('room-scheduled-work:')&&fact.atomicGroup.endsWith(`:${this.identity.principal}`)&&(
          targetDomain===`scheduled-work-principal:${this.identity.principal}`&&logicalScope===this.identity.principal||
          targetDomain===`scheduled-work-manager:${this.identity.principal}:workspace:${logicalScope}`&&batch.to.stream===`workspace:${logicalScope}`||
          targetDomain===`scheduled-work-member:${this.identity.principal}:room:${logicalScope}`||targetDomain===`scheduled-work-room:${logicalScope}`);
        const profileFits=readerFits&&targetDomain===`profile:${streamWorkspace}:${logicalScope}`&&
          fact.atomicGroup===`agent-profile:${streamWorkspace}:${logicalScope}:${this.identity.principal}`;
        const ownerFits=batch.to.stream===`owner:${this.identity.principal}`&&logicalScope===this.identity.principal&&
          targetDomain?.startsWith(`owner:${this.identity.principal}:owner-`);
        const target = domainFits||scheduledFits||profileFits||ownerFits ? fact.authority.scopes.find(scope => scope.authorityScope === targetDomain) : undefined;
        if (!target||!/^\d+$/.test(target.epoch)) {
          if(fact.payload.kind===AUTHORITY_FENCE_KIND){await this.unavailableGroup(batch.to.stream,fact.atomicGroup);continue;}
          for (const entry of this.entries.values()) if (entry.request.roomId === logicalScope ||
              entry.request.workspaceId === logicalScope || entry.snapshot?.cut.stream === `workspace:${logicalScope}`) {
            this.transition(entry,{...absent(),state:'PARKED',error:'Unknown authority.'});this.notify(entry);
          }
          continue;
        }
        const affected=[...this.entries.values()].filter(entry=>{
          const held=entry.snapshot??entry.baseline;
          if(!held||held.atomicGroup!==fact.atomicGroup||!sameStream(held.cut,batch.to))return false;
          if(entry.request.family==='room-head'&&!fact.authority.scopes.some(scope=>scope.authorityScope===`room:${entry.request.roomId}`))return false;
          // An older control cannot erase a subsequently authorized chain.
          return !held.authority.scopes.some(prior=>fact.authority.scopes.some(now=>now.authorityScope===prior.authorityScope&&
            /^\d+$/.test(prior.epoch)&&/^\d+$/.test(now.epoch)&&BigInt(prior.epoch)>BigInt(now.epoch)));
        });
        if(mode==='advance')await this.advance(target.authorityScope,target.epoch);
        else{
          await this.revoke(target.authorityScope,target.epoch);
          // A new parent may not exist in an older cached chain. This group's
          // explicit current denial still hides that older payload/flight.
          for(const entry of affected)if(entry.view.state!=='REVOKED')this.retire(entry);
          if(affected.length)await this.storage?.remove(this.groupStorageKey(fact.atomicGroup));
        }
        for(const entry of affected){
          const held=entry.snapshot??entry.baseline;if(!held)continue;
          const progress=entry.classified??held.cut;
          if(sameStream(progress,batch.from)&&batch.from.through<=progress.through&&batch.to.through>progress.through)
            entry.classified=batch.to;
        }
      }
      if(session!==this.session||generation!==this.generation)return;
      const current=()=>session===this.session&&generation===this.generation;
      const work=this.groups.stage(batch,replay,generation,this.scheduledCoverage,current);
      if(!current())return;
      for(const group of work.unavailable)await this.unavailableGroup(batch.to.stream,group);
      for(const proposal of work.proposals){
        try{await this.installGroup(proposal,session,generation);}
        catch(error){
          if(!proposal.group)throw error;
          if(session===this.session&&generation===this.generation)for(const{cell}of proposal.items)this.park(cell,'Projection storage failed; Retry.');
        }
      }
      if(session!==this.session||generation!==this.generation)return;
      for(const future of this.groups.ready())void this.queueBatch(future,true);
  }

  /** Data recovery reuses the negotiated executor and current visible owners. */
  refresh(matches: (request: LaneRequest, stream: string) => boolean = () => true, hide = false): void {
    const affected = [...this.entries.values()].filter(entry => matches(entry.request,
      entry.snapshot?.cut.stream ?? entry.baseline?.cut.stream ?? `workspace:${entry.request.workspaceId}`));
    for (const entry of affected) {
      if (hide) { this.transition(entry, { ...absent(), state: 'PARKED', error: UNAVAILABLE }); this.notify(entry); }
      else this.parkItem(entry, UNAVAILABLE);
    }
    for (const entry of affected) if (liveOwner(entry)) this.open(entry);
  }

  unavailable(stream: string, family: LaneFamily, _reason = UNAVAILABLE): void {
    this.refresh((request, heldStream) => request.family === family && (!stream || heldStream === stream));
  }

  /** Losing a control source invalidates all data depending on that source,
   * without disconnecting other families or admitting a new read. */
  hideFamily(family:LaneFamily,reason='Authority unavailable; Retry.'):void{
    if(this.jointMode()&&trayFamily(family)){
      const streams=new Set([...this.entries.values()].filter(entry=>entry.request.family===family).map(entry=>`workspace:${entry.request.workspaceId}`));
      for(const stream of streams)this.parkTrayStream(stream);return;
    }
    for(const entry of this.entries.values())if(entry.request.family===family){
      this.transition(entry,{...absent(),state:'PARKED',error:reason});this.notify(entry);
    }
  }
  async unavailableGroup(stream:string,group:string):Promise<void>{
    this.groups.clear(group,stream);
    const changed:Entry[]=[];
    for(const entry of this.entries.values()){
      const held=entry.snapshot??entry.baseline;
      const canonical=roomFamily(entry.request.family)?`${entry.request.family}:${entry.request.roomId}:${this.identity.principal}`:
        `${entry.request.family.startsWith('needs-you')?'needs-you':entry.request.family}:${entry.request.workspaceId}:${entry.request.agentId?entry.request.agentId+':':''}${this.identity.principal}`;
      if(held?held.atomicGroup!==group||held.cut.stream!==stream:
        canonical!==group||(entry.request.workspaceId?stream!==`workspace:${entry.request.workspaceId}`:!stream.startsWith('workspace:')))continue;
      this.transition(entry,{...absent(),state:'PARKED',error:UNAVAILABLE});changed.push(entry);
    }
    for(const entry of changed)this.notify(entry);
    if(changed.length)await this.storage?.remove(this.groupStorageKey(group));
  }
  private groupStorageKey(group:string):string{return JSON.stringify([this.identity.origin,this.identity.principal,group]);}
  /** One invalidation primitive: payload retention, content-free continuity and
   * safe queued replacements are explicit. Callers set every affected view
   * before notification, and storage remains owned by the same serial actor. */
  private transition(entry:Entry,view:LaneView,retain:'clear'|'baseline'|'keep'='clear',future?:LaneBatch[],continuity=false):void{
    entry.revision++;entry.flight=undefined;entry.covered=false;
    if(retain==='clear')entry.baseline=undefined;
    else if(retain==='baseline'&&entry.snapshot){const{value:_value,...baseline}=entry.snapshot;entry.baseline=baseline;}
    if(retain!=='keep')entry.snapshot=undefined;
    if(!continuity)entry.classified=undefined;
    this.clearQueued(entry);
    if(future)for(const batch of future)entry.queued.add(batch,batch.facts,bytes(batch),true);
    entry.view=Object.freeze(view);
  }
  private retire(entry:Entry):void{
    const future=this.groups.salvage(entry,(entry.snapshot??entry.baseline)?.atomicGroup??'');
    this.transition(entry,{...absent(),state:'REVOKED',error:ACCESS_REMOVED},'baseline',future,true);this.notify(entry);
  }

  /** Retire only strictly older certificates. Keep no hidden content, make no
   * read, and retain only continuity needed for an ordinary fresh replacement.
   * This is distinct from a current denial and does not create a pass. */
  advance(scope:string,epoch:string,persist=true):Promise<void>{return this.adopt(scope,epoch,false,persist);}

  /** Inclusive durable denial; minimum floors above deliberately allow equality.
   * Both hide every affected view before publishing or awaiting persistence. */
  revoke(scope:string,epoch:string,persist=true):Promise<void>{return this.adopt(scope,epoch,true,persist);}
  private async adopt(scope:string,epoch:string,deny:boolean,persist:boolean):Promise<void>{
    if(!/^\d+$/.test(epoch))return;
    const ledger=deny?this.fences:this.floors,previous=ledger.get(scope),next=BigInt(epoch);
    if(previous&&BigInt(previous)>=next)return;
    ledger.set(scope,epoch);
    const roomId=scope.startsWith('room:')?scope.slice(5):undefined;
    const prefix=`reader:${this.identity.principal}:workspace:`,workspaceId=scope.startsWith(prefix)?scope.slice(prefix.length):undefined;
    const changed:Entry[]=[];
    for(const entry of this.entries.values()){
      const snapshot=entry.snapshot??entry.baseline;
      const installed=snapshot?.authority.scopes.find(authority=>authority.authorityScope===scope);
      if(deny){
        // A delayed deny cannot erase a newer grant. Cold Room/Workspace
        // requests are fenced even before their first certificate arrives.
        if(installed&&/^\d+$/.test(installed.epoch)&&BigInt(installed.epoch)>next)continue;
        if(!installed&&!(roomId&&entry.request.family==='room-head'&&entry.request.roomId===roomId)&&
          !(workspaceId&&entry.request.family!==SCHEDULED_FAMILY&&(entry.request.workspaceId===workspaceId||entry.snapshot?.cut.stream===`workspace:${workspaceId}`)))continue;
      }else if(!installed||/^\d+$/.test(installed.epoch)&&BigInt(installed.epoch)>=next)continue;
      const group=snapshot?.atomicGroup??`needs-you:${entry.request.workspaceId}:${this.identity.principal}`;
      this.groups.clear(group,snapshot?.cut.stream??(entry.request.workspaceId?`workspace:${entry.request.workspaceId}`:undefined));
      const sealed=entry.request.family==='workspace-roster'&&!!entry.request.query;
      const future=sealed?undefined:this.groups.salvage(entry,snapshot?.atomicGroup??'');
      const joint=this.joint(entry);
      const rebase=entry.request.family==='workspace-roster'&&!deny;
      const view:LaneView=deny?{...absent(),state:'REVOKED',error:ACCESS_REMOVED}:
        {state:rebase||future&&!joint?(liveOwner(entry)?'OPENING':'INACTIVE_CACHED'):'PARKED',value:null,
          error:rebase?null:joint?UNAVAILABLE:future?null:'Projection queue overflow; Retry.',cut:snapshot!.cut};
      this.transition(entry,view,'baseline',future,true);changed.push(entry);
    }
    this.pruneQueued();
    for(const entry of changed)this.notify(entry);
    if(persist&&this.storage){
      if(deny)await this.storage.fence(scope,epoch);
      else{if(!this.storage.floor)throw new Error('Authority floor storage unavailable.');await this.storage.floor(scope,epoch);}
    }
    for(const entry of changed)await this.storage?.remove(entry.key);
    if(!deny)for(const entry of changed)if(entry.request.family==='workspace-roster'&&liveOwner(entry))this.open(entry);
  }

  reset(): void {
    this.session += 1; this.disconnected();
    for (const entry of this.entries.values()) { entry.snapshot = undefined; this.publish(entry, absent()); }
    this.entries.clear(); this.fences.clear();this.floors.clear();
  }

  private entry(request: LaneRequest): Entry {
    if(request.family==='needs-you-saved-page'&&request.before!==undefined&&
      (request.before.length>1024||!/^saved1\.[a-zA-Z0-9_-]+$/.test(request.before)))throw new Error('invalid Saved cursor');
    const key = this.key(request);
    let entry = this.entries.get(key);
    if (!entry) {
      if (roomFamily(request.family) ? !request.roomId : !request.workspaceId&&!request.family.startsWith('owner-')) throw new Error('invalid lane scope');
      entry = { key, request: Object.freeze({ ...request }), view: absent(), owners: new Map(), revision: 0,
        connection: -1,covered:false,committing:0, queued: this.staging.stage(), listeners: new Set() };
      this.entries.set(key, entry); this.evict();
    }
    if (roomFamily(request.family) && request.workspaceId) {
      const installed=entry.snapshot??entry.baseline;
      if (entry.expectedWorkspace && entry.expectedWorkspace !== request.workspaceId ||
          installed && installed.cut.stream !== `workspace:${request.workspaceId}`) throw new Error('Room Workspace mismatch');
      entry.expectedWorkspace = request.workspaceId;
    }
    return entry;
  }
  private open(entry: Entry): void {
    const execute = this.executor;
    if (!execute || !liveOwner(entry) || entry.flight) return;
    this.interrupted.delete(`workspace:${entry.request.workspaceId}`);
    if(this.groups.begin(entry)){this.hideTray(this.groups.group(entry.request.workspaceId!));this.groups.begin(entry);}
    const revision = ++entry.revision; const session = this.session; const generation = this.generation;
    entry.classified=undefined;
    entry.covered=false;
    entry.connection = generation;
    this.publish(entry, { state: 'OPENING', value: entry.view.value, error: null, cut: entry.view.cut });
    const current = () => session === this.session && generation === this.generation && revision === entry.revision && liveOwner(entry);
    // Recheck immediately before dispatch, with no intervening await.
    if (!current()) return;
    const flight = Promise.resolve().then(() => current() ? execute(entry.request) : undefined).then(async snapshot => {
      if (!snapshot || !current()) return;
      // Snapshot installation uses the same serial actor as committed facts.
      const install = this.serial.then(async () => {
        if (!current()) return;
        let proposal:GroupProposal<Entry>|undefined;
        try{proposal=this.groups.snapshot(entry,snapshot);}catch{this.parkItem(entry,'Invalid snapshot; Retry.');return;}
        if(proposal)await this.installGroup(proposal,session,generation);
      });
      this.serial = install.catch(() => { if (current()) this.park(entry, 'Projection storage failed; Retry.'); });
      await this.serial;
    }).catch(() => { if (current()) this.parkItem(entry, 'This item could not be loaded; Retry.'); }).finally(() => {
      if (entry.flight !== flight) return;
      entry.flight = undefined;
      for (const batch of entry.queued.take()) void this.queueBatch(batch,true);
    });
    entry.flight = flight;
  }
  private authorized(authority: LaneAuthority): boolean {
    return !!authority.digest && authority.scopes.length > 0 && authority.scopes.length <= 8 &&
      authority.scopes.every(scope => !!scope.authorityScope && !!scope.epoch &&
        /^\d+$/.test(scope.epoch) &&
        (!this.floors.has(scope.authorityScope)||BigInt(scope.epoch)>=BigInt(this.floors.get(scope.authorityScope)!))&&
        (!this.fences.has(scope.authorityScope) || BigInt(scope.epoch) > BigInt(this.fences.get(scope.authorityScope)!)));
  }
  /** Every policy uses one version-fenced whole-group write and publication. */
  private async installGroup(proposal:GroupProposal<Entry>,session:number,generation:number):Promise<void>{
    if(session!==this.session||generation!==this.generation)return;
    const {items,whole,id}=proposal;
    const authorityCurrent=()=>whole.every(item=>this.authorized(item.snapshot.authority));
    if(!this.groups.current(proposal)){
      if(!authorityCurrent())for(const{cell}of items)this.park(cell,'Authority changed; Retry.');return;
    }
    const encoded=JSON.stringify({schema:1,identity:this.identity,group:id,
      entries:whole.map(({cell,snapshot})=>({key:cell.key,request:cell.request,snapshot}))});
    for(const{cell}of items)cell.committing++;
    try{await this.storage?.write(this.groupStorageKey(id),encoded);}
    finally{for(const{cell}of items)cell.committing--;}
    if(session!==this.session||generation!==this.generation)return;
    if(!this.groups.committed(proposal)){
      if(!authorityCurrent())for(const{cell}of items)this.park(cell,'Authority changed; Retry.');return;
    }
    for(const{cell,snapshot}of items)cell.view={state:liveOwner(cell)?'LIVE':'INACTIVE_CACHED',value:snapshot.value,cut:snapshot.cut,error:null};
    for(const{cell}of items)this.notify(cell);
    this.evict();
  }
  private clearQueued(entry:Entry):void{
    this.groups.cancel(entry);
  }
  private pruneQueued():void{
    this.staging.prune(fact=>fact.payload.kind==='authority'||fact.payload.kind===AUTHORITY_FENCE_KIND||
      fact.payload.kind==='group-unavailable'||fact.payload.kind==='tray-classification'||this.authorized(fact.authority));
    this.groups.prune();
  }
  private jointMode():boolean{return this.families.has('needs-you-saved-page');}
  private joint(entry:Entry):boolean{return this.groups.joint(entry);}
  private hideTray(group:string):void{
    const changed:Entry[]=[];
    for(const entry of this.entries.values())if(this.joint(entry)&&this.groups.group(entry.request.workspaceId!)===group){
      this.transition(entry,{...absent(),state:'PARKED',error:UNAVAILABLE},'baseline');changed.push(entry);
    }
    for(const entry of changed)this.notify(entry);
  }
  private parkTray(group:string):void{
    this.groups.fail(group);
    const affected=[...this.entries.values()].filter(entry=>this.joint(entry)&&this.groups.group(entry.request.workspaceId!)===group);
    if(affected.every(entry=>!entry.snapshot&&!entry.flight&&entry.view.state==='PARKED'&&entry.view.value===null))return;
    this.hideTray(group);
  }
  private parkTrayStream(stream:string):void{
    const groups=new Set([...this.entries.values()].filter(entry=>this.joint(entry)&&`workspace:${entry.request.workspaceId}`===stream)
      .map(entry=>this.groups.group(entry.request.workspaceId!)));
    for(const group of groups)this.parkTray(group);
  }
  private repair(entry: Entry, _error: string): void {
    if (entry.flight) return;
    if (this.joint(entry)) {
      this.parkTray(this.groups.group(entry.request.workspaceId!));
      this.refresh(request => trayFamily(request.family) && request.workspaceId === entry.request.workspaceId);
    } else this.refresh(request => this.key(request) === entry.key);
  }
  private park(entry: Entry, error: string): void {
    if(this.joint(entry)){this.parkTray(this.groups.group(entry.request.workspaceId!));return;}
    this.parkItem(entry, error);
  }
  private parkItem(entry: Entry, error: string): void {
    this.transition(entry,{...entry.view,state:'PARKED',error},'keep');this.notify(entry);
  }
  private parkStream(stream: string, error: string): void {
    for (const entry of this.entries.values()) if ((entry.snapshot?.cut.stream ?? `workspace:${entry.request.workspaceId}`) === stream) this.park(entry, error);
  }
  private publish(entry: Entry, view: LaneView): void { entry.view = Object.freeze(view); this.notify(entry); }
  private notify(entry: Entry): void { if (liveOwner(entry)) for (const listener of entry.listeners) listener(); }
  private evict(): void {
    let hotBytes = [...this.entries.values()].reduce((sum, entry) => sum + (entry.snapshot ? bytes(entry.snapshot) : 0), 0);
    let inactiveRooms = [...this.entries.values()].filter(entry => !liveOwner(entry) && entry.request.family === 'room-head').length;
    for (const [key, entry] of this.entries) {
      if (liveOwner(entry) || entry.listeners.size || entry.flight) continue;
      if (this.entries.size <= 128 && hotBytes <= 8 * 1024 * 1024 && (entry.request.family !== 'room-head' || inactiveRooms <= 3)) continue;
      hotBytes -= entry.snapshot ? bytes(entry.snapshot) : 0;
      if (entry.request.family === 'room-head') inactiveRooms -= 1;
      this.groups.drop(entry);
    }
    this.groups.retain();
  }
}

/** Local state only. No transport, clock, scheduler, native module or server inventory. */
export type LaneFamily = 'room-list' | 'needs-you' | 'needs-you-count' | 'room-head';
export type LaneRequest = Readonly<{ family: 'room-head'; roomId: string; workspaceId?: string }> |
  Readonly<{ family: Exclude<LaneFamily, 'room-head'>; workspaceId: string; roomId?: never }>;
export type LaneCut = Readonly<{ stream: string; epoch: string; through: number; protocol: 1 }>;
export type LaneAuthority = Readonly<{ digest: string; scopes: readonly Readonly<{ authorityScope: string; epoch: string }>[] }>;
export type LaneSnapshot = Readonly<{ kind: 'snapshot'; value: unknown; cut: LaneCut; atomicGroup: string; authority: LaneAuthority }>;
export type LaneState = 'ABSENT' | 'OPENING' | 'LIVE' | 'PARKED' | 'INACTIVE_CACHED' | 'REVOKED';
export type LaneView = Readonly<{ state: LaneState; value: unknown | null; error: string | null; cut: LaneCut | null }>;
export type LaneFact = Readonly<{ atomicGroup: string; authority: LaneAuthority; payload:
  | { kind: 'scope-replace'; family: LaneFamily; scope: string; value: unknown }
  | { kind: 'authority'; scope: string; authorityScope?: string; allowed: boolean }
  | {kind:'authority-fence';scope:string;authorityScope:string;mode:'deny'|'advance'}
  | {kind:'group-unavailable';scope:string;reason:'authority'|'dependency'} }>;
export type LaneBatch = Readonly<{ from: LaneCut; to: LaneCut; facts: readonly LaneFact[] }>;
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
type Entry = {
  key: string; request: LaneRequest; expectedWorkspace?: string; view: LaneView; owners: Map<object, Owner>;
  snapshot?: LaneSnapshot; flight?: Promise<void>; revision: number; connection: number;
  /** Content-free continuity retained while an authority floor hides data. */
  baseline?:Omit<LaneSnapshot,'value'>;
  /** Verified control classification, never a painted/persisted data cut. */
  classified?:LaneCut;
  covered:boolean;committing:number;
  pending: LaneBatch[]; pendingBytes: number; future: LaneBatch[]; futureBytes: number; listeners: Set<() => void>;
};
const ABSENT_VIEW: LaneView = Object.freeze({ state: 'ABSENT', value: null, error: null, cut: null });
const absent = (): LaneView => ABSENT_VIEW;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const sameStream = (a: LaneCut, b: LaneCut): boolean => a.stream === b.stream && a.epoch === b.epoch && a.protocol === b.protocol;
const liveOwner = (entry: Entry): boolean => [...entry.owners.values()].some(owner => owner.active && owner.permit.isCurrent());
const scopeOf = (request: LaneRequest): string => request.family === 'room-head' ? request.roomId! : request.workspaceId;
// Room heads still follow legacy transport/view filters on the server. They
// have no proven inactive feed until DB-audience durable facts replace it.
const CONTINUOUS_CACHE:Readonly<Record<LaneFamily,boolean>>={
  'room-list':true,'needs-you':true,'needs-you-count':true,'room-head':false,
};
const continuouslyFed=(family:LaneFamily):boolean=>CONTINUOUS_CACHE[family]===true;

/** An executor is installed only by the negotiated connection owner. Demand
 * arrives only after admission has atomically consumed a real owner pass.
 * Failure, push, time and cache age cannot call the executor.
 */
export class ReadLanes {
  private readonly entries = new Map<string, Entry>();
  private readonly fences = new Map<string, string>();
  private readonly floors = new Map<string,string>();
  private readonly joined = new WeakMap<object, { key: string; entry: Entry }>();
  private generation = -1;
  private session = 0;
  private executor?: (request: LaneRequest) => Promise<LaneSnapshot>;
  private families = new Set<LaneFamily>();
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly identity: LaneIdentity,
    private readonly validate: (request: LaneRequest, value: unknown) => boolean,
    private readonly storage?: LaneStorage) {}

  key(request: LaneRequest): string {
    return JSON.stringify([this.identity.origin, this.identity.principal, this.identity.sessionEpoch,
      request.family, request.family === 'room-head' ? '' : request.workspaceId, request.roomId ?? '', 1]);
  }
  /** Optional caller-known Workspace is a constraint on the canonical Room
   * identity, never another Room-head cache address or read budget.
   */
  constrain(request: LaneRequest): void { this.entry(request); }
  supports(family: LaneFamily): boolean { return this.families.has(family); }
  peek(request: LaneRequest): LaneView {
    const entry = this.entries.get(this.key(request));
    const installed=entry?.snapshot??entry?.baseline;
    if (entry && request.family === 'room-head' && request.workspaceId &&
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
  connected(generation: number, families: readonly LaneFamily[], execute: (request: LaneRequest) => Promise<LaneSnapshot>): void {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) throw new Error('stale lane connection');
    this.generation = generation;
    this.executor = execute;
    this.families = new Set(families);
    const demanded = [...this.entries.values()].filter(liveOwner);
    for (const entry of demanded) {
      entry.revision += 1;
      entry.flight = undefined;
      entry.pending = []; entry.pendingBytes = 0; entry.future = []; entry.futureBytes = 0;
      if (this.supports(entry.request.family)) this.open(entry);
      else this.publish(entry, { ...absent(), state: 'PARKED', error: 'Projection unavailable.' });
    }
  }

  /** Interruption hides private data until a newly authorized snapshot. */
  disconnected(): void {
    this.executor = undefined;
    this.families.clear();
    for (const entry of this.entries.values()) {
      entry.revision += 1; entry.flight = undefined; entry.pending = []; entry.pendingBytes = 0; entry.future = []; entry.futureBytes = 0;
      entry.snapshot = undefined;entry.baseline=undefined;entry.classified=undefined;
      entry.covered=false;
      this.publish(entry, { ...absent(), state: 'PARKED', error: 'Connection interrupted; Retry.' });
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
    if(permit.isCurrent()&&continuouslyFed(request.family)&&entry.view.state==='INACTIVE_CACHED'&&entry.snapshot&&entry.covered&&
      entry.connection===this.generation&&!entry.flight&&!entry.committing&&!entry.pending.length&&!entry.future.length&&
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
        const reusable=continuouslyFed(entry.request.family)&&entry.view.state==='LIVE'&&entry.covered&&!entry.committing&&!entry.pending.length&&!entry.future.length;
        if(!reusable)entry.covered=false;
        // A pending reply can no longer paint or restore authority.
        entry.revision += 1; entry.flight = undefined;
        entry.pending = []; entry.pendingBytes = 0; entry.future = []; entry.futureBytes = 0;
        if(!continuouslyFed(entry.request.family)){
          entry.snapshot=undefined;entry.baseline=undefined;
          const state=entry.view.state==='REVOKED'?'REVOKED':'PARKED';
          this.publish(entry,{...absent(),state,error:state==='REVOKED'?'Access removed.':'Projection unavailable; Retry.'});
          this.evict();return;
        }
        const state=entry.view.state==='PARKED'||entry.view.state==='REVOKED'?entry.view.state:
          reusable?'INACTIVE_CACHED':entry.snapshot?'PARKED':'ABSENT';
        this.publish(entry, { ...entry.view, state,error:state==='PARKED'?(entry.view.error??'Connection interrupted; Retry.'):entry.view.error });
      }
      this.evict();
    };
  }

  /** Explicit Retry is passed an independently spent synchronous gesture. */
  retry(request: LaneRequest, permit: LanePermit): void {
    const entry = this.entry(request);
    if (!permit.isCurrent() || !liveOwner(entry) || !this.supports(request.family) || entry.flight) return;
    this.open(entry);
  }

  /** Complete, digest-verified logical batches only. The assembly owner never
   * sends partial facts here. Serialize persistence and publication in stream order.
   */
  accept(batch: LaneBatch): Promise<void> {
    const session = this.session;
    const work = this.serial.then(async () => {
      if (session !== this.session) return;
      for (const fact of batch.facts) {
        if(fact.payload.kind==='group-unavailable'){
          await this.unavailableGroup(batch.to.stream,fact.atomicGroup);continue;
        }
        if(fact.payload.kind!=='authority-fence'&&(fact.payload.kind!=='authority'||fact.payload.allowed))continue;
        const mode=fact.payload.kind==='authority-fence'?fact.payload.mode:'deny';
        const logicalScope = fact.payload.scope;
        // Wire removal separates logical resource scope from the exact
        // denied permission domain. Never infer denial from another domain
        // that merely shares this complete certificate.
        const targetDomain = fact.payload.authorityScope;
        const streamWorkspace = batch.to.stream.startsWith('workspace:') ? batch.to.stream.slice('workspace:'.length) : undefined;
        const roomFits = targetDomain === `room:${logicalScope}` && !!streamWorkspace &&
          fact.authority.scopes.some(scope => scope.authorityScope === `reader:${this.identity.principal}:workspace:${streamWorkspace}`);
        const domainFits = roomFits || batch.to.stream === `workspace:${logicalScope}`&&
          (targetDomain === `reader:${this.identity.principal}:workspace:${logicalScope}`||
            mode==='advance'&&targetDomain===`reader:${this.identity.principal}:workspace:${logicalScope}:visibility`);
        const target = domainFits ? fact.authority.scopes.find(scope => scope.authorityScope === targetDomain) : undefined;
        if (!target||!/^\d+$/.test(target.epoch)) {
          if(fact.payload.kind==='authority-fence'){await this.unavailableGroup(batch.to.stream,fact.atomicGroup);continue;}
          for (const entry of this.entries.values()) if (entry.request.roomId === logicalScope ||
              entry.request.workspaceId === logicalScope || entry.snapshot?.cut.stream === `workspace:${logicalScope}`) {
            entry.revision += 1; entry.snapshot = undefined; entry.flight = undefined;
            this.publish(entry, { ...absent(), state: 'PARKED', error: 'Unknown authority.' });
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
      const installs: { entry: Entry; snapshot: LaneSnapshot }[] = [];
      for (const entry of this.entries.values()) {
        if (entry.view.state === 'PARKED') continue;
        if (entry.flight) {
          if (entry.request.workspaceId ? batch.to.stream !== `workspace:${entry.request.workspaceId}` :
            !batch.facts.some(fact => fact.payload.kind === 'scope-replace' && fact.payload.family === entry.request.family && fact.payload.scope === scopeOf(entry.request))) continue;
          const group=(entry.snapshot??entry.baseline)?.atomicGroup;
          const related=new Set(batch.facts.filter(fact=>fact.payload.kind==='scope-replace'&&
            fact.payload.family===entry.request.family&&fact.payload.scope===scopeOf(entry.request)).map(fact=>fact.atomicGroup));
          if(group)related.add(group);
          const queued={...batch,facts:batch.facts.filter(fact=>fact.payload.kind!=='scope-replace'||related.has(fact.atomicGroup))};
          const size = bytes(queued);
          const primaryBytes = entry.pending[0] ? bytes(entry.pending[0]) : 0;
          if (size > 1024 * 1024 || entry.pending.length >= 17 ||
              entry.pending.length > 0 && entry.pendingBytes - primaryBytes + size > 256 * 1024)
            this.park(entry, 'Projection queue overflow; Retry.');
          else { entry.pending.push(queued); entry.pendingBytes += size; }
          continue;
        }
        const held = entry.snapshot??entry.baseline;
        if (!held || held.cut.stream !== batch.to.stream) continue;
        if (!sameStream(held.cut, batch.to)) { this.park(entry, 'Projection version changed; Retry.'); continue; }
        if (batch.to.through <= held.cut.through) continue;
        const progress=entry.classified??held.cut;
        if (batch.from.through > progress.through) {
          const queued={...batch,facts:batch.facts.filter(fact=>fact.atomicGroup===held.atomicGroup)};
          if(!queued.facts.length)continue;
          const duplicate = entry.future.find(held => held.from.through === batch.from.through && held.to.through === batch.to.through);
          if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(queued)) this.park(entry, 'Conflicting projection; Retry.');
          else if (!duplicate) {
            const size = bytes(queued);
            if (entry.future.length >= 16 || entry.futureBytes + size > 256 * 1024) this.park(entry, 'Projection gap; Retry.');
            else { entry.future.push(queued); entry.futureBytes += size; }
          }
          continue;
        }
        const facts = batch.facts.filter(fact => fact.payload.kind === 'scope-replace' &&
          fact.payload.family === entry.request.family && fact.payload.scope === scopeOf(entry.request));
        if (!facts.length) {
          // A checkpoint is truthful only for the same complete declared group.
          // This first slice deliberately requires a complete replacement.
          continue;
        }
        const fact = facts.at(-1)!;
        if (fact.payload.kind !== 'scope-replace' || !this.authorized(fact.authority) ||
            !this.validate(entry.request, fact.payload.value)) { this.park(entry, 'Invalid projection; Retry.'); continue; }
        installs.push({ entry, snapshot: { kind: 'snapshot', value: fact.payload.value, cut: batch.to,
          atomicGroup: fact.atomicGroup, authority: fact.authority } });
      }
      await this.installGroups(installs, session);
      const ready = new Map<string, LaneBatch>();
      for (const entry of this.entries.values()) {
        const cut = entry.classified??entry.snapshot?.cut??entry.baseline?.cut;
        if (!cut || entry.view.state === 'PARKED') continue;
        entry.future = entry.future.filter(future => {
          if (future.from.through > cut.through) return true;
          entry.futureBytes -= bytes(future);
          if (future.to.through > cut.through){
            const key=JSON.stringify([future.from,future.to]),previous=ready.get(key);
            const facts=new Map([...(previous?.facts??[]),...future.facts].map(fact=>[JSON.stringify(fact),fact]));
            ready.set(key,{...future,facts:[...facts.values()]});
          }
          return false;
        });
      }
      for (const future of ready.values()) void Promise.resolve().then(() => this.accept(future));
    });
    this.serial = work.catch(() => { if (session === this.session) this.parkStream(batch.to.stream, 'Projection storage failed; Retry.'); });
    return this.serial;
  }

  unavailable(stream: string, family: LaneFamily, reason = 'Projection unavailable; Retry.'): void {
    for (const entry of this.entries.values()) if (entry.request.family === family &&
      (entry.snapshot?.cut.stream ?? `workspace:${entry.request.workspaceId}`) === stream) this.park(entry, reason);
  }
  async unavailableGroup(stream:string,group:string):Promise<void>{
    const changed:Entry[]=[];
    for(const entry of this.entries.values()){
      const held=entry.snapshot??entry.baseline;
      const canonical=entry.request.family==='room-head'?`room-head:${entry.request.roomId}:${this.identity.principal}`:
        `${entry.request.family==='room-list'?'room-list':'needs-you'}:${entry.request.workspaceId}:${this.identity.principal}`;
      if(held?held.atomicGroup!==group||held.cut.stream!==stream:
        canonical!==group||(entry.request.workspaceId?stream!==`workspace:${entry.request.workspaceId}`:!stream.startsWith('workspace:')))continue;
      entry.revision++;entry.flight=undefined;entry.snapshot=undefined;entry.baseline=undefined;entry.classified=undefined;entry.covered=false;
      entry.pending=[];entry.pendingBytes=0;entry.future=[];entry.futureBytes=0;
      entry.view=Object.freeze({...absent(),state:'PARKED',error:'Projection unavailable; Retry.'});changed.push(entry);
    }
    for(const entry of changed)this.notify(entry);
    if(changed.length)await this.storage?.remove(this.groupStorageKey(group));
  }
  private groupStorageKey(group:string):string{return JSON.stringify([this.identity.origin,this.identity.principal,group]);}
  private retire(entry:Entry):void{
    const held=entry.snapshot??entry.baseline;
    const future=this.futureAfterFence(entry,held?.atomicGroup??'');
    if(entry.snapshot){const {value:_value,...baseline}=entry.snapshot;entry.baseline=baseline;}
    entry.revision++;entry.flight=undefined;entry.snapshot=undefined;entry.covered=false;
    entry.pending=[];entry.pendingBytes=0;entry.future=future?.batches??[];entry.futureBytes=future?.bytes??0;
    this.publish(entry,{...absent(),state:'REVOKED',error:'Access removed.'});
  }
  private futureAfterFence(entry:Entry,group:string):{batches:LaneBatch[];bytes:number}|undefined{
    const kept=new Map<string,LaneBatch>();let total=0;
    for(const batch of [...entry.pending,...entry.future]){
      const facts=batch.facts.filter(fact=>fact.atomicGroup===group);
      if(!facts.length||facts.some(fact=>fact.payload.kind==='scope-replace'&&!this.authorized(fact.authority)))continue;
      const safe={...batch,facts},key=JSON.stringify([batch.from,batch.to]),prior=kept.get(key);
      if(prior){if(JSON.stringify(prior)!==JSON.stringify(safe))return;continue;}
      const size=bytes(safe);if(kept.size>=16||total+size>256*1024)return;
      kept.set(key,safe);total+=size;
    }
    return {batches:[...kept.values()],bytes:total};
  }

  /** Retire only strictly older certificates. Keep no hidden content, make no
   * read, and retain only continuity needed for an ordinary fresh replacement.
   * This is distinct from a current denial and does not create a pass. */
  async advance(scope:string,epoch:string,persist=true):Promise<void>{
    if(!/^\d+$/.test(epoch))return;
    const held=this.floors.get(scope);
    if(held&&BigInt(held)>=BigInt(epoch))return;
    this.floors.set(scope,epoch);
    const removals:string[]=[],changed:Entry[]=[];
    for(const entry of this.entries.values()){
      const snapshot=entry.snapshot??entry.baseline;
      const installed=snapshot?.authority.scopes.find(authority=>authority.authorityScope===scope);
      if(!installed||/^\d+$/.test(installed.epoch)&&BigInt(installed.epoch)>=BigInt(epoch))continue;
      const future=this.futureAfterFence(entry,snapshot!.atomicGroup);
      entry.revision++;entry.flight=undefined;
      entry.covered=false;
      entry.pending=[];entry.pendingBytes=0;entry.future=future?.batches??[];entry.futureBytes=future?.bytes??0;
      if(entry.snapshot){const {value:_value,...baseline}=entry.snapshot;entry.baseline=baseline;}
      entry.snapshot=undefined;
      entry.view=Object.freeze({state:future?(liveOwner(entry)?'OPENING':'INACTIVE_CACHED'):'PARKED',value:null,
        error:future?null:'Projection queue overflow; Retry.',cut:snapshot!.cut});
      changed.push(entry);
      removals.push(entry.key);
    }
    for(const entry of changed)this.notify(entry);
    if(persist&&this.storage){
      if(!this.storage.floor)throw new Error('Authority floor storage unavailable.');
      await this.storage.floor(scope,epoch);
    }
    for(const key of removals)await this.storage?.remove(key);
  }

  /** Content-free durable fence adoption (including another local web tab).
   * No pass is created and no snapshot is requested.
   */
  async revoke(scope: string, epoch: string, persist = true): Promise<void> {
    if (!/^\d+$/.test(epoch)) return;
    const held = this.fences.get(scope);
    if (held && BigInt(held) >= BigInt(epoch)) return;
    this.fences.set(scope, epoch);
    // Purge immediately; disk failure must never preserve visible content.
    const removals: string[] = [],changed:Entry[]=[];
    for (const entry of this.entries.values()) {
      const snapshot=entry.snapshot??entry.baseline;
      const installed = snapshot?.authority.scopes.find(authority => authority.authorityScope === scope);
      // An older ordered removal cannot erase a subsequently authorized grant.
      // Unknown/older pending baselines remain fenced below.
      if (installed && /^\d+$/.test(installed.epoch) && BigInt(installed.epoch) > BigInt(epoch)) continue;
      const roomId = scope.startsWith('room:') ? scope.slice('room:'.length) : undefined;
      const workspacePrefix = `reader:${this.identity.principal}:workspace:`;
      const workspaceId = scope.startsWith(workspacePrefix) ? scope.slice(workspacePrefix.length) : undefined;
      if (!snapshot?.authority.scopes.some(authority => authority.authorityScope === scope) &&
          !(roomId && entry.request.family === 'room-head' && entry.request.roomId === roomId) &&
          !(workspaceId && (entry.request.workspaceId === workspaceId || entry.snapshot?.cut.stream === `workspace:${workspaceId}`))) continue;
      const future=this.futureAfterFence(entry,snapshot?.atomicGroup??'');
      if(entry.snapshot){const {value:_value,...baseline}=entry.snapshot;entry.baseline=baseline;}
      entry.revision += 1; entry.snapshot = undefined;entry.flight = undefined;
      entry.covered=false;
      entry.pending=[];entry.pendingBytes=0;entry.future=future?.batches??[];entry.futureBytes=future?.bytes??0;
      entry.view=Object.freeze({ ...absent(), state: 'REVOKED', error: 'Access removed.' });changed.push(entry);
      removals.push(entry.key);
    }
    for(const entry of changed)this.notify(entry);
    if (persist) await this.storage?.fence(scope, epoch);
    for (const key of removals) await this.storage?.remove(key);
  }

  reset(): void {
    this.session += 1; this.disconnected();
    for (const entry of this.entries.values()) { entry.snapshot = undefined; this.publish(entry, absent()); }
    this.entries.clear(); this.fences.clear();this.floors.clear();
  }

  private entry(request: LaneRequest): Entry {
    const key = this.key(request);
    let entry = this.entries.get(key);
    if (!entry) {
      if (request.family === 'room-head' ? !request.roomId : !request.workspaceId) throw new Error('invalid lane scope');
      entry = { key, request: Object.freeze({ ...request }), view: absent(), owners: new Map(), revision: 0,
        connection: -1,covered:false,committing:0, pending: [], pendingBytes: 0, future: [], futureBytes: 0, listeners: new Set() };
      this.entries.set(key, entry); this.evict();
    }
    if (request.family === 'room-head' && request.workspaceId) {
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
      if (!this.validSnapshot(entry, snapshot)) { this.park(entry, 'Invalid snapshot; Retry.'); return; }
      // Snapshot installation uses the same serial actor as committed facts.
      const install = this.serial.then(async () => {
        if (!current()) return;
        await this.installGroups([{ entry, snapshot }], session);
      });
      this.serial = install.catch(() => { if (current()) this.park(entry, 'Projection storage failed; Retry.'); });
      await this.serial;
    }).catch(() => { if (current()) this.park(entry, 'Connection interrupted; Retry.'); }).finally(() => {
      if (entry.flight !== flight) return;
      entry.flight = undefined;
      const pending = entry.pending; entry.pending = []; entry.pendingBytes = 0;
      for (const batch of pending) void this.accept(batch);
    });
    entry.flight = flight;
  }
  private validSnapshot(entry: Entry, snapshot: LaneSnapshot): boolean {
    const request = entry.request;
    const workspaceId = entry.expectedWorkspace ?? request.workspaceId;
    return snapshot.kind === 'snapshot' && snapshot.cut.protocol === 1 && (workspaceId ? snapshot.cut.stream === `workspace:${workspaceId}` : snapshot.cut.stream.startsWith('workspace:')) &&
      Number.isSafeInteger(snapshot.cut.through) && snapshot.cut.through >= 0 && !!snapshot.cut.epoch &&
      this.authorized(snapshot.authority) && this.validate(request, snapshot.value);
  }
  private authorized(authority: LaneAuthority): boolean {
    return !!authority.digest && authority.scopes.length > 0 && authority.scopes.length <= 8 &&
      authority.scopes.every(scope => !!scope.authorityScope && !!scope.epoch &&
        /^\d+$/.test(scope.epoch) &&
        (!this.floors.has(scope.authorityScope)||BigInt(scope.epoch)>=BigInt(this.floors.get(scope.authorityScope)!))&&
        (!this.fences.has(scope.authorityScope) || BigInt(scope.epoch) > BigInt(this.fences.get(scope.authorityScope)!)));
  }
  private async installGroups(installs: readonly { entry: Entry; snapshot: LaneSnapshot }[], session: number): Promise<void> {
    const groups = new Map<string, typeof installs[number][]>();
    for (const install of installs) {
      const group = groups.get(install.snapshot.atomicGroup) ?? []; group.push(install); groups.set(install.snapshot.atomicGroup, group);
    }
    for (const [group, items] of groups) {
      if(items.some(({snapshot})=>!this.authorized(snapshot.authority))){
        for(const {entry}of items)this.park(entry,'Authority changed; Retry.');continue;
      }
      const versions = items.map(({ entry }) => entry.revision);
      const encoded = JSON.stringify({ schema: 1, identity: this.identity, group,
        entries: items.map(({ entry, snapshot }) => ({ key: entry.key, request: entry.request, snapshot })) });
      for(const {entry}of items)entry.committing++;
      try{await this.storage?.write(JSON.stringify([this.identity.origin, this.identity.principal, group]), encoded);}
      finally{for(const {entry}of items)entry.committing--;}
      if (session !== this.session) return;
      if (items.some(({ entry }, index) => entry.revision !== versions[index])) continue;
      if(items.some(({snapshot})=>!this.authorized(snapshot.authority))){
        for(const {entry}of items)this.park(entry,'Authority changed; Retry.');continue;
      }
      // Commit the complete group before notifying a single UI observer.
      for (const { entry, snapshot } of items) {
        entry.snapshot = snapshot;entry.baseline=undefined;entry.classified=undefined;entry.covered=true;
        entry.view = { state: liveOwner(entry) ? 'LIVE' : 'INACTIVE_CACHED', value: snapshot.value, cut: snapshot.cut, error: null };
      }
      for (const { entry } of items) this.notify(entry);
    }
    this.evict();
  }
  private park(entry: Entry, error: string): void {
    entry.covered=false;
    entry.classified=undefined;
    entry.revision += 1; entry.flight = undefined; entry.pending = []; entry.pendingBytes = 0; entry.future = []; entry.futureBytes = 0;
    this.publish(entry, { ...entry.view, state: 'PARKED', error });
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
      this.entries.delete(key);
    }
  }
}

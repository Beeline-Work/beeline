import type { RouteInput } from '../routes.js';
import { validateOwnerInput } from './owner-inputs.js';
import { canonical } from './canonical.js';

// Initial shadow policies. These do NOT opt any wire family into router-v1.
// Extend only alongside a real trusted owner and its closure proofs.
const policies = {
  'phone.countNeedsYou': { mode: 'read', screen: 'AppShell' },
  'phone.readRoom': { mode: 'read', screen: 'Room' },
  'phone.readChats': { mode: 'read', screen: 'AppShell' },
  'phone.readRouterSnapshot': { mode: 'read', screen: 'AppShell' as 'AppShell' | 'Room'|'AgentProfile'|'ScheduledWork'|'Tray' },
  'phone.readMediaMetadata': { mode: 'read', screen: 'Room' },
  'phone.readAgentUsageCell': { mode: 'read', screen: 'AgentProfile' },
  'phone.readRoomTools': {mode:'read-action',action:'OpenToolGroup'},
  'phone.readMediaLink': { mode: 'read-action', action: 'OpenArtifactBrowser' },
  'phone.readMediaPlayback': { mode: 'read-action', action: 'RunArtifact' },
  'phone.sendRoomMessage': { mode: 'command', action: 'SendMessage' },
  'phone.sendRoomReply': { mode: 'command', action: 'SendMessage' },
  'phone.clearNeedsYou':{mode:'command',action:'EditTray'},
  'phone.clearNeedsYouSection':{mode:'command',action:'EditTray'},
  'phone.clearMessageBookmarks':{mode:'command',action:'EditTray'},
  'phone.setMessageBookmark':{mode:'command',action:'EditTray'},
  'phone.decideAgentGrant':{mode:'command',action:'EditTray'},
  'phone.decideWritePermission':{mode:'command',action:'EditTray'},
  'phone.skipChoice':{mode:'command',action:'EditTray'},
  'phone.markNeedsYouSeen':{mode:'command',action:'PaintTray'},
  'phone.deleteRoomSchedule':{mode:'command',action:'StopScheduledWork'},
  'phone.deleteRoomSubscription':{mode:'command',action:'StopScheduledWork'},
} as const;
type Policy = typeof policies;
type PolicyId = keyof Policy;
type TapId = Exclude<{ [K in PolicyId]: Policy[K] extends {mode:'command'} ? K : never }[PolicyId], 'phone.markNeedsYouSeen'>;
type ReadId = { [K in PolicyId]: Policy[K] extends { mode: 'read' } ? K : never }[PolicyId];
type Screen = Policy[ReadId]['screen'];
type ScreenRoute<S extends Screen> = { [K in ReadId]: S extends Policy[K]['screen'] ? K : never }[ReadId];
type Request<K extends PolicyId> = { route: K; input: RouteInput<K> };
type Requests<K extends PolicyId> = { [P in K]: Request<P> }[K];
type Identity = Readonly<{ origin: string; principal: string; sessionEpoch: number }>;
declare const brand: unique symbol;
export type Pass<K extends PolicyId = PolicyId> = { readonly [brand]: (route: K) => K };
type State = {
  key: string; route: PolicyId; session: object; lifetime: { active: boolean };
  spent: boolean; completionLifetime?: { active: boolean };
};
type Residency = {
  generation: number; screen: Screen; signature: string; lifetime: { active: boolean };
  passes: readonly object[]; keys: readonly string[]; painted?:Set<string>; paintedBytes?:number;
};
export type MediaAction = 'OpenArtifact' | 'CopyArtifact' | 'SaveArtifact' | 'OpenArtifactBrowser' | 'RunArtifact';
type MediaOperation = 'phone.readMediaMetadata' | 'phone.readMediaLink' | 'phone.readMediaPlayback';
type MediaResidency = { generation: number; roomId: string; lifetime: { active: boolean };
  seen: Set<string>; visible: Map<string, { active: boolean }> };
type UsageResidency = { generation: number; agentId: string; lifetime: { active: boolean }; pass: Pass<'phone.readAgentUsageCell'> };

/** Private trusted-owner machinery; no feature import, socket, clock or scheduler.
 * CREATED -> ACTIVE -> SPENT; blur/return/reset -> REVOKED. Never reactivated.
 * A navigation generation is supplied by navigation, never React effect setup.
 */
export class AdmissionOwner {
  private readonly states = new WeakMap<object, State>();
  private session: object = {};
  private identity: Identity;
  private readonly residencies = new Map<string, Residency>();
  private readonly lastResidencies = new Map<string, number>();
  private readonly retiredResidencies = new Map<string, Residency>();
  private lastResidency = -1;
  private lastConnection = -1;
  private recoveryLifetime = { active: false };
  private foreground = true;
  private mediaResidency?: MediaResidency;
  private lastMediaConnection = -1;
  private usageResidency?: UsageResidency;
  private lastUsageGeneration = -1;
  private lastUsageConnection = -1;
  private readonly diagnostics: string[] = [];

  constructor(identity: Identity) { this.identity = Object.freeze({ ...identity }); }

  reset(identity: Identity): void {
    this.blur();
    this.recoveryLifetime.active = false;
    this.identity = Object.freeze({ ...identity });
    this.session = {};
    this.lastResidency = -1;
    this.lastResidencies.clear();
    this.retiredResidencies.clear();
    this.lastConnection = -1;
    this.mediaResidency = undefined;
    this.lastMediaConnection = -1;
    this.usageResidency = undefined; this.lastUsageGeneration = -1; this.lastUsageConnection = -1;
  }

  background(): void { this.foreground = false; this.blur(); this.recoveryLifetime.active = false; }
  foregrounded(): void { this.foreground = true; } // No minting, read or reconnect.
  blur(): void {
    this.clearMediaFocus();
    this.clearUsageFocus();
    for (const [owner, residency] of this.residencies) {
      residency.lifetime.active = false; this.retiredResidencies.set(owner, residency);
    }
    this.residencies.clear();
  }
  usageProfile(generation: number, agentId: string): Pass<'phone.readAgentUsageCell'> {
    this.validateGeneration(generation);
    if (!this.foreground) return this.deny('background');
    const prior = this.usageResidency;
    if (prior?.generation === generation && prior.agentId === agentId) return prior.pass;
    if (generation <= this.lastUsageGeneration) return this.deny('stale usage profile');
    const request = { route: 'phone.readAgentUsageCell' as const, input: { agentId } };
    this.validateRequests([request]); this.clearUsageFocus();
    const lifetime = { active: true }; const pass = this.mint(request, lifetime);
    this.usageResidency = { generation, agentId, lifetime, pass }; this.lastUsageGeneration = generation;
    return pass;
  }
  clearUsageFocus(): void { if (this.usageResidency) this.usageResidency.lifetime.active = false; }
  usageRecovery(connection: number, generation: number, agentId: string): Pass<'phone.readAgentUsageCell'> {
    this.validateGeneration(connection); this.validateGeneration(generation);
    if (!this.foreground || connection <= this.lastUsageConnection || generation < this.lastUsageGeneration)
      return this.deny('inactive usage recovery');
    const request = { route: 'phone.readAgentUsageCell' as const, input: { agentId } };
    this.validateRequests([request]); this.clearUsageFocus();
    const lifetime = { active: true }; const pass = this.mint(request, lifetime);
    this.usageResidency = { generation, agentId, lifetime, pass };
    this.lastUsageGeneration = generation; this.lastUsageConnection = connection; return pass;
  }

  /** Only the committed navigation owner establishes this Room lifetime.
   * Returning foreground resumes observation but never remints seen objects.
   */
  mediaFocus(generation: number, roomId: string): void {
    this.validateGeneration(generation);
    if (!this.foreground || !roomId) return this.deny('inactive media focus');
    const prior = this.mediaResidency;
    if (prior?.generation === generation && prior.roomId === roomId) {
      if (!prior.lifetime.active) prior.lifetime = { active: true };
      return;
    }
    if (prior && generation <= prior.generation) return this.deny('stale media focus');
    this.clearMediaFocus();
    this.mediaResidency = { generation, roomId, lifetime: { active: true }, seen: new Set(), visible: new Map() };
  }
  clearMediaFocus(): void {
    const owner = this.mediaResidency;
    if (!owner) return;
    owner.lifetime.active = false;
    for (const lifetime of owner.visible.values()) lifetime.active = false;
    owner.visible.clear();
  }
  mediaVisible(generation: number, roomId: string, objectIds: readonly string[]): readonly {
    objectId: string; pass: Pass<'phone.readMediaMetadata'>;
  }[] {
    const owner = this.mediaResidency;
    if (!this.foreground || !owner?.lifetime.active || owner.generation !== generation || owner.roomId !== roomId)
      return this.deny('inactive media viewport');
    const ids = new Set(objectIds);
    if (ids.size > 128) return this.deny('media viewport quota');
    const requests = [...ids].map(objectId => ({ route: 'phone.readMediaMetadata' as const, input: { objectId } }));
    for (const request of requests) this.validateRequests([request]);
    if (owner.seen.size + [...ids].filter(id => !owner.seen.has(id)).length > 512) return this.deny('media residency quota');
    for (const [id, lifetime] of owner.visible) if (!ids.has(id)) { lifetime.active = false; owner.visible.delete(id); }
    const passes: { objectId: string; pass: Pass<'phone.readMediaMetadata'> }[] = [];
    for (const request of requests) {
      if (owner.seen.has(request.input.objectId)) continue;
      owner.seen.add(request.input.objectId);
      const lifetime = { active: true }; owner.visible.set(request.input.objectId, lifetime);
      passes.push({ objectId: request.input.objectId, pass: this.mint(request, lifetime) });
    }
    return passes;
  }
  /** The sole negotiated connection owner supplies only currently displayed
   * keys already admitted by this navigation's real viewport or action.
   */
  mediaRecovery(connection: number, generation: number, roomId: string,
    requests: readonly Requests<'phone.readMediaMetadata' | 'phone.readMediaPlayback'>[]) {
    this.validateGeneration(connection);
    const owner = this.mediaResidency;
    if (!this.foreground || !owner?.lifetime.active || owner.generation !== generation || owner.roomId !== roomId ||
        connection <= this.lastMediaConnection || requests.length > 256) return this.deny('inactive media recovery');
    const keys = new Set<string>();
    for (const request of requests) {
      this.validateRequests([request]);
      const key = this.key(request); if (keys.has(key)) return this.deny('duplicate media recovery'); keys.add(key);
    }
    this.lastMediaConnection = connection;
    return requests.map(request => this.mint(request, owner.lifetime));
  }
  /** The existing action's synchronous prefix spends before its first await.
   * Completion belongs to its focused Room; returning the handler ends minting.
   */
  mediaTap<K extends MediaOperation, T>(generation: number, roomId: string, action: MediaAction,
    request: Request<K>, handler: (pass: Pass<K>) => T): T {
    const owner = this.mediaResidency;
    const operation = action === 'OpenArtifactBrowser' ? 'phone.readMediaLink' : action === 'RunArtifact'
      ? 'phone.readMediaPlayback' : ['OpenArtifact', 'CopyArtifact', 'SaveArtifact'].includes(action) ? 'phone.readMediaMetadata' : undefined;
    if (!this.foreground || !owner?.lifetime.active || owner.generation !== generation || owner.roomId !== roomId ||
        request.route !== operation && !(['RunArtifact', 'OpenArtifactBrowser'].includes(action) && request.route === 'phone.readMediaMetadata'))
      return this.deny('inactive media action');
    this.validateRequests([request as Requests<PolicyId>]);
    const lifetime = { active: true }; const pass = this.mint(request, lifetime);
    this.states.get(pass)!.completionLifetime = owner.lifetime;
    try { return handler(pass); } finally { lifetime.active = false; }
  }

  toolTap<T>(generation:number,roomId:string,request:Request<'phone.readRoomTools'>,handler:(pass:Pass<'phone.readRoomTools'>)=>T):T{
    if(!this.foreground)return this.deny('background');
    const owner=[...this.residencies.values()].find(item=>item.screen==='Room'&&item.generation===generation&&item.lifetime.active&&
      item.keys.some(key=>(JSON.parse(key)[4] as {roomId?:string}).roomId===roomId));
    if(request.input.roomId!==roomId)return this.deny('wrong tool Room');
    if(!owner)return this.deny('inactive tool action');
    this.validateRequests([request]);const lifetime={active:true},pass=this.mint(request,lifetime);
    this.states.get(pass)!.completionLifetime=owner.lifetime;
    try{return handler(pass);}finally{lifetime.active=false;}
  }

  focus<S extends Screen>(generation: number, screen: S, requests: readonly Requests<ScreenRoute<S>>[]): readonly Pass<ScreenRoute<S>>[] {
    return this.focusOwner('default', generation, screen, requests);
  }

  /** Multiple visible panes/AppShell have separate trusted slots. React
   * attachments join these slots; only committed navigation advances generation.
   */
  focusOwner<S extends Screen>(owner: string, generation: number, screen: S,
    requests: readonly Requests<ScreenRoute<S>>[]): readonly Pass<ScreenRoute<S>>[] {
    if (!this.foreground) return this.deny('background');
    if (!owner || owner.length > 256) return this.deny('invalid owner');
    this.validateGeneration(generation);
    const signature = canonical(requests);
    const residency = this.residencies.get(owner);
    if (residency?.generation === generation) {
      if (residency.screen !== screen || residency.signature !== signature) return this.deny('residency changed');
      return residency.passes as readonly Pass<ScreenRoute<S>>[];
    }
    if (generation < this.lastResidency || generation <= (this.lastResidencies.get(owner) ?? -1)) return this.deny('stale residency');
    if (!residency && this.residencies.size >= 16) return this.deny('owner quota');
    this.validateRequests(requests);
    for (const supplied of requests) {
      const request = supplied as Requests<ReadId>;
      const policy = policies[request.route];
      if (!policy || !('screen' in policy)) return this.deny('wrong screen');
      if (request.route === 'phone.readRouterSnapshot') {
        const family = request.input.family;
        if (screen === 'Room' ? !['room-head','room-workflows'].includes(family) :screen==='AgentProfile'?!['workspace-roster','agent-profile'].includes(family):screen==='ScheduledWork'?family!=='room-scheduled-work':screen==='Tray'?family!=='needs-you-tray':!['room-list', 'needs-you-count','workspace-roster'].includes(family)&&!family.startsWith('owner-'))
          return this.deny('wrong screen family');
        if (family === 'room-head'||family==='room-scheduled-work'||family==='room-workflows' ? !request.input.roomId : request.input.roomId !== undefined)
          return this.deny('wrong family scope');
      } else if (policy.screen !== screen) return this.deny('wrong screen');
    }
    if (residency) residency.lifetime.active = false;
    this.lastResidency = Math.max(this.lastResidency, generation);
    this.lastResidencies.set(owner, generation);
    const lifetime = { active: true };
    const passes = requests.map(request => this.mint<ScreenRoute<S>>(request, lifetime));
    this.residencies.set(owner, { generation, screen, signature, lifetime, passes, keys: requests.map(request => this.key(request)) });
    return passes;
  }

  releaseOwner(owner: string): void {
    const residency = this.residencies.get(owner);
    if (residency) { residency.lifetime.active = false; this.retiredResidencies.set(owner, residency); }
    this.residencies.delete(owner);
  }

  /** Navigation has permanently discarded a detached owner slot. Its passes
   * remain revoked in the WeakMap; local owner metadata need not grow forever.
   */
  forgetOwner(owner: string): void {
    this.releaseOwner(owner);
    this.retiredResidencies.delete(owner);
    this.lastResidencies.delete(owner);
  }

  /** Foreground can resume local observation of the same navigation owner.
   * Every prior read pass remains revoked; this returns no read capability.
   */
  resumeObservation(owner: string, generation: number): { isCurrent(): boolean } {
    if (!this.foreground) return this.deny('background');
    const retired = this.retiredResidencies.get(owner);
    if (!retired || retired.generation !== generation) return this.deny('stale observation');
    const lifetime = { active: true };
    this.residencies.set(owner, { ...retired, lifetime, passes: [] });
    const session = this.session;
    return { isCurrent: () => session === this.session && lifetime.active && this.foreground };
  }

  /** Handler return, including returning a Promise, ends gesture authority. */
  tap<K extends TapId, T>(action: Policy[K]['action'], request: Request<K>,
    handler: (pass: Pass<K>) => T): T {
    if (!this.foreground) return this.deny('background');
    if (policies[request.route]?.mode!=='command'||policies[request.route].action!==action||
      (request.route as string)==='phone.markNeedsYouSeen') return this.deny('wrong action');
    this.validateRequests([request as Requests<PolicyId>]);
    if (action==='SendMessage' && (typeof (request.input as {messageId?:unknown}).messageId !== 'string' ||
      !/^[0-9a-f]{64}$/.test((request.input as {messageId:string}).messageId)))
      return this.deny('prepared message identity required');
    const lifetime = { active: true };
    try { return handler(this.mint(request, lifetime)); }
    finally { lifetime.active = false; }
  }

  /** Trusted viewport only; painted IDs are spent once per navigation
   * residency. This screen command admits no read and starts no flush timer. */
  paintTray(generation:number,workspaceId:string,messageIds:readonly string[]) {
    if(!this.foreground)return this.deny('background');
    const read={route:'phone.readRouterSnapshot' as const,input:{family:'needs-you-tray' as const,workspaceId}};
    const residency=[...this.residencies.values()].find(value=>value.generation===generation&&value.screen==='Tray'&&
      value.lifetime.active&&value.keys.includes(this.key(read)));
    if(!residency)return this.deny('inactive paint owner');
    if(messageIds.length>30)return this.deny('paint quota');
    const painted=residency.painted??=new Set<string>();
    const ids=[...new Set(messageIds)].filter(id=>!painted.has(id));
    if(!ids.length)return undefined;
    const request={route:'phone.markNeedsYouSeen' as const,input:{workspaceId,messageIds:ids}};
    this.validateRequests([request]);
    const addedBytes=new TextEncoder().encode(JSON.stringify(ids)).length;
    if((residency.paintedBytes??0)+addedBytes>64*1024)return this.deny('paint residency capacity');
    const admitted=this.spend(request,this.mint(request,residency.lifetime));
    residency.paintedBytes=(residency.paintedBytes??0)+addedBytes;
    for(const id of ids)painted.add(id);
    return admitted;
  }

  /** Actual Load More Saved gesture, bound to the existing focused Tray.
   * The trusted adapter supplies only a continuation from its held server DTO.
   * Attaching a continuation observer alone never calls this method. */
  continueSaved<T>(generation:number,workspaceId:string,before:string,
    handler:(pass:Pass<'phone.readRouterSnapshot'>)=>T):T{
    const head={route:'phone.readRouterSnapshot' as const,input:{family:'needs-you-tray' as const,workspaceId}};
    const residency=[...this.residencies.values()].find(value=>value.generation===generation&&value.screen==='Tray'&&
      value.lifetime.active&&value.keys.includes(this.key(head)));
    if(!this.foreground||!residency)return this.deny('inactive Saved action');
    if(typeof before!=='string'||before.length>1024||!/^saved1\.[a-zA-Z0-9_-]+$/.test(before))return this.deny('invalid Saved continuation');
    const request={route:'phone.readRouterSnapshot' as const,input:{family:'needs-you-saved-page' as const,workspaceId,before}};
    this.validateRequests([request]);
    const lifetime={active:true},pass=this.mint(request,lifetime);
    this.states.get(pass)!.completionLifetime=residency.lifetime;
    try{return handler(pass);}finally{lifetime.active=false;}
  }

  /** Explicit Retry's synchronous prefix. The spent read remains fenced by
   * its existing navigation residency after the gesture has returned.
   */
  retry<T>(owner: string, request: Request<'phone.readRouterSnapshot'>,
    handler: (pass: Pass<'phone.readRouterSnapshot'>) => T): T {
    const residency = this.residencies.get(owner);
    if (!this.foreground || !residency?.lifetime.active) return this.deny('inactive retry owner');
    this.validateRequests([request]);
    if (!residency.keys.includes(this.key(request))) return this.deny('wrong retry key');
    const lifetime = { active: true };
    const pass = this.mint(request, lifetime);
    this.states.get(pass)!.completionLifetime = residency.lifetime;
    try { return handler(pass); }
    finally { lifetime.active = false; }
  }

  /** Called only by the authenticated, negotiated connection owner. An error,
   * timer or failed handshake is not a new generation. One batch per generation.
   */
  connected(generation: number, demanded: readonly Requests<ReadId>[]): readonly Pass<ReadId>[] {
    this.validateGeneration(generation);
    if (!this.foreground || generation <= this.lastConnection) return this.deny('stale connection');
    this.validateRequests(demanded);
    if (demanded.some(request => policies[request.route]?.mode !== 'read')) return this.deny('recovery command');
    this.lastConnection = generation;
    this.recoveryLifetime.active = false;
    this.recoveryLifetime = { active: true };
    return demanded.map(request => this.mint(request, this.recoveryLifetime));
  }

  /** Atomic spend precedes all asynchronous work. Only the wire operation and
   * canonical input leave admission; principal/pass/generation/key stay local.
   * This shadow result has no executor. Production continues through legacy.
   */
  spend<K extends PolicyId>(request: Request<K>, pass: Pass<K>) {
    const state = this.states.get(pass);
    if (!state || state.session !== this.session || state.spent || !state.lifetime.active || !this.foreground)
      return this.deny('inactive pass');
    if (state.route !== request.route || state.key !== this.key(request)) return this.deny('wrong route or key');
    state.spent = true;
    const session = this.session;
    const wire = Object.freeze({ operation: request.route.slice('phone.'.length), input: canonical(request.input) });
    return Object.freeze({ wire, isCurrent: () => session === this.session &&
      (policies[request.route].mode === 'command' || (state.completionLifetime ?? state.lifetime).active && this.foreground) });
  }

  localDiagnostics(): readonly string[] { return [...this.diagnostics]; }

  private key(request: Request<PolicyId>): string {
    return canonical([this.identity.origin, this.identity.principal, this.identity.sessionEpoch, request.route, request.input]);
  }
  private mint<K extends PolicyId>(request: Request<K>, lifetime: { active: boolean }): Pass<K> {
    const pass = Object.freeze({}) as Pass<K>;
    this.states.set(pass, { key: this.key(request), route: request.route, session: this.session, lifetime, spent: false });
    return pass;
  }
  private validateRequests(requests: readonly Requests<PolicyId>[]): void {
    if (requests.length > 16) return this.deny('owner key quota');
    const keys = new Set<string>();
    for (const request of requests) {
      if (!Object.hasOwn(policies, request.route)) return this.deny('unknown route');
      validateOwnerInput(request.route, request.input);
      const key = this.key(request);
      if (keys.has(key)) return this.deny('duplicate key');
      keys.add(key);
    }
  }
  private validateGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) return this.deny('invalid generation');
  }
  private deny(reason: string): never {
    // Closed short reasons; never inputs, identity, keys or recursive telemetry.
    if (this.diagnostics.length === 100) this.diagnostics.shift();
    this.diagnostics.push(reason);
    throw new Error(`network admission: ${reason}`);
  }
}

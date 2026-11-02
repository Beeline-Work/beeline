import type { RouteInput } from '../routes.js';
import { observePhoneInput } from '../phone-inputs.js';
import { canonical } from './canonical.js';

// Initial shadow policies. These do NOT opt any wire family into router-v1.
// Extend only alongside a real trusted owner and its closure proofs.
const policies = {
  'phone.countNeedsYou': { mode: 'read', screen: 'AppShell' },
  'phone.readRoom': { mode: 'read', screen: 'Room' },
  'phone.readChats': { mode: 'read', screen: 'AppShell' },
  'phone.readRouterSnapshot': { mode: 'read', screen: 'AppShell' as 'AppShell' | 'Room' },
  'phone.sendRoomMessage': { mode: 'command', action: 'SendMessage' },
  'phone.sendRoomReply': { mode: 'command', action: 'SendMessage' },
} as const;
type Policy = typeof policies;
type PolicyId = keyof Policy;
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
  passes: readonly object[]; keys: readonly string[];
};

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
  }

  background(): void { this.foreground = false; this.blur(); this.recoveryLifetime.active = false; }
  foregrounded(): void { this.foreground = true; } // No minting, read or reconnect.
  blur(): void {
    for (const [owner, residency] of this.residencies) {
      residency.lifetime.active = false; this.retiredResidencies.set(owner, residency);
    }
    this.residencies.clear();
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
        if (screen === 'Room' ? family !== 'room-head' : !['room-list', 'needs-you-count'].includes(family))
          return this.deny('wrong screen family');
        if (family === 'room-head' ? !request.input.roomId : request.input.roomId !== undefined)
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
  tap<K extends 'phone.sendRoomMessage' | 'phone.sendRoomReply', T>(action: 'SendMessage', request: Request<K>,
    handler: (pass: Pass<K>) => T): T {
    if (!this.foreground) return this.deny('background');
    if (action !== 'SendMessage' || !['phone.sendRoomMessage', 'phone.sendRoomReply'].includes(request.route)) return this.deny('wrong action');
    this.validateRequests([request as Requests<PolicyId>]);
    if (typeof request.input.messageId !== 'string' || !/^[0-9a-f]{64}$/.test(request.input.messageId))
      return this.deny('prepared message identity required');
    const lifetime = { active: true };
    try { return handler(this.mint(request, lifetime)); }
    finally { lifetime.active = false; }
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
      if (observePhoneInput(request.route.slice('phone.'.length), request.input).verdict !== 'legacy-valid')
        throw new Error('network codec: contract mismatch');
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

// Only the private owner subpath exposes implementation machinery.
export { ReadLanes } from './read-lanes.js';
export type { LaneRequest, LaneFamily, LaneSnapshot, LaneView, LaneStorage } from './read-lanes.js';
export { RouterBatchAssembly } from './batch-assembly.js';
export { NavigationOwner } from './navigation-owner.js';
export type { NavigationState, NavigationResidency } from './navigation-owner.js';
export { CommandIntents } from './command-intents.js';
export type { CommandIntent, CommandIntentStorage, CommandPartition, CommandAttempt, AdmittedCommand, IntentOperation, IntentState } from './command-intents.js';

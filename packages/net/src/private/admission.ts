import { routes, type RouteInput } from '../routes.js';
import { canonical } from './canonical.js';

// Initial shadow policies. These do NOT opt any wire family into router-v1.
// Extend only alongside a real trusted owner and its closure proofs.
const policies = {
  'phone.countNeedsYou': { mode: 'read', screen: 'AppShell' },
  'phone.readRoom': { mode: 'read', screen: 'Room' },
  'phone.sendRoomMessage': { mode: 'command', action: 'SendMessage' },
} as const;
type Policy = typeof policies;
type PolicyId = keyof Policy;
type ReadId = { [K in PolicyId]: Policy[K] extends { mode: 'read' } ? K : never }[PolicyId];
type Screen = Policy[ReadId]['screen'];
type ScreenRoute<S extends Screen> = { [K in ReadId]: Policy[K]['screen'] extends S ? K : never }[ReadId];
type Request<K extends PolicyId> = { route: K; input: RouteInput<K> };
type Requests<K extends PolicyId> = { [P in K]: Request<P> }[K];
type Identity = Readonly<{ origin: string; principal: string; sessionEpoch: number }>;
declare const brand: unique symbol;
export type Pass<K extends PolicyId = PolicyId> = { readonly [brand]: (route: K) => K };
type State = {
  key: string; route: PolicyId; session: object; lifetime: { active: boolean };
  spent: boolean;
};
type Residency = {
  generation: number; screen: Screen; signature: string; lifetime: { active: boolean };
  passes: readonly object[];
};

/** Private trusted-owner machinery; no feature import, socket, clock or scheduler.
 * CREATED -> ACTIVE -> SPENT; blur/return/reset -> REVOKED. Never reactivated.
 * A navigation generation is supplied by navigation, never React effect setup.
 */
export class AdmissionOwner {
  private readonly states = new WeakMap<object, State>();
  private session: object = {};
  private identity: Identity;
  private residency?: Residency;
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
    this.lastConnection = -1;
  }

  background(): void { this.foreground = false; this.blur(); this.recoveryLifetime.active = false; }
  foregrounded(): void { this.foreground = true; } // No minting, read or reconnect.
  blur(): void {
    if (this.residency) this.residency.lifetime.active = false;
    this.residency = undefined;
  }

  focus<S extends Screen>(generation: number, screen: S, requests: readonly Requests<ScreenRoute<S>>[]): readonly Pass<ScreenRoute<S>>[] {
    if (!this.foreground) return this.deny('background');
    this.validateGeneration(generation);
    const signature = canonical(requests);
    if (this.residency?.generation === generation) {
      if (this.residency.screen !== screen || this.residency.signature !== signature) return this.deny('residency changed');
      return this.residency.passes as readonly Pass<ScreenRoute<S>>[];
    }
    if (generation <= this.lastResidency) return this.deny('stale residency');
    this.validateRequests(requests);
    for (const request of requests) {
      const policy = policies[request.route];
      if (!policy || !('screen' in policy) || policy.screen !== screen) return this.deny('wrong screen');
    }
    this.blur();
    this.lastResidency = generation;
    const lifetime = { active: true };
    const passes = requests.map(request => this.mint<ScreenRoute<S>>(request, lifetime));
    this.residency = { generation, screen, signature, lifetime, passes };
    return passes;
  }

  /** Handler return, including returning a Promise, ends gesture authority. */
  tap<T>(action: 'SendMessage', request: Request<'phone.sendRoomMessage'>,
    handler: (pass: Pass<'phone.sendRoomMessage'>) => T): T {
    if (!this.foreground) return this.deny('background');
    if (action !== 'SendMessage' || request.route !== 'phone.sendRoomMessage') return this.deny('wrong action');
    this.validateRequests([request]);
    if (typeof request.input.messageId !== 'string' || !/^[0-9a-f]{64}$/.test(request.input.messageId))
      return this.deny('prepared message identity required');
    const lifetime = { active: true };
    try { return handler(this.mint(request, lifetime)); }
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
    const wire = Object.freeze({ operation: routes[request.route].operation, input: canonical(request.input) });
    return Object.freeze({ wire, isCurrent: () => session === this.session &&
      (policies[request.route].mode === 'command' || state.lifetime.active && this.foreground) });
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
      routes[request.route].params.parse(request.input);
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

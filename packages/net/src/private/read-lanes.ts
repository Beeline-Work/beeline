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
  | { kind: 'authority'; scope: string; authorityScope?: string; allowed: boolean } }>;
export type LaneBatch = Readonly<{ from: LaneCut; to: LaneCut; facts: readonly LaneFact[] }>;
export type LaneIdentity = Readonly<{ origin: string; principal: string; sessionEpoch: number }>;
export type LanePermit = Readonly<{ isCurrent(): boolean }>;
export type LaneStorage = {
  /** One encoded atomic consistency group, including data and coverage. */
  write(key: string, encoded: string): Promise<void>;
  /** Fences are outside response LRU. This completes before a removal publishes. */
  fence(scope: string, epoch: string): Promise<void>;
  remove(key: string): Promise<void>;
};
type Owner = { permit: LanePermit; active: boolean };
type Entry = {
  key: string; request: LaneRequest; expectedWorkspace?: string; view: LaneView; owners: Map<object, Owner>;
  snapshot?: LaneSnapshot; flight?: Promise<void>; revision: number; connection: number;
  pending: LaneBatch[]; pendingBytes: number; future: LaneBatch[]; futureBytes: number; listeners: Set<() => void>;
};
const ABSENT_VIEW: LaneView = Object.freeze({ state: 'ABSENT', value: null, error: null, cut: null });
const absent = (): LaneView => ABSENT_VIEW;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const sameStream = (a: LaneCut, b: LaneCut): boolean => a.stream === b.stream && a.epoch === b.epoch && a.protocol === b.protocol;
const liveOwner = (entry: Entry): boolean => [...entry.owners.values()].some(owner => owner.active && owner.permit.isCurrent());
const scopeOf = (request: LaneRequest): string => request.family === 'room-head' ? request.roomId! : request.workspaceId;

/** An executor is installed only by the negotiated connection owner. Demand
 * arrives only after admission has atomically consumed a real owner pass.
 * Failure, push, time and cache age cannot call the executor.
 */
export class ReadLanes {
  private readonly entries = new Map<string, Entry>();
  private readonly fences = new Map<string, string>();
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
    if (entry && request.family === 'room-head' && request.workspaceId &&
        (entry.expectedWorkspace && entry.expectedWorkspace !== request.workspaceId ||
         entry.snapshot && entry.snapshot.cut.stream !== `workspace:${request.workspaceId}`)) throw new Error('Room Workspace mismatch');
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
      entry.snapshot = undefined;
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
    if (permit.isCurrent() && !entry.flight && entry.view.state !== 'LIVE' && !previous && this.supports(request.family)) this.open(entry);
    return () => {
      if (entry.owners.get(token) !== owner) return;
      owner.active = false; entry.owners.delete(token);
      if (!liveOwner(entry)) {
        // A pending reply can no longer paint or restore authority.
        entry.revision += 1; entry.flight = undefined;
        entry.pending = []; entry.pendingBytes = 0; entry.future = []; entry.futureBytes = 0;
        this.publish(entry, { ...entry.view, state: entry.snapshot ? 'INACTIVE_CACHED' : 'ABSENT' });
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
      const revocations = batch.facts.filter(fact => fact.payload.kind === 'authority' && !fact.payload.allowed);
      for (const fact of revocations) {
        if (fact.payload.kind !== 'authority') continue;
        const logicalScope = fact.payload.scope;
        // Wire removal separates logical resource scope from the exact
        // denied permission domain. Never infer denial from another domain
        // that merely shares this complete certificate.
        const targetDomain = fact.payload.authorityScope;
        const streamWorkspace = batch.to.stream.startsWith('workspace:') ? batch.to.stream.slice('workspace:'.length) : undefined;
        const roomFits = targetDomain === `room:${logicalScope}` && !!streamWorkspace &&
          fact.authority.scopes.some(scope => scope.authorityScope === `reader:${this.identity.principal}:workspace:${streamWorkspace}`);
        const domainFits = roomFits || targetDomain === `reader:${this.identity.principal}:workspace:${logicalScope}` &&
          batch.to.stream === `workspace:${logicalScope}`;
        const target = domainFits ? fact.authority.scopes.find(scope => scope.authorityScope === targetDomain) : undefined;
        if (!target) {
          for (const entry of this.entries.values()) if (entry.request.roomId === logicalScope ||
              entry.request.workspaceId === logicalScope || entry.snapshot?.cut.stream === `workspace:${logicalScope}`) {
            entry.revision += 1; entry.snapshot = undefined; entry.flight = undefined;
            this.publish(entry, { ...absent(), state: 'PARKED', error: 'Unknown authority.' });
          }
          continue;
        }
        await this.revoke(target.authorityScope, target.epoch);

      }
      const installs: { entry: Entry; snapshot: LaneSnapshot }[] = [];
      for (const entry of this.entries.values()) {
        if (entry.view.state === 'REVOKED' || entry.view.state === 'PARKED') continue;
        if (entry.flight) {
          if (entry.request.workspaceId ? batch.to.stream !== `workspace:${entry.request.workspaceId}` :
            !batch.facts.some(fact => fact.payload.kind === 'scope-replace' && fact.payload.family === entry.request.family && fact.payload.scope === scopeOf(entry.request))) continue;
          const size = bytes(batch);
          const primaryBytes = entry.pending[0] ? bytes(entry.pending[0]) : 0;
          if (size > 1024 * 1024 || entry.pending.length >= 17 ||
              entry.pending.length > 0 && entry.pendingBytes - primaryBytes + size > 256 * 1024)
            this.park(entry, 'Projection queue overflow; Retry.');
          else { entry.pending.push(batch); entry.pendingBytes += size; }
          continue;
        }
        const held = entry.snapshot;
        if (!held || held.cut.stream !== batch.to.stream) continue;
        if (!sameStream(held.cut, batch.to)) { this.park(entry, 'Projection version changed; Retry.'); continue; }
        if (batch.to.through <= held.cut.through) continue;
        if (batch.from.through > held.cut.through) {
          const duplicate = entry.future.find(held => held.from.through === batch.from.through && held.to.through === batch.to.through);
          if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(batch)) this.park(entry, 'Conflicting projection; Retry.');
          else if (!duplicate) {
            const size = bytes(batch);
            if (entry.future.length >= 16 || entry.futureBytes + size > 256 * 1024) this.park(entry, 'Projection gap; Retry.');
            else { entry.future.push(batch); entry.futureBytes += size; }
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
        const cut = entry.snapshot?.cut;
        if (!cut || entry.view.state === 'PARKED' || entry.view.state === 'REVOKED') continue;
        entry.future = entry.future.filter(future => {
          if (future.from.through > cut.through) return true;
          entry.futureBytes -= bytes(future);
          if (future.to.through > cut.through) ready.set(JSON.stringify([future.from, future.to]), future);
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

  /** Content-free durable fence adoption (including another local web tab).
   * No pass is created and no snapshot is requested.
   */
  async revoke(scope: string, epoch: string, persist = true): Promise<void> {
    if (!/^\d+$/.test(epoch)) return;
    const held = this.fences.get(scope);
    if (held && BigInt(held) >= BigInt(epoch)) return;
    this.fences.set(scope, epoch);
    // Purge immediately; disk failure must never preserve visible content.
    const removals: string[] = [];
    for (const entry of this.entries.values()) {
      const installed = entry.snapshot?.authority.scopes.find(authority => authority.authorityScope === scope);
      // An older ordered removal cannot erase a subsequently authorized grant.
      // Unknown/older pending baselines remain fenced below.
      if (installed && /^\d+$/.test(installed.epoch) && BigInt(installed.epoch) > BigInt(epoch)) continue;
      const roomId = scope.startsWith('room:') ? scope.slice('room:'.length) : undefined;
      const workspacePrefix = `reader:${this.identity.principal}:workspace:`;
      const workspaceId = scope.startsWith(workspacePrefix) ? scope.slice(workspacePrefix.length) : undefined;
      if (!entry.snapshot?.authority.scopes.some(authority => authority.authorityScope === scope) &&
          !(roomId && entry.request.family === 'room-head' && entry.request.roomId === roomId) &&
          !(workspaceId && (entry.request.workspaceId === workspaceId || entry.snapshot?.cut.stream === `workspace:${workspaceId}`))) continue;
      entry.revision += 1; entry.snapshot = undefined; entry.flight = undefined;
      this.publish(entry, { ...absent(), state: 'REVOKED', error: 'Access removed.' });
      removals.push(entry.key);
    }
    if (persist) await this.storage?.fence(scope, epoch);
    for (const key of removals) await this.storage?.remove(key);
  }

  reset(): void {
    this.session += 1; this.disconnected();
    for (const entry of this.entries.values()) { entry.snapshot = undefined; this.publish(entry, absent()); }
    this.entries.clear(); this.fences.clear();
  }

  private entry(request: LaneRequest): Entry {
    const key = this.key(request);
    let entry = this.entries.get(key);
    if (!entry) {
      if (request.family === 'room-head' ? !request.roomId : !request.workspaceId) throw new Error('invalid lane scope');
      entry = { key, request: Object.freeze({ ...request }), view: absent(), owners: new Map(), revision: 0,
        connection: -1, pending: [], pendingBytes: 0, future: [], futureBytes: 0, listeners: new Set() };
      this.entries.set(key, entry); this.evict();
    }
    if (request.family === 'room-head' && request.workspaceId) {
      if (entry.expectedWorkspace && entry.expectedWorkspace !== request.workspaceId ||
          entry.snapshot && entry.snapshot.cut.stream !== `workspace:${request.workspaceId}`) throw new Error('Room Workspace mismatch');
      entry.expectedWorkspace = request.workspaceId;
    }
    return entry;
  }
  private open(entry: Entry): void {
    const execute = this.executor;
    if (!execute || !liveOwner(entry) || entry.flight) return;
    const revision = ++entry.revision; const session = this.session; const generation = this.generation;
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
        (!this.fences.has(scope.authorityScope) || /^\d+$/.test(scope.epoch) && /^\d+$/.test(this.fences.get(scope.authorityScope)!) && BigInt(scope.epoch) > BigInt(this.fences.get(scope.authorityScope)!)));
  }
  private async installGroups(installs: readonly { entry: Entry; snapshot: LaneSnapshot }[], session: number): Promise<void> {
    const groups = new Map<string, typeof installs[number][]>();
    for (const install of installs) {
      const group = groups.get(install.snapshot.atomicGroup) ?? []; group.push(install); groups.set(install.snapshot.atomicGroup, group);
    }
    for (const [group, items] of groups) {
      const versions = items.map(({ entry }) => entry.revision);
      const encoded = JSON.stringify({ schema: 1, identity: this.identity, group,
        entries: items.map(({ entry, snapshot }) => ({ key: entry.key, request: entry.request, snapshot })) });
      await this.storage?.write(JSON.stringify([this.identity.origin, this.identity.principal, group]), encoded);
      if (session !== this.session) return;
      if (items.some(({ entry }, index) => entry.revision !== versions[index])) continue;
      // Commit the complete group before notifying a single UI observer.
      for (const { entry, snapshot } of items) {
        entry.snapshot = snapshot;
        entry.view = { state: liveOwner(entry) ? 'LIVE' : 'INACTIVE_CACHED', value: snapshot.value, cut: snapshot.cut, error: null };
      }
      for (const { entry } of items) this.notify(entry);
    }
    this.evict();
  }
  private park(entry: Entry, error: string): void {
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

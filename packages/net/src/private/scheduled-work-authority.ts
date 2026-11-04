import type { RouterAuthorityFence, ScheduledWorkAuthorityFrame, ScheduledWorkAuthorityPosition } from '@beeline/api-contract/router-protocol';
import { jsonBytes as bytes, remember } from './staging-bounds.js';
import { Multipart, multipartIdentity, multipartRecords, positionKey, type MultipartBatch } from './batch-assembly.js';

export type ScheduledAuthorityFence = RouterAuthorityFence & { readonly mode: 'deny' | 'advance' };
export type ScheduledAuthorityFault = 'protocol' | 'digest' | 'continuity' | 'budget' | 'storage' | 'callback' |
  'source-loss' | 'restart' | 'generation' | 'disconnected' | 'duplicate';
export type ScheduledAuthorityCallbacks = Readonly<{
  /** Same canonical value hashing as the server, not an already-stringified value. */
  digest(value: unknown): string | Promise<string>;
  /** Hide/adopt the local floor/deny AND persist it before resolving. */
  persist(fence: ScheduledAuthorityFence): Promise<void>;
  /** Synchronously hide/park only Scheduled Work. Never reads or reconnects. */
  park(reason: ScheduledAuthorityFault): void;
}>;
export type ScheduledAuthorityDeferred = Readonly<{
  id: string; kind: 'snapshot' | 'batch'; barrier: ScheduledWorkAuthorityPosition; bytes: number;
  apply(): void; discard(reason: ScheduledAuthorityFault): void;
}>;
type Part = Extract<ScheduledWorkAuthorityFrame, { kind: 'scheduled-work-authority-part' }>;
type Commit = Extract<ScheduledWorkAuthorityFrame, { kind: 'scheduled-work-authority-commit' }>;
type Complete = { signature: string; parts: readonly string[] };
type Proof={replay:Complete;verified:{fences:readonly ScheduledAuthorityFence[];parts:readonly string[]}};
type Batch=MultipartBatch<ScheduledAuthorityFence,ScheduledWorkAuthorityPosition,Proof>;
type Pending = { value: ScheduledAuthorityDeferred; signature: string };
type State = {
  generation: number; start: ScheduledWorkAuthorityPosition; processed: ScheduledWorkAuthorityPosition;
  lost: boolean; failed: boolean; batches: Multipart<ScheduledAuthorityFence,ScheduledWorkAuthorityPosition,Proof>; completed: Map<string, Complete>;
  history: Map<string, string>; deferred: Map<string, Pending>; dirty: boolean; pumping: boolean; pump?: Promise<void>;
};
const scalar = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const epoch = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const sameSource = (a: ScheduledWorkAuthorityPosition, b: ScheduledWorkAuthorityPosition) =>
  a.stream === b.stream && a.epoch === b.epoch && a.segment === b.segment;
const interval = (frame: Batch['frame']) => JSON.stringify([frame.from.through, frame.to.through]);
const positionCopy = (position: ScheduledWorkAuthorityPosition) => Object.freeze({ ...position });

/** Local content-free authority ordering only. No transport, admission pass,
 * timer, native module, cache inventory or data-cut mutation is available here.
 * A start/barrier never authorizes data: the caller still owns admitted reads,
 * certificate validation and finally fenced baseline/classification rules. */
const PART_KIND='scheduled-work-authority-part', COMMIT_KIND='scheduled-work-authority-commit';
export class ScheduledWorkAuthority {
  private state?: State;
  private lastGeneration = -1;
  constructor(private readonly principal: string, private readonly callbacks: ScheduledAuthorityCallbacks) {
    if (!scalar(principal)) throw new Error('Invalid Scheduled Work principal');
  }

  connected(generation: number, start: ScheduledWorkAuthorityPosition): boolean {
    if (!Number.isSafeInteger(generation) || generation < 0 || generation <= this.lastGeneration) return false;
    if (this.state) this.stop(this.state, 'generation');
    this.state = undefined; this.lastGeneration = generation;
    if (!this.validPosition(start)) { this.park('protocol'); return false; }
    this.state = this.fresh(generation, start); return true;
  }
  disconnected(generation: number): void {
    const state = this.state;
    if (!state || state.generation !== generation) return;
    this.stop(state, 'disconnected'); this.state = undefined;
  }
  sourceLost(generation: number): void {
    const state = this.state;
    if (!state || state.generation !== generation || state.lost) return;
    state.lost = true; this.stop(state, 'source-loss');
  }
  position(): ScheduledWorkAuthorityPosition | undefined {
    const state = this.state;
    return state && !state.lost && !state.failed ? positionCopy(state.processed) : undefined;
  }

  accept(generation: number, raw: unknown): Promise<void> {
    const state = this.state;
    if (!state || generation !== state.generation) return Promise.resolve();
    if (record(raw) && raw.kind === 'scheduled-work-authority-restart') {
      if (!exact(raw, ['kind', 'start']) || !this.validPosition(raw.start) || !state.lost ||
        raw.start.segment === state.start.segment || raw.start.epoch === state.processed.epoch && raw.start.through < state.processed.through) {
        this.fail(state, 'continuity'); return Promise.resolve();
      }
      this.stop(state, 'restart'); this.state = this.fresh(generation, raw.start); return Promise.resolve();
    }
    if (state.lost || state.failed) return Promise.resolve();
    let frame: Part | Commit;
    try {
      if (!this.validFrame(raw)) { this.fail(state, 'protocol'); return Promise.resolve(); }
      frame = raw; // The shared multipart owner clones retained headers/parts.
    } catch { this.fail(state, 'protocol'); return Promise.resolve(); }
    if (!sameSource(frame.from, state.start) || !sameSource(frame.to, state.start) || frame.from.through < state.start.through) {
      this.fail(state, 'continuity'); return Promise.resolve();
    }
    const identity = multipartIdentity(frame), completed = state.completed.get(frame.batchId);
    if (completed && completed.signature !== identity) { this.fail(state, 'continuity'); return Promise.resolve(); }
    if (completed && frame.kind === COMMIT_KIND) return Promise.resolve();
    const batch=state.batches.accept(frame,frame.kind===PART_KIND?{index:frame.partIndex,values:frame.fences}:undefined);
    if(typeof batch==='string'){this.fail(state,batch);return Promise.resolve();}
    batch.replay=completed;
    state.dirty = true; return this.schedule(state);
  }

  defer(generation: number, deferred: ScheduledAuthorityDeferred): void {
    const state = this.state;
    if (!state || generation !== state.generation) { this.discard(deferred, 'generation'); return; }
    if (state.lost || state.failed) { this.discard(deferred, 'source-loss'); return; }
    if (!scalar(deferred.id, 256) || !['snapshot', 'batch'].includes(deferred.kind) || !this.validPosition(deferred.barrier) ||
      !Number.isSafeInteger(deferred.bytes) || deferred.bytes < 0 ||
      typeof deferred.apply !== 'function' || typeof deferred.discard !== 'function') {
      this.discard(deferred, 'protocol'); this.fail(state, 'protocol'); return;
    }
    if (!sameSource(deferred.barrier, state.start) || deferred.barrier.through < state.start.through) {
      this.discard(deferred, 'continuity'); this.fail(state, 'continuity'); return;
    }
    const key = JSON.stringify([deferred.kind, deferred.id]), identity = JSON.stringify([positionKey(deferred.barrier), deferred.bytes]);
    const previous = state.deferred.get(key);
    if (previous) {
      if (previous.signature !== identity) { this.discard(deferred, 'continuity'); this.fail(state, 'continuity'); }
      else if (previous.value.apply !== deferred.apply || previous.value.discard !== deferred.discard) this.discard(deferred, 'duplicate');
      return;
    }
    const value = Object.freeze({ ...deferred, barrier: positionCopy(deferred.barrier) });
    state.deferred.set(key, { value, signature: identity });

    if (!state.pumping) this.release(state);
  }

  private fresh(generation: number, start: ScheduledWorkAuthorityPosition): State {
    return { generation, start: positionCopy(start), processed: positionCopy(start), lost: false, failed: false,
      batches: new Multipart(true), completed: new Map(), history: new Map(), deferred: new Map(), dirty: false, pumping: false };
  }
  private current(state: State) { return this.state === state && !state.lost && !state.failed; }
  private validPosition(value: unknown): value is ScheduledWorkAuthorityPosition {
    return record(value) && exact(value, ['stream', 'epoch', 'segment', 'through', 'protocol']) &&
      value.stream === `authority:${this.principal}` && scalar(value.epoch) && scalar(value.segment) &&
      Number.isSafeInteger(value.through) && (value.through as number) >= 0 && value.protocol === 1;
  }
  private domain(value: string): boolean {
    if (value === `scheduled-work-principal:${this.principal}`) return true;
    for (const prefix of [`scheduled-work-manager:${this.principal}:workspace:`, `scheduled-work-member:${this.principal}:room:`, 'scheduled-work-room:']) {
      if (value.startsWith(prefix) && scalar(value.slice(prefix.length))) return true;
    }
    return false;
  }
  private validFence(value: unknown): value is ScheduledAuthorityFence {
    if (!record(value) || !exact(value, ['kind', 'scope', 'authorityScope', 'mode', 'authority']) ||
      value.kind !== 'authority-fence' || !scalar(value.scope) || typeof value.authorityScope !== 'string' ||
      !['deny', 'advance'].includes(String(value.mode)) || !record(value.authority) ||
      !exact(value.authority, ['digest', 'scopes']) || !hash(value.authority.digest) || !Array.isArray(value.authority.scopes) ||
      !value.authority.scopes.length || value.authority.scopes.length > 8) return false;
    const target = value.authorityScope, logical = value.scope;
    if (!(target === `scheduled-work-principal:${this.principal}` && logical === this.principal ||
      target === `scheduled-work-manager:${this.principal}:workspace:${logical}` ||
      target === `scheduled-work-member:${this.principal}:room:${logical}` || target === `scheduled-work-room:${logical}`)) return false;
    const domains = new Set<string>();
    for (const scope of value.authority.scopes) {
      if (!record(scope) || !exact(scope, ['authorityScope', 'epoch']) || typeof scope.authorityScope !== 'string' ||
        !this.domain(scope.authorityScope) || domains.has(scope.authorityScope) || !epoch(scope.epoch)) return false;
      domains.add(scope.authorityScope);
    }
    return domains.has(target);
  }
  private validFrame(value: unknown): value is Part | Commit {
    if (!record(value) || ![PART_KIND, COMMIT_KIND].includes(String(value.kind)) ||
      !scalar(value.batchId) || !this.validPosition(value.from) || !this.validPosition(value.to) ||
      !sameSource(value.from, value.to) || value.to.through < value.from.through || !hash(value.contentDigest)) return false;
    const keys = ['kind', 'batchId', 'from', 'to', 'partCount', 'contentDigest'];
    if (value.kind === COMMIT_KIND) return exact(value, keys);
    return exact(value, [...keys, 'partIndex', 'fences']) && Array.isArray(value.fences) &&
      value.fences.every(fence => this.validFence(fence));
  }
  private schedule(state: State): Promise<void> {
    if (state.pumping) return state.pump!;
    state.pumping = true;
    state.pump = Promise.resolve().then(() => this.run(state)).catch(() => {
      if (this.current(state)) this.fail(state, 'digest');
    }).finally(() => {
      state.pumping = false;
      // A callback/receive at the completion edge cannot lose its wake. There
      // is one pump, never a promise chain/read appended per incoming frame.
      if (this.current(state) && state.dirty) void this.schedule(state);
    });
    return state.pump;
  }
  private async run(state: State): Promise<void> {
    while (this.current(state)) {
      state.dirty = false;
      let progressed = false;
      for (const [id, batch] of state.batches) {
        if (batch.replay) {
          for (const [index, part] of batch.parts) {
            const digest = await this.callbacks.digest(part);
            if (!this.current(state)) return;
            if (digest !== batch.replay.parts[index]) { this.fail(state, 'digest'); return; }
            batch.parts.delete(index); batch.bytes -= bytes(part);
          }
          state.batches.delete(id); progressed = true; continue;
        }
        if(batch.verified)continue;
        const fences=multipartRecords(batch);if(!fences)continue;
        const targets = new Map<string, string>();
        for(const fence of fences){
          const encoded=JSON.stringify(fence),prior=targets.get(fence.authorityScope);
          if(prior&&prior!==encoded){this.fail(state,'protocol');return;}
          targets.set(fence.authorityScope,encoded);
        }
        if (await this.callbacks.digest(fences) !== batch.frame.contentDigest) { if (this.current(state)) this.fail(state, 'digest'); return; }
        if (!this.current(state)) return;
        const certificates = new Set<string>();
        for (const fence of fences) {
          const ordered = [...fence.authority.scopes].sort((a, b) => a.authorityScope.localeCompare(b.authorityScope));
          const encoded = JSON.stringify([fence.authority.digest, ordered]);
          if (certificates.has(encoded)) continue;
          if (await this.callbacks.digest(ordered) !== fence.authority.digest) { if (this.current(state)) this.fail(state, 'digest'); return; }
          if (!this.current(state)) return;
          certificates.add(encoded);
        }
        const partDigests: string[] = [];
        for (let index = 0; index < batch.frame.partCount; index++) {
          partDigests.push(await this.callbacks.digest(batch.parts.get(index)!));
          if (!this.current(state)) return;
        }
        batch.verified = { fences, parts: partDigests }; progressed = true;
      }
      if (!this.current(state)) return;
      const ready = [...state.batches.entries()].filter(([, batch]) => batch.verified)
        .sort((a, b) => a[1].frame.from.through - b[1].frame.from.through);
      let advanced = false;
      for (const [id, batch] of ready) {
        const { from, to, contentDigest } = batch.frame;
        if (from.through > state.processed.through) break;
        if (from.through < state.processed.through || to.through === state.processed.through && state.history.has(interval(batch.frame))) {
          if (to.through > state.processed.through || state.history.get(interval(batch.frame)) !== contentDigest) {
            this.fail(state, 'continuity'); return;
          }
        } else {
          const persisted = new Set<string>();
          try {
            for (const fence of batch.verified!.fences) {
              if (persisted.has(fence.authorityScope)) continue;
              await this.callbacks.persist(fence);
              if (!this.current(state)) return;
              persisted.add(fence.authorityScope);
            }
          } catch { if (this.current(state)) this.fail(state, 'storage'); return; }
          state.processed = positionCopy(to); remember(state.history, interval(batch.frame), contentDigest);
        }
        remember(state.completed, id, { signature: batch.signature, parts: batch.verified!.parts });
        state.batches.delete(id); advanced = true;
      }
      if (state.dirty || advanced || progressed) continue;
      this.release(state);
      if (!state.dirty) return;
    }
  }
  private release(state: State): void {
    if (!this.current(state)) return;
    for (const [key, pending] of state.deferred) {
      if (pending.value.barrier.through > state.processed.through) continue;
      state.deferred.delete(key);
      try { pending.value.apply(); } catch { this.fail(state, 'callback'); return; }
      if (!this.current(state)) return;
    }
  }
  private park(reason: ScheduledAuthorityFault): void { try { this.callbacks.park(reason); } catch { /* Already fail closed locally. */ } }
  private discard(value: ScheduledAuthorityDeferred, reason: ScheduledAuthorityFault): void { try { value.discard(reason); } catch { /* Release every remaining owned item. */ } }
  private stop(state: State, reason: ScheduledAuthorityFault): void {
    state.failed = true; state.batches.clear(); state.completed.clear(); state.history.clear();
    const pending = [...state.deferred.values()]; state.deferred.clear(); this.park(reason);
    for (const item of pending) this.discard(item.value, reason);
  }
  private fail(state: State, reason: ScheduledAuthorityFault): void { if (this.state === state && !state.failed) this.stop(state, reason); }
}

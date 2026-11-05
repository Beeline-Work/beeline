import { randomUUID } from 'node:crypto';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import {
  HELPER_TURN_REQUEST_DEADLINE_MS,
  type HelperTurnOperation, type HelperTurnOwnershipSource,
} from '@beeline/api-contract/helper-turn-ownership';
import { helperTurnCodecs } from '@beeline/net/helper-turn-codecs';

type Turn = { roomId: string; requestId: string; generationId?: string };
type Owned = { source: HelperTurnOwnershipSource; active: boolean; lost: boolean; onLost?: () => void };
const key = (turn: Turn): string => JSON.stringify([turn.roomId, turn.requestId, turn.generationId]);
const same = (a: HelperTurnOwnershipSource | undefined, b: HelperTurnOwnershipSource | undefined): boolean =>
  Boolean(a && b && a.connectionId === b.connectionId && a.epoch === b.epoch);

/** Existing AgentChannel controls only. Source identity comes from registration;
 * unknown requests retain their command/generation and never downgrade to HTTP. */
export class HelperTurnChannel {
  selected = false;
  private source?: HelperTurnOwnershipSource;
  private continuation = false;
  private readonly owned = new Map<string, Owned>();
  private readonly legacy = new Set<string>();
  private readonly pending = new Map<string, {
    operation: HelperTurnOperation; resolve: (value: unknown) => void; reject: (error: Error) => void;
    frame: Record<string, unknown>; deadline?: ReturnType<typeof setTimeout>;
  }>();
  constructor(
    private readonly send: (frame: Record<string, unknown>) => boolean,
    private readonly open: () => boolean,
    private readonly reconnect: () => void = () => {},
  ) {}

  scope(): HelperTurnOwnershipSource | undefined { return this.open() || this.continuation ? this.source : undefined; }
  negotiate(source: HelperTurnOwnershipSource | undefined, advertised = source !== undefined, continuation = false): void {
    this.continuation = continuation;
    if (advertised) this.selected = true;
    if (source && source.connectionId.length <= 128 && source.connectionId.length > 0 &&
        Number.isSafeInteger(source.epoch) && source.epoch > 0) {
      if (!same(this.source, source)) {
        for (const owned of this.owned.values()) if (!same(owned.source, source)) this.lose(owned);
      }
      this.selected = true;
      this.source = source;
      for (const [requestId, pending] of this.pending) this.dispatch(requestId, pending);
    } else this.suspend();
  }
  private lose(owned: Owned): void {
    if (!owned.active || owned.lost) return;
    owned.lost = true;
    try { owned.onLost?.(); } catch { console.warn('[turn-owner] local cancellation failed'); }
  }
  suspend(): void {
    if (!this.continuation) this.source = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.deadline);
      pending.deadline = undefined;
      if (!this.continuation) pending.reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
    }
    if (!this.continuation) this.pending.clear();
  }
  stop(): void {
    this.continuation = false;
    this.suspend();
    for (const owned of this.owned.values()) this.lose(owned);
  }
  isLegacy(turn: Turn): boolean { return this.legacy.has(key(turn)); }
  claimedLegacy(turn: Turn): void {
    this.legacy.add(key(turn));
  }
  claimed(turn: Turn, source: HelperTurnOwnershipSource, onLost: () => void): void {
    const id = key(turn), previous = this.owned.get(id);
    if (previous && !same(previous.source, source)) throw new Error('Turn generation cannot change owner');
    if (previous && !previous.active) throw new Error('Turn generation already ended');
    if (!previous && this.owned.size >= 8_192) {
      const old = [...this.owned].find(([, owned]) => !owned.active);
      if (old) this.owned.delete(old[0]);
    }
    const owned: Owned = previous ?? { source, active: true, lost: false };
    owned.onLost = onLost;
    this.owned.set(id, owned);
    this.legacy.delete(id);
    if (this.scope() && !same(source, this.scope())) this.lose(owned);
  }
  release(turn: Turn): void {
    this.legacy.delete(key(turn));
    const owned = this.owned.get(key(turn));
    if (owned) { owned.active = false; owned.onLost = undefined; }
  }
  runOwned<T>(turn: Turn, task: () => Promise<T>, onLost?: () => void): Promise<T> | undefined {
    const owned = this.owned.get(key(turn));
    if (!owned) return !this.selected || this.isLegacy(turn)
      ? undefined : Promise.reject(new Error('Turn ownership was not admitted'));
    if (!owned.active) return Promise.reject(new Error('Turn generation already ended'));
    owned.onLost ??= onLost;
    if (owned.lost || (this.scope() && !same(owned.source, this.scope()))) {
      this.lose(owned);
      return Promise.reject(new Error('Turn ownership ended'));
    }
    return task();
  }
  request<N extends HelperTurnOperation>(operation: N, input: DaemonOperationMap[N]['input']): Promise<DaemonOperationMap[N]['output']> {
    if (!this.scope() && !this.continuation)
      return Promise.reject(new Error('Turn machine capability unavailable; no legacy fallback.'));
    return new Promise((resolve, reject) => {
      let parsed: DaemonOperationMap[N]['input'];
      try { parsed = helperTurnCodecs(operation).params.parse(input) as DaemonOperationMap[N]['input']; }
      catch (error) { reject(error); return; }
      const requestId = randomUUID();
      const frame = { type: 'turn-operation', requestId, operation, input: parsed };
      const pending = { operation, frame, resolve: (value: unknown) => resolve(value as DaemonOperationMap[N]['output']), reject };
      this.pending.set(requestId, pending);
      this.dispatch(requestId, pending);
    });
  }
  /** Reconcile the same idempotent control only when registration opens.
   * A transport failure reconnects; it never ends the execution generation. */
  private dispatch(requestId: string, pending: {frame: Record<string, unknown>;
    reject: (error: Error) => void; deadline?: ReturnType<typeof setTimeout>}): void {
    if (!this.open() || !this.scope() || pending.deadline) return;
    pending.deadline = setTimeout(() => {
      pending.deadline = undefined;
      if (!this.continuation) {
        this.pending.delete(requestId);
        pending.reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
      }
      this.reconnect();
    }, HELPER_TURN_REQUEST_DEADLINE_MS);
    pending.deadline.unref?.();
    if (!this.send(pending.frame)) {
      clearTimeout(pending.deadline); pending.deadline = undefined;
      if (!this.continuation) {
        this.pending.delete(requestId);
        pending.reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
      }
      this.reconnect();
    }
  }
  receive(frame: Record<string, unknown>): boolean {
    if (frame.type !== 'turn-result') return false;
    const pending = typeof frame.requestId === 'string' ? this.pending.get(frame.requestId) : undefined;
    if (!pending) return true;
    clearTimeout(pending.deadline); pending.deadline = undefined;
    const malformed = Object.keys(frame).some(field => !['type', 'agentId', 'requestId', 'result', 'error', 'status'].includes(field));
    if (malformed || typeof frame.error === 'string') {
      const status = typeof frame.status === 'number' ? frame.status : 503;
      const definitive = !malformed && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (!this.continuation || definitive) {
        this.pending.delete(frame.requestId as string);
        pending.reject(Object.assign(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'), {status}));
      }
      if (!definitive) this.reconnect();
      return true;
    }
    try {
      const result = helperTurnCodecs(pending.operation).result.parse(frame.result);
      this.pending.delete(frame.requestId as string);
      pending.resolve(result);
    } catch {
      if (!this.continuation) {
        this.pending.delete(frame.requestId as string);
        pending.reject(new Error('Turn reply malformed; outcome is UNKNOWN.'));
      }
      this.reconnect();
    }
    return true;
  }
}

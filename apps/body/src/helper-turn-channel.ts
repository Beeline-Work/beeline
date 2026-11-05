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
  private readonly owned = new Map<string, Owned>();
  private readonly legacy = new Set<string>();
  private readonly pending = new Map<string, {
    operation: HelperTurnOperation; resolve: (value: unknown) => void; reject: (error: Error) => void;
    deadline: ReturnType<typeof setTimeout>;
  }>();
  constructor(private readonly send: (frame: Record<string, unknown>) => boolean, private readonly open: () => boolean) {}

  scope(): HelperTurnOwnershipSource | undefined { return this.open() ? this.source : undefined; }
  negotiate(source: HelperTurnOwnershipSource | undefined, advertised = source !== undefined): void {
    if (advertised) this.selected = true;
    if (source && source.connectionId.length <= 128 && source.connectionId.length > 0 &&
        Number.isSafeInteger(source.epoch) && source.epoch > 0) {
      if (!same(this.source, source)) this.suspend();
      this.selected = true;
      this.source = source;
    } else this.suspend();
  }
  private lose(owned: Owned): void {
    if (!owned.active || owned.lost) return;
    owned.lost = true;
    try { owned.onLost?.(); } catch { console.warn('[turn-owner] local cancellation failed'); }
  }
  suspend(): void {
    this.source = undefined;
    for (const owned of this.owned.values()) this.lose(owned);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.deadline);
      pending.reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
    }
    this.pending.clear();
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
    if (!same(source, this.scope())) this.lose(owned);
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
    if (owned.lost || !same(owned.source, this.scope())) {
      this.lose(owned);
      return Promise.reject(new Error('Turn ownership ended'));
    }
    return task();
  }
  request<N extends HelperTurnOperation>(operation: N, input: DaemonOperationMap[N]['input']): Promise<DaemonOperationMap[N]['output']> {
    if (!this.scope())
      return Promise.reject(new Error('Turn machine capability unavailable; no legacy fallback.'));
    return new Promise((resolve, reject) => {
      let parsed: DaemonOperationMap[N]['input'];
      try { parsed = helperTurnCodecs(operation).params.parse(input) as DaemonOperationMap[N]['input']; }
      catch (error) { reject(error); return; }
      const requestId = randomUUID(), frame = { type: 'turn-operation', requestId, operation, input: parsed };
      const deadline = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
      }, HELPER_TURN_REQUEST_DEADLINE_MS);
      deadline.unref?.();
      this.pending.set(requestId, { operation, resolve: value => resolve(value as DaemonOperationMap[N]['output']), reject, deadline });
      if (!this.send(frame)) {
        this.pending.delete(requestId); clearTimeout(deadline);
        reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
      }
    });
  }
  receive(frame: Record<string, unknown>): boolean {
    if (frame.type !== 'turn-result') return false;
    const pending = typeof frame.requestId === 'string' ? this.pending.get(frame.requestId) : undefined;
    if (!pending) return true;
    this.pending.delete(frame.requestId as string); clearTimeout(pending.deadline);
    if (Object.keys(frame).some(field => !['type', 'agentId', 'requestId', 'result', 'error'].includes(field)) ||
        typeof frame.error === 'string') {
      pending.reject(new Error('Turn operation outcome is UNKNOWN; keep the same command and generation.'));
      return true;
    }
    try { pending.resolve(helperTurnCodecs(pending.operation).result.parse(frame.result)); }
    catch { pending.reject(new Error('Turn reply malformed; outcome is UNKNOWN.')); }
    return true;
  }
}

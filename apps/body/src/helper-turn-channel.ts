import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';

type Turn = { roomId: string; requestId: string; generationId?: string };
type Owned = { source: HelperTurnOwnershipSource; active: boolean; lost: boolean; onLost?: () => void };
const key = (turn: Turn): string => JSON.stringify([turn.roomId, turn.requestId, turn.generationId]);
const same = (a: HelperTurnOwnershipSource | undefined, b: HelperTurnOwnershipSource | undefined): boolean =>
  Boolean(a && b && a.connectionId === b.connectionId && a.epoch === b.epoch);

/** Existing AgentChannel controls only. Source identity comes from registration;
 * unknown requests retain their command/generation and never downgrade to HTTP. */
export class HelperTurnChannel {
  private source?: HelperTurnOwnershipSource;
  private readonly owned = new Map<string, Owned>();
  private readonly legacy = new Set<string>();
  scope(): HelperTurnOwnershipSource | undefined { return this.source; }
  negotiate(source: HelperTurnOwnershipSource | undefined): void {
    if (!source) return;
    if (!same(this.source, source))
      for (const owned of this.owned.values()) if (!same(owned.source, source)) this.lose(owned);
    this.source = source;
  }
  private lose(owned: Owned): void {
    if (!owned.active || owned.lost) return;
    owned.lost = true;
    try { owned.onLost?.(); } catch { console.warn('[turn-owner] local cancellation failed'); }
  }
  stop(): void {
    this.source = undefined;
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
    if (!owned) return this.isLegacy(turn)
      ? undefined : Promise.reject(new Error('Turn ownership was not admitted'));
    if (!owned.active) return Promise.reject(new Error('Turn generation already ended'));
    owned.onLost ??= onLost;
    if (owned.lost || (this.scope() && !same(owned.source, this.scope()))) {
      this.lose(owned);
      return Promise.reject(new Error('Turn ownership ended'));
    }
    return task();
  }
}

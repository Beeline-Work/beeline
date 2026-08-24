/**
 * Daemon-side publisher for the corner state record (see
 * `@beeline/buzz-client`'s `corner-state.ts` for the wire contract).
 *
 * Follows the proven `startAgentPresence` pattern:
 *  - `created_at` is stamped at PUBLISH time and strictly monotonic per
 *    corner — replaceable-record same-second ties are not guaranteed to keep
 *    the newest content;
 *  - publishes coalesce per corner (only the newest desired state matters to
 *    a replaceable record) and serialize so a slow relay cannot create
 *    overlapping writes;
 *  - a failed publish retries with bounded, jittered backoff honouring the
 *    relay's own advertised delay (`agentPresenceRetryDelayMs`), because a
 *    dropped state transition is a stuck deck verdict, not a lost log line.
 */
import type { Identity } from '@beeline/gate';
import { publishEvent } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  KIND_CORNER_STATE,
  TAG_CORNER_STATE,
  cornerStateKey,
  type CornerMachineReason,
  type CornerMachineState,
} from '@beeline/buzz-client';
import { AGENT_PRESENCE_RETRY_MAX_ATTEMPTS, agentPresenceRetryDelayMs } from './activity.js';

/**
 * Sign one corner state record. `createdAt` is supplied by the caller (the
 * publisher owns monotonicity); it is stamped into BOTH `created_at` and the
 * `at` tag so readers never have to trust the envelope alone.
 */
export function signCornerStateRecord(
  parentRoomId: string,
  cornerId: string,
  owner: Identity,
  state: CornerMachineState,
  reason: CornerMachineReason | undefined,
  createdAt: number,
): NostrEvent {
  return signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: KIND_CORNER_STATE,
      tags: [
        ['d', cornerStateKey(cornerId)],
        ['h', parentRoomId],
        ['t', TAG_CORNER_STATE],
        ['state', state],
        ...(reason ? [['reason', reason]] : []),
        ['at', String(createdAt)],
      ],
      content: JSON.stringify({ state, ...(reason ? { reason } : {}), at: createdAt }),
    },
    owner.secretKey,
  );
}

/** `created_at` strictly greater than the last value this publisher produced
 * for the corner, floored at the current wall clock. Same technique as the
 * presence heartbeat and the narrative committer. */
function nextMonotonicSecond(lastRef: { value: number }): number {
  const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastRef.value + 1);
  lastRef.value = createdAt;
  return createdAt;
}

export type CornerStatePublish = {
  parentRoomId: string;
  cornerId: string;
  state: CornerMachineState;
  reason?: CornerMachineReason;
};

/**
 * One serialized publish queue per corner. `publish()` enqueues the newest
 * desired state; anything still queued for that corner is superseded in
 * place, exactly like the presence heartbeat's coalescing — a replaceable
 * record makes intermediate states pure waste against the quota.
 */
export class CornerStatePublisher {
  private readonly queues = new Map<string, CornerStatePublish[]>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastCreatedAt = new Map<string, { value: number }>();
  private stopped = false;

  constructor(private readonly owner: Identity) {}

  /** Seed the monotonic floor from the standing replaceable record during
   * restore. A replacement daemon can start in the same wall-clock second as
   * its predecessor (or behind a predecessor that already bumped through
   * several same-second transitions), so wall time alone cannot guarantee its
   * reassertion wins the relay's replaceable-event ordering. */
  seedLastCreatedAt(cornerId: string, createdAt: number): void {
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return;
    const current = this.lastCreatedAt.get(cornerId)?.value ?? 0;
    if (createdAt > current) this.lastCreatedAt.set(cornerId, { value: createdAt });
  }

  /** Stop accepting new work; an in-flight publish finishes. Deliberately
   * publishes nothing on shutdown (the #384 presence lesson): the last record
   * stands, and a planned restart is a non-event. */
  stop(): void {
    this.stopped = true;
    this.queues.clear();
  }

  publish(next: CornerStatePublish): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = next.cornerId;
    // Coalesce: drop any queued-but-unstarted entry for this corner; the new
    // state supersedes it before it ever reaches the wire.
    this.queues.set(key, [next]);
    return this.ensureDrain(key);
  }

  /** Follow the active drain until this corner's queue is genuinely empty.
   * Every caller attaches the post-chain check, closing the small promise
   * finalization window where a new transition can see an existing chain just
   * after its drain returned. The old unconditional `finally` queue deletion
   * could erase that transition before any publisher claimed it. */
  private ensureDrain(cornerId: string): Promise<void> {
    const existing = this.chains.get(cornerId);
    if (existing) {
      return existing.then(() =>
        !this.stopped && this.queues.has(cornerId) ? this.ensureDrain(cornerId) : undefined,
      );
    }
    let chain!: Promise<void>;
    chain = this.drain(cornerId).finally(() => {
      if (this.chains.get(cornerId) === chain) this.chains.delete(cornerId);
    });
    this.chains.set(cornerId, chain);
    return chain.then(() =>
      !this.stopped && this.queues.has(cornerId) ? this.ensureDrain(cornerId) : undefined,
    );
  }

  private async drain(cornerId: string): Promise<void> {
    for (
      let target = this.queues.get(cornerId)?.[0];
      target;
      target = this.queues.get(cornerId)?.[0]
    ) {
      // Claim the queued value before awaiting the relay. A transition that
      // arrives while this publish is in flight installs a new value for the
      // next iteration; leaving the claimed value in the map would publish it
      // forever and keep daemon shutdown hanging.
      this.queues.delete(cornerId);
      await this.publishWithRetry(target);
    }
  }

  private async publishWithRetry(target: CornerStatePublish): Promise<void> {
    const cornerId = target.cornerId;
    for (let attempt = 1; ; attempt += 1) {
      if (this.stopped) return;
      const lastRef = this.lastCreatedAt.get(cornerId) ?? { value: 0 };
      const event = signCornerStateRecord(
        target.parentRoomId,
        cornerId,
        this.owner,
        target.state,
        target.reason,
        nextMonotonicSecond(lastRef),
      );
      this.lastCreatedAt.set(cornerId, lastRef);
      try {
        await publishEvent(event, this.owner);
        return;
      } catch (error) {
        const lastAttempt = attempt >= AGENT_PRESENCE_RETRY_MAX_ATTEMPTS;
        if (lastAttempt || this.stopped) {
          console.error(
            `[body] corner state ${target.state} publish failed after ${attempt} attempts for ${cornerId}:`,
            error,
          );
          return;
        }
        const delayMs = agentPresenceRetryDelayMs(attempt, error);
        for (let remaining = delayMs; remaining > 0 && !this.stopped; remaining -= 250) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
        }
      }
    }
  }
}

/**
 * Bounded, typed delegation dispatcher.
 *
 * It accepts only signed `buzz-delegation-turn` events. Ordinary agent chat is
 * never converted into a target model call. All current facts are re-read at
 * admission, an inbox claim linearizes concurrent WS/HTTP delivery, and a
 * failed model invocation becomes a terminal receipt with no automatic retry.
 */
import type { NostrEvent } from '@beeline/nostr';
import {
  admitDelegationTurn,
  buildDelegationReceipt,
  buildDelegationTurn,
  parseDelegationTurn,
  type DelegationAdmissionReason,
  type DelegationReceiptV1,
  type DelegationTurnV1,
  type Identity,
  type ParsedDelegationReceipt,
  type ParsedDelegationTurn,
} from '@beeline/buzz-client';

export interface DelegationDailyUsage {
  calls: number;
  reservedTokens: number;
}

export interface DelegationDailyLimit {
  maxCalls: number;
  maxReservedTokens: number;
}

export interface DelegationRuntimeReader {
  isRegisteredAgent(pubkey: string): Promise<boolean>;
  isRoomMember(roomId: string, pubkey: string): Promise<boolean>;
  isWorkspaceMember(workspaceId: string, pubkey: string): Promise<boolean>;
  accessPermitted(senderAgentPubkey: string, principalPubkey: string): Promise<boolean>;
  targetOnline(roomId: string, agentPubkey: string): Promise<boolean>;
  targetSupportsDelegationV1(roomId: string, agentPubkey: string): Promise<boolean>;
  graph(delegationId: string): Promise<{
    turns: readonly ParsedDelegationTurn[];
    receipts: readonly ParsedDelegationReceipt[];
  }>;
  delegatedUsage(agentPubkey: string, at: number): Promise<DelegationDailyUsage>;
}

export interface DelegationRuntimeDependencies {
  identity: Identity;
  reader: DelegationRuntimeReader;
  publish(event: NostrEvent): Promise<void>;
  /** Atomic, durable inbox claim by immutable turn event id. */
  claimInbound(eventId: string): Promise<'claimed' | 'duplicate'>;
  /** Persist the signed outbox event and its root-budget reservation atomically. */
  reserveOutbound(event: NostrEvent): Promise<'claimed' | 'duplicate'>;
  dailyLimit: DelegationDailyLimit;
  now?: () => number;
}

export type DelegationDispatchOutcome =
  | { status: 'ignored' }
  | { status: 'deferred'; reason: 'authority-unavailable' }
  | { status: 'duplicate' }
  | { status: 'refused'; reason: DelegationAdmissionReason; receipt: NostrEvent }
  | { status: 'complete' | 'failed'; receipt: NostrEvent };

function boundedReason(value: unknown): string {
  const text = String(value instanceof Error ? value.message : value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return (text || 'model-invocation-failed').slice(0, 600);
}

const BUDGET_REASONS = new Set<DelegationAdmissionReason>([
  'expired',
  'over-depth',
  'over-turn-budget',
  'over-child-budget',
  'over-token-budget',
  'escalation-required',
]);

export class DelegationRuntime {
  private readonly inFlight = new Set<string>();

  constructor(private readonly dependencies: DelegationRuntimeDependencies) {}

  /**
   * Durable sender path. Callers must construct the typed value from the
   * strict directive parser or a native structured tool, never free prose.
   */
  async publishTurn(value: DelegationTurnV1): Promise<{ event: NostrEvent; duplicate: boolean }> {
    const turn = buildDelegationTurn(this.dependencies.identity, value);
    if ((await this.dependencies.reserveOutbound(turn)) === 'duplicate') {
      return { event: turn, duplicate: true };
    }
    await this.dependencies.publish(turn);
    await this.dependencies.publish(
      buildDelegationReceipt(this.dependencies.identity, value.roomId, {
        version: 1,
        delegationId: value.delegationId,
        workItemId: value.workItemId,
        turnEventId: turn.id,
        status: 'queued',
        at: this.dependencies.now?.() ?? Math.floor(Date.now() / 1000),
      }),
    );
    return { event: turn, duplicate: false };
  }

  async handleEvent(
    event: NostrEvent,
    invokeRealRoomTurn: (turn: ParsedDelegationTurn) => Promise<void>,
  ): Promise<DelegationDispatchOutcome> {
    const turn = parseDelegationTurn(event);
    // Room subscriptions see ordinary agent messages and delegation for other
    // recipients. Neither is an invocation for this Body.
    if (!turn || turn.value.toAgentPubkey !== this.dependencies.identity.publicKey) {
      return { status: 'ignored' };
    }
    if (this.inFlight.has(event.id)) return { status: 'duplicate' };
    this.inFlight.add(event.id);
    try {
      const now = this.dependencies.now?.() ?? Math.floor(Date.now() / 1000);
      let graph: Awaited<ReturnType<DelegationRuntimeReader['graph']>>;
      let facts: {
        senderIsRegisteredAgent: boolean;
        senderRoomMember: boolean;
        senderWorkspaceMember: boolean;
        recipientRoomMember: boolean;
        recipientWorkspaceMember: boolean;
        principalWorkspaceMember: boolean;
        accessPermitted: boolean;
        targetOnline: boolean;
        targetSupportsDelegationV1: boolean;
      };
      let usage: DelegationDailyUsage;
      try {
        [graph, usage] = await Promise.all([
          this.dependencies.reader.graph(turn.value.delegationId),
          this.dependencies.reader.delegatedUsage(this.dependencies.identity.publicKey, now),
        ]);
        const [
          senderIsRegisteredAgent,
          senderRoomMember,
          senderWorkspaceMember,
          recipientRoomMember,
          recipientWorkspaceMember,
          principalWorkspaceMember,
          accessPermitted,
          targetOnline,
          targetSupportsDelegationV1,
        ] = await Promise.all([
          this.dependencies.reader.isRegisteredAgent(turn.value.fromAgentPubkey),
          this.dependencies.reader.isRoomMember(turn.value.roomId, turn.value.fromAgentPubkey),
          this.dependencies.reader.isWorkspaceMember(
            turn.value.workspaceId,
            turn.value.fromAgentPubkey,
          ),
          this.dependencies.reader.isRoomMember(
            turn.value.roomId,
            this.dependencies.identity.publicKey,
          ),
          this.dependencies.reader.isWorkspaceMember(
            turn.value.workspaceId,
            this.dependencies.identity.publicKey,
          ),
          this.dependencies.reader.isWorkspaceMember(
            turn.value.workspaceId,
            turn.value.principalPubkey,
          ),
          this.dependencies.reader.accessPermitted(
            turn.value.fromAgentPubkey,
            turn.value.principalPubkey,
          ),
          this.dependencies.reader.targetOnline(
            turn.value.roomId,
            this.dependencies.identity.publicKey,
          ),
          this.dependencies.reader.targetSupportsDelegationV1(
            turn.value.roomId,
            this.dependencies.identity.publicKey,
          ),
        ]);
        facts = {
          senderIsRegisteredAgent,
          senderRoomMember,
          senderWorkspaceMember,
          recipientRoomMember,
          recipientWorkspaceMember,
          principalWorkspaceMember,
          accessPermitted,
          targetOnline,
          targetSupportsDelegationV1,
        };
      } catch {
        return { status: 'deferred', reason: 'authority-unavailable' };
      }

      // The relay query can contain the just-delivered turn. Admission history
      // represents prior graph state; the inbox claim handles this event.
      const history = graph.turns.filter((candidate) => candidate.event.id !== event.id);
      const admission = admitDelegationTurn({
        turn,
        history,
        receipts: graph.receipts,
        now,
        expectedRecipientPubkey: this.dependencies.identity.publicKey,
        ...facts,
      });
      const dailyCallExhausted = usage.calls + 1 > this.dependencies.dailyLimit.maxCalls;
      const dailyTokensExhausted =
        usage.reservedTokens + turn.value.budget.reservedTokens >
        this.dependencies.dailyLimit.maxReservedTokens;
      if ((await this.dependencies.claimInbound(event.id)) === 'duplicate') {
        return { status: 'duplicate' };
      }
      if (!admission.admitted || dailyCallExhausted || dailyTokensExhausted) {
        const reason = admission.admitted
          ? dailyCallExhausted
            ? 'over-turn-budget'
            : 'over-token-budget'
          : admission.reason;
        const receipt = await this.publishReceipt(
          turn,
          BUDGET_REASONS.has(reason) ? 'budget-exhausted' : 'refused',
          reason,
        );
        return { status: 'refused', reason, receipt };
      }

      // Receipt before cold harness activation is the user-visible turn
      // acceptance boundary, matching ordinary Room turns.
      await this.publishReceipt(turn, 'working');
      try {
        await invokeRealRoomTurn(turn);
        const receipt = await this.publishReceipt(turn, 'complete');
        return { status: 'complete', receipt };
      } catch (error) {
        const receipt = await this.publishReceipt(turn, 'failed', boundedReason(error));
        return { status: 'failed', receipt };
      }
    } finally {
      this.inFlight.delete(event.id);
    }
  }

  private async publishReceipt(
    turn: ParsedDelegationTurn,
    status: DelegationReceiptV1['status'],
    reason?: string,
  ): Promise<NostrEvent> {
    const receipt = buildDelegationReceipt(
      this.dependencies.identity,
      turn.value.roomId,
      {
        version: 1,
        delegationId: turn.value.delegationId,
        workItemId: turn.value.workItemId,
        turnEventId: turn.event.id,
        status,
        at: this.dependencies.now?.() ?? Math.floor(Date.now() / 1000),
        ...(reason ? { reason } : {}),
      },
    );
    await this.dependencies.publish(receipt);
    return receipt;
  }
}

/**
 * Bounded, typed delegation dispatcher.
 *
 * It accepts only signed `buzz-delegation-turn` events. Ordinary agent chat is
 * never converted into a target model call. All current facts are re-read at
 * admission, an inbox claim linearizes concurrent WS/HTTP delivery, and a
 * failed model invocation becomes a terminal receipt with no automatic retry.
 */
import type { NostrEvent } from '@beeline/nostr';
import { createHash } from 'node:crypto';
import {
  admitDelegationTurn,
  buildDelegationReceipt,
  buildDelegationTurn,
  buildPermissionRequest,
  defaultDelegationBudget,
  parseDelegationDirectives,
  parseDelegationTurn,
  type DelegationAdmissionReason,
  type DelegationReceiptV1,
  type DelegationTurnV1,
  type Identity,
  type ParsedDelegationReceipt,
  type ParsedDelegationTurn,
  type PermissionRequestV1,
} from '@beeline/buzz-client';
import { parseRoomCreatePermissionDirective } from './permission-runtime.js';

export interface RootFactoryRosterEntry {
  handle: string;
  pubkey: string;
  kind: 'agent' | 'human';
  role?: string;
}

export interface RootFactoryDirectiveDependencies {
  identity: Identity;
  publishTurn(value: DelegationTurnV1): Promise<unknown>;
  publishPermission(event: NostrEvent): Promise<unknown>;
  targetReady(roomId: string, agentPubkey: string): Promise<boolean>;
}

function factoryUuid(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Sole model-prose bridge for factory authority. Every output is a signed,
 * deterministic typed event; everything outside the narrow parser is inert.
 */
export async function dispatchRootFactoryDirectives(
  dependencies: RootFactoryDirectiveDependencies,
  input: {
    roomId: string;
    workspaceId: string;
    principalPubkey: string;
    rootEventId: string;
    immediateTurnEventId: string;
    completedAt: number;
    finalText: string;
    roster: readonly RootFactoryRosterEntry[];
  },
): Promise<{ delegations: number; permissions: number; errors: number }> {
  const parsed = parseDelegationDirectives(
    input.finalText,
    input.roster.flatMap((entry) =>
      entry.kind === 'agent' ? [{ handle: entry.handle, pubkey: entry.pubkey }] : [],
    ),
  );
  const delegates = parsed.directives.flatMap((directive, index) =>
    directive.kind === 'delegate' ? [{ directive, index }] : [],
  );
  const availableTurns = Math.max(0, defaultDelegationBudget(input.completedAt).maxAgentTurns - 1);
  const delegateCount = Math.min(delegates.length, availableTurns);
  const baseTurns = delegateCount ? Math.floor(availableTurns / delegateCount) : 0;
  let extraTurns = delegateCount ? availableTurns % delegateCount : 0;
  let delegationCount = 0;
  for (const { directive, index } of delegates.slice(0, delegateCount)) {
    if (
      directive.targetPubkey === dependencies.identity.publicKey ||
      !(await dependencies.targetReady(input.roomId, directive.targetPubkey))
    ) {
      continue;
    }
    const budget = defaultDelegationBudget(input.completedAt);
    budget.maxAgentTurns = baseTurns + (extraTurns-- > 0 ? 1 : 0);
    await dependencies.publishTurn({
      version: 1,
      delegationId: factoryUuid(`${input.immediateTurnEventId}:delegation:${index}`),
      workItemId: factoryUuid(`${input.immediateTurnEventId}:work-item:${index}`),
      phase: 'assign',
      roomId: input.roomId,
      workspaceId: input.workspaceId,
      fromAgentPubkey: dependencies.identity.publicKey,
      toAgentPubkey: directive.targetPubkey,
      rootEventId: input.rootEventId,
      parentEventId: input.immediateTurnEventId,
      principalPubkey: input.principalPubkey,
      path: [dependencies.identity.publicKey],
      depth: 1,
      budget,
      task: directive.task,
      createdAt: input.completedAt,
    });
    delegationCount++;
  }

  let permissionCount = 0;
  for (const [index, directive] of parsed.directives.entries()) {
    if (directive.kind !== 'permission') continue;
    const scope = parseRoomCreatePermissionDirective({
      task: directive.task,
      workspaceId: input.workspaceId,
      reservedRoomId: factoryUuid(`${input.immediateTurnEventId}:room:${index}`),
      principalPubkey: input.principalPubkey,
      roster: input.roster,
    });
    if (!scope) continue;
    const eligibleHumans = input.roster.flatMap((entry) => {
      if (entry.kind !== 'human') return [];
      const eligible =
        directive.audience === 'owner'
          ? entry.role === 'owner'
          : entry.role === 'owner' || entry.role === 'admin';
      return eligible ? [entry.pubkey] : [];
    });
    if (eligibleHumans.length === 0) continue;
    const value: PermissionRequestV1 = {
      version: 1,
      permissionId: factoryUuid(`${input.immediateTurnEventId}:permission:${index}`),
      roomId: input.roomId,
      workspaceId: input.workspaceId,
      requesterAgentPubkey: dependencies.identity.publicKey,
      audience: directive.audience,
      summary: directive.task.slice(0, 600),
      scope,
      provenance: {
        immediateTurnEventId: input.immediateTurnEventId,
        rootEventId: input.rootEventId,
      },
      requestedAt: input.completedAt,
      requestExpiresAt: input.completedAt + 30 * 60,
    };
    await dependencies.publishPermission(
      buildPermissionRequest(dependencies.identity, value, eligibleHumans),
    );
    permissionCount++;
  }
  return {
    delegations: delegationCount,
    permissions: permissionCount,
    errors: parsed.errors.length,
  };
}

/** Exact structural boundary excess → one typed admin request, never a click per child. */
export function buildDelegationEscalationPermission(input: {
  identity: Identity;
  turn: ParsedDelegationTurn;
  immediateTurnEventId: string;
  requestedAt: number;
  extraTurns: number;
  extraReservedTokens: number;
  permittedAgentPubkeys: string[];
  eligibleHumanPubkeys: string[];
}): NostrEvent {
  if (!Number.isSafeInteger(input.extraTurns) || input.extraTurns < 1) {
    throw new Error('delegation escalation requires positive extra turns');
  }
  const permissionId = factoryUuid(
    `${input.immediateTurnEventId}:delegation-escalation:${input.turn.value.delegationId}`,
  );
  return buildPermissionRequest(
    input.identity,
    {
      version: 1,
      permissionId,
      roomId: input.turn.value.roomId,
      workspaceId: input.turn.value.workspaceId,
      requesterAgentPubkey: input.identity.publicKey,
      audience: 'admin',
      summary: `Extend delegation ${input.turn.value.delegationId} by ${input.extraTurns} bounded turn(s).`,
      scope: {
        type: 'delegation.escalate',
        delegationId: input.turn.value.delegationId,
        extraTurns: input.extraTurns,
        extraReservedTokens: input.extraReservedTokens,
        permittedAgentPubkeys: [...new Set(input.permittedAgentPubkeys)],
      },
      provenance: {
        immediateTurnEventId: input.immediateTurnEventId,
        rootEventId: input.turn.value.rootEventId,
        delegationId: input.turn.value.delegationId,
      },
      requestedAt: input.requestedAt,
      requestExpiresAt: input.requestedAt + 30 * 60,
    },
    input.eligibleHumanPubkeys,
  );
}

export interface DelegationDailyUsage {
  calls: number;
  reservedTokens: number;
  turnEventIds: readonly string[];
}

export interface DelegationDailyLimit {
  maxCalls: number;
  maxReservedTokens: number;
}

export interface DelegationCapacityReservation {
  eventId: string;
  delegationId: string;
  agentPubkey: string;
  day: string;
  phase: DelegationTurnV1['phase'];
  parentWorkItemId?: string;
  reservedTokens: number;
  allocatedTurns: number;
  observedTurnEventIds: readonly string[];
  observedRootTurns: number;
  rootMaxAgentTurns: number;
  observedDailyCalls: number;
  observedDailyReservedTokens: number;
  observedDailyTurnEventIds: readonly string[];
  dailyMaxCalls: number;
  dailyMaxReservedTokens: number;
  observedSiblingCount: number;
  observedSiblingAllocatedTurns: number;
  observedSiblingAllocatedTokens: number;
  parentMaxChildren?: number;
  parentAvailableTurns?: number;
  parentAvailableTokens?: number;
}

export type DelegationCapacityResult =
  'claimed' | 'duplicate' | 'over-turn-budget' | 'over-child-budget' | 'over-token-budget';

export interface DelegationOutboundReservation {
  state: 'reserved' | 'pending' | 'delivered';
  event: NostrEvent;
}

export interface DelegationRuntimeReader {
  isRegisteredAgent(pubkey: string): Promise<boolean>;
  isRoomMember(roomId: string, pubkey: string): Promise<boolean>;
  isWorkspaceMember(workspaceId: string, pubkey: string): Promise<boolean>;
  accessPermitted(
    workspaceId: string,
    senderAgentPubkey: string,
    principalPubkey: string,
  ): Promise<boolean>;
  targetOnline(roomId: string, agentPubkey: string): Promise<boolean>;
  targetSupportsDelegationV1(roomId: string, agentPubkey: string): Promise<boolean>;
  rootAuthorized(turn: ParsedDelegationTurn): Promise<boolean>;
  escalationAuthorized(turn: ParsedDelegationTurn): Promise<boolean>;
  /** Consume the root escalation action; throw only for retryable authority failure. */
  consumeEscalation(turn: ParsedDelegationTurn): Promise<boolean>;
  graph(
    delegationId: string,
    roomId: string,
  ): Promise<{
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
  /** Atomically claim an admitted turn and reserve shared root/day capacity. */
  reserveInboundCapacity(input: DelegationCapacityReservation): Promise<DelegationCapacityResult>;
  /** Persist the exact signed outbox event before publication. */
  reserveOutbound(event: NostrEvent): Promise<DelegationOutboundReservation>;
  markOutboundDelivered(eventId: string): Promise<void>;
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
    const reservation = await this.dependencies.reserveOutbound(turn);
    if (reservation.state === 'delivered') {
      return { event: reservation.event, duplicate: true };
    }
    await this.dependencies.publish(reservation.event);
    await this.dependencies.markOutboundDelivered(reservation.event.id);
    await this.dependencies.publish(
      buildDelegationReceipt(this.dependencies.identity, value.roomId, {
        version: 1,
        delegationId: value.delegationId,
        workItemId: value.workItemId,
        turnEventId: reservation.event.id,
        status: 'queued',
        at: this.dependencies.now?.() ?? Math.floor(Date.now() / 1000),
      }),
    );
    return { event: reservation.event, duplicate: reservation.state === 'pending' };
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
        principalRoomMember: boolean;
        principalWorkspaceMember: boolean;
        rootAuthorized: boolean;
        escalationAuthorized: boolean;
        accessPermitted: boolean;
        targetOnline: boolean;
        targetSupportsDelegationV1: boolean;
      };
      let usage: DelegationDailyUsage;
      try {
        [graph, usage] = await Promise.all([
          this.dependencies.reader.graph(turn.value.delegationId, turn.value.roomId),
          this.dependencies.reader.delegatedUsage(this.dependencies.identity.publicKey, now),
        ]);
        const [
          senderIsRegisteredAgent,
          senderRoomMember,
          senderWorkspaceMember,
          recipientRoomMember,
          recipientWorkspaceMember,
          principalRoomMember,
          principalWorkspaceMember,
          rootAuthorized,
          escalationAuthorized,
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
          this.dependencies.reader.isRoomMember(turn.value.roomId, turn.value.principalPubkey),
          this.dependencies.reader.isWorkspaceMember(
            turn.value.workspaceId,
            turn.value.principalPubkey,
          ),
          this.dependencies.reader.rootAuthorized(turn),
          this.dependencies.reader.escalationAuthorized(turn),
          turn.value.phase === 'return' && turn.value.mission
            ? Promise.resolve(true)
            : this.dependencies.reader.accessPermitted(
                turn.value.workspaceId,
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
          principalRoomMember,
          principalWorkspaceMember,
          rootAuthorized,
          escalationAuthorized,
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
      if (!admission.admitted || dailyCallExhausted || dailyTokensExhausted) {
        if ((await this.dependencies.claimInbound(event.id)) === 'duplicate') {
          return { status: 'duplicate' };
        }
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
      if (turn.value.escalationGrantEventId) {
        let consumed: boolean;
        try {
          consumed = await this.dependencies.reader.consumeEscalation(turn);
        } catch {
          return { status: 'deferred', reason: 'authority-unavailable' };
        }
        if (!consumed) {
          if ((await this.dependencies.claimInbound(event.id)) === 'duplicate') {
            return { status: 'duplicate' };
          }
          const receipt = await this.publishReceipt(
            turn,
            'budget-exhausted',
            'escalation-required',
          );
          return { status: 'refused', reason: 'escalation-required', receipt };
        }
      }
      const rootTurns = history.filter(
        (candidate) => candidate.value.delegationId === turn.value.delegationId,
      );
      const parent = turn.value.parentWorkItemId
        ? rootTurns.find(
            (candidate) =>
              candidate.value.phase === 'assign' &&
              candidate.value.workItemId === turn.value.parentWorkItemId &&
              candidate.value.toAgentPubkey === turn.value.fromAgentPubkey,
          )
        : undefined;
      const siblings = turn.value.parentWorkItemId
        ? rootTurns.filter(
            (candidate) =>
              candidate.value.phase === 'assign' &&
              candidate.value.parentWorkItemId === turn.value.parentWorkItemId,
          )
        : [];
      const capacity = await this.dependencies.reserveInboundCapacity({
        eventId: event.id,
        delegationId: turn.value.delegationId,
        agentPubkey: this.dependencies.identity.publicKey,
        day: new Date(now * 1_000).toISOString().slice(0, 10),
        phase: turn.value.phase,
        ...(turn.value.parentWorkItemId ? { parentWorkItemId: turn.value.parentWorkItemId } : {}),
        reservedTokens: turn.value.budget.reservedTokens,
        allocatedTurns: turn.value.budget.maxAgentTurns,
        observedTurnEventIds: rootTurns.map((candidate) => candidate.event.id),
        observedRootTurns: rootTurns.length,
        rootMaxAgentTurns: admission.rootBudget.maxAgentTurns,
        observedDailyCalls: usage.calls,
        observedDailyReservedTokens: usage.reservedTokens,
        observedDailyTurnEventIds: usage.turnEventIds,
        dailyMaxCalls: this.dependencies.dailyLimit.maxCalls,
        dailyMaxReservedTokens: this.dependencies.dailyLimit.maxReservedTokens,
        observedSiblingCount: siblings.length,
        observedSiblingAllocatedTurns: siblings.reduce(
          (sum, sibling) => sum + sibling.value.budget.maxAgentTurns,
          0,
        ),
        observedSiblingAllocatedTokens: siblings.reduce(
          (sum, sibling) => sum + sibling.value.budget.reservedTokens,
          0,
        ),
        ...(parent
          ? {
              parentMaxChildren: parent.value.budget.maxChildren,
              parentAvailableTurns: Math.max(0, parent.value.budget.maxAgentTurns - 1),
              parentAvailableTokens: parent.value.budget.reservedTokens,
            }
          : {}),
      });
      if (capacity === 'duplicate') return { status: 'duplicate' };
      if (capacity !== 'claimed') {
        const receipt = await this.publishReceipt(turn, 'budget-exhausted', capacity);
        return { status: 'refused', reason: capacity, receipt };
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
    const receipt = buildDelegationReceipt(this.dependencies.identity, turn.value.roomId, {
      version: 1,
      delegationId: turn.value.delegationId,
      workItemId: turn.value.workItemId,
      turnEventId: turn.event.id,
      status,
      at: this.dependencies.now?.() ?? Math.floor(Date.now() / 1000),
      ...(reason ? { reason } : {}),
    });
    await this.dependencies.publish(receipt);
    return receipt;
  }
}

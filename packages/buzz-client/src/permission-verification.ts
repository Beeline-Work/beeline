/** Fresh-authority execution verification for permission actions. */
import type { NostrEvent } from '@beeline/nostr';
import {
  HEX_64,
  PERMISSION_SCOPE_REGISTRY,
  type ParsedPermissionDecision,
  type ParsedPermissionRequest,
  type PermissionExecutor,
  type PermissionRole,
  type PermissionScope,
} from './permission-scope.js';
import {
  parsePermissionDecision,
  parsePermissionExecution,
  parsePermissionRequest,
  parsePermissionRevocation,
} from './permission-events.js';
import {
  compareEvents,
  permissionActionId,
  permissionScopeAllows,
  summarizePermissionUsage,
  type PermissionUsage,
} from './permission-ledger.js';

export interface PermissionConcreteAction {
  permissionId: string;
  requestEventId: string;
  grantEventId: string;
  ordinal: number;
  actionId: string;
  idempotencyKey: string;
  workspaceId: string;
  roomId: string;
  scope: PermissionScope;
  executor: PermissionExecutor;
  /** Exact signing identity whose receipts consume this envelope. */
  executorPubkey: string;
  charge: {
    uses: number;
    minorUnits?: number;
    currency?: string;
    reservedTokens?: number;
  };
}

export type PermissionFreshReader = {
  /** Immutable event lookup may cache only after signature verification. */
  readEvent(eventId: string): Promise<NostrEvent | undefined>;
  /** The following authority and usage methods MUST perform current reads. */
  isRegisteredAgent(pubkey: string): Promise<boolean>;
  isRoomMember(roomId: string, pubkey: string): Promise<boolean>;
  isWorkspaceMember(workspaceId: string, pubkey: string): Promise<boolean>;
  roleForRoom(roomId: string, pubkey: string): Promise<'owner' | 'admin' | 'member' | null>;
  hasDeviceCustody(pubkey: string): Promise<boolean>;
  permissionHistory(roomId: string, permissionId: string): Promise<readonly NostrEvent[]>;
  /** Direct grant-indexed revocation read; mission stop checks must not depend on a capped mixed history. */
  permissionRevocations?(
    roomId: string,
    permissionId: string,
    grantEventId: string,
  ): Promise<readonly NostrEvent[]>;
};

export type PermissionVerificationResult =
  | {
      authorized: true;
      request: ParsedPermissionRequest;
      decision: ParsedPermissionDecision;
      usage: PermissionUsage;
    }
  | {
      authorized: false;
      terminal: boolean;
      reason:
        | 'authority-unavailable'
        | 'request-invalid'
        | 'requester-not-agent'
        | 'requester-not-current-member'
        | 'decision-invalid'
        | 'decision-not-winning'
        | 'signer-is-agent'
        | 'signer-not-device-held'
        | 'signer-not-current-admin'
        | 'executor-mismatch'
        | 'not-yet-valid'
        | 'expired'
        | 'denied'
        | 'revoked'
        | 'exhausted'
        | 'rate-exhausted'
        | 'budget-exhausted'
        | 'action-already-succeeded'
        | 'action-outcome-unknown'
        | 'action-mismatch';
    };

function roleSatisfies(
  role: 'owner' | 'admin' | 'member' | null,
  minimum: PermissionRole,
): boolean {
  return role === 'owner' || (minimum === 'admin' && role === 'admin');
}

type CurrentHumanAuthority =
  | { authorized: true }
  | {
      authorized: false;
      reason: 'signer-is-agent' | 'signer-not-device-held' | 'signer-not-current-admin';
    };

async function currentHumanAuthorized(
  reader: PermissionFreshReader,
  request: ParsedPermissionRequest,
  event: { event: NostrEvent },
  minimum: PermissionRole,
): Promise<CurrentHumanAuthority> {
  if (await reader.isRegisteredAgent(event.event.pubkey)) {
    return { authorized: false, reason: 'signer-is-agent' };
  }
  if (!(await reader.hasDeviceCustody(event.event.pubkey))) {
    return { authorized: false, reason: 'signer-not-device-held' };
  }
  if (
    !(await reader.isRoomMember(request.value.roomId, event.event.pubkey)) ||
    !(await reader.isWorkspaceMember(request.value.workspaceId, event.event.pubkey)) ||
    !roleSatisfies(await reader.roleForRoom(request.value.roomId, event.event.pubkey), minimum)
  ) {
    return { authorized: false, reason: 'signer-not-current-admin' };
  }
  return { authorized: true };
}

/**
 * Full fail-closed execution preflight. The reader names current-state methods
 * explicitly so callers cannot accidentally pass a transcript/cache snapshot.
 */
type PermissionActionVerificationInput = {
  reader: PermissionFreshReader;
  action: PermissionConcreteAction;
  now: number;
};

async function verifyPermissionActionInternal(
  input: PermissionActionVerificationInput,
  authorityOnly: boolean,
): Promise<PermissionVerificationResult> {
  try {
    const requestEvent = await input.reader.readEvent(input.action.requestEventId);
    const request = requestEvent ? parsePermissionRequest(requestEvent) : undefined;
    if (
      !request ||
      request.value.permissionId !== input.action.permissionId ||
      request.value.workspaceId !== input.action.workspaceId ||
      request.value.roomId !== input.action.roomId
    ) {
      return { authorized: false, terminal: true, reason: 'request-invalid' };
    }
    if (!(await input.reader.isRegisteredAgent(request.event.pubkey))) {
      return { authorized: false, terminal: true, reason: 'requester-not-agent' };
    }
    if (
      !(await input.reader.isRoomMember(request.value.roomId, request.event.pubkey)) ||
      !(await input.reader.isWorkspaceMember(request.value.workspaceId, request.event.pubkey))
    ) {
      return { authorized: false, terminal: true, reason: 'requester-not-current-member' };
    }
    const decisionEvent = await input.reader.readEvent(input.action.grantEventId);
    const requestedDecision = decisionEvent
      ? parsePermissionDecision(decisionEvent, request)
      : undefined;
    if (!requestedDecision || requestedDecision.value.decision !== 'grant') {
      return { authorized: false, terminal: true, reason: 'decision-invalid' };
    }
    const policy = PERMISSION_SCOPE_REGISTRY[request.value.scope.type];
    const minimumRole: PermissionRole =
      request.value.audience === 'owner' ? 'owner' : policy.minimumRole;
    if (policy.executor !== input.action.executor) {
      return { authorized: false, terminal: true, reason: 'executor-mismatch' };
    }
    const history = await input.reader.permissionHistory(
      request.value.roomId,
      request.value.permissionId,
    );
    const decisions = history.flatMap((event) => {
      const parsed = parsePermissionDecision(event, request);
      return parsed && parsed.value.decidedAt <= input.now ? [parsed] : [];
    });
    const authorizedDecisions: ParsedPermissionDecision[] = [];
    let requestedDecisionAuthority: CurrentHumanAuthority | undefined;
    for (const decision of decisions) {
      const authority = await currentHumanAuthorized(input.reader, request, decision, minimumRole);
      if (decision.event.id === requestedDecision.event.id) requestedDecisionAuthority = authority;
      if (authority.authorized) {
        authorizedDecisions.push(decision);
      }
    }
    if (requestedDecisionAuthority && !requestedDecisionAuthority.authorized) {
      return { authorized: false, terminal: true, reason: requestedDecisionAuthority.reason };
    }
    const winner = authorizedDecisions.sort(compareEvents)[0];
    if (!winner || winner.event.id !== requestedDecision.event.id) {
      return { authorized: false, terminal: true, reason: 'decision-not-winning' };
    }
    if (winner.value.decision === 'deny') {
      return { authorized: false, terminal: true, reason: 'denied' };
    }
    const grant = winner.value.grant!;
    if (input.now < grant.notBefore)
      return { authorized: false, terminal: false, reason: 'not-yet-valid' };
    if (input.now > grant.expiresAt) {
      return { authorized: false, terminal: true, reason: 'expired' };
    }
    const directRevocations = input.reader.permissionRevocations
      ? await input.reader.permissionRevocations(
          request.value.roomId,
          request.value.permissionId,
          winner.event.id,
        )
      : [];
    const revocationEvents = [...history, ...directRevocations].filter(
      (event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index,
    );
    const revocations = revocationEvents.flatMap((event) => {
      const parsed = parsePermissionRevocation(event, request);
      return parsed && parsed.value.revokedAt <= input.now ? [parsed] : [];
    });
    for (const revocation of revocations) {
      if (
        revocation.value.grantEventId === winner.event.id &&
        (await currentHumanAuthorized(input.reader, request, revocation, minimumRole)).authorized
      ) {
        return { authorized: false, terminal: true, reason: 'revoked' };
      }
    }
    const executions = history.flatMap((event) => {
      const parsed = parsePermissionExecution(event, request);
      return parsed && parsed.value.at <= input.now ? [parsed] : [];
    });
    const usage = summarizePermissionUsage(
      executions.filter((execution) => execution.event.pubkey === input.action.executorPubkey),
      winner.event.id,
    );
    if (!authorityOnly) {
      const existing = usage.actionStatuses.get(input.action.actionId);
      if (existing === 'succeeded') {
        return { authorized: false, terminal: true, reason: 'action-already-succeeded' };
      }
      if (existing === 'unknown' || existing === 'started') {
        return { authorized: false, terminal: true, reason: 'action-outcome-unknown' };
      }
    }
    if (!permissionScopeAllows(request.value.scope, input.action.scope)) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (
      !Number.isSafeInteger(input.action.ordinal) ||
      input.action.ordinal < 0 ||
      permissionActionId(input.action.scope, request.event.id, input.action.ordinal) !==
        input.action.actionId
    ) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (!HEX_64.test(input.action.executorPubkey)) {
      return { authorized: false, terminal: true, reason: 'executor-mismatch' };
    }
    if (
      input.action.executor === 'human-device' &&
      input.action.executorPubkey !== winner.event.pubkey
    ) {
      return { authorized: false, terminal: true, reason: 'executor-mismatch' };
    }
    if (
      input.action.scope.type === 'money.spend' &&
      (input.action.charge.minorUnits !== input.action.scope.maxMinorUnits ||
        input.action.charge.currency !== input.action.scope.currency)
    ) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (
      input.action.scope.type !== 'money.spend' &&
      (input.action.charge.minorUnits !== undefined || input.action.charge.currency !== undefined)
    ) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (input.action.charge.uses < 1) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (!authorityOnly && usage.uses + input.action.charge.uses > grant.maxUses) {
      return { authorized: false, terminal: true, reason: 'exhausted' };
    }
    const windowStart = input.now - grant.rate.windowSeconds;
    const recentUses = usage.committedAt.filter((at) => at >= windowStart).length;
    if (!authorityOnly && recentUses + input.action.charge.uses > grant.rate.maxUses) {
      return { authorized: false, terminal: false, reason: 'rate-exhausted' };
    }
    if (
      !authorityOnly &&
      grant.budget.maxMinorUnits !== undefined &&
      (input.action.charge.currency !== grant.budget.currency ||
        usage.minorUnits + (input.action.charge.minorUnits ?? 0) > grant.budget.maxMinorUnits)
    ) {
      return { authorized: false, terminal: true, reason: 'budget-exhausted' };
    }
    if (
      !authorityOnly &&
      grant.budget.maxReservedTokens !== undefined &&
      usage.reservedTokens + (input.action.charge.reservedTokens ?? 0) >
        grant.budget.maxReservedTokens
    ) {
      return { authorized: false, terminal: true, reason: 'budget-exhausted' };
    }
    return { authorized: true, request, decision: winner, usage };
  } catch {
    return { authorized: false, terminal: false, reason: 'authority-unavailable' };
  }
}

export function verifyPermissionAction(
  input: PermissionActionVerificationInput,
): Promise<PermissionVerificationResult> {
  return verifyPermissionActionInternal(input, false);
}

export function verifyMissionPermissionActionAuthority(
  input: PermissionActionVerificationInput,
): Promise<PermissionVerificationResult> {
  if (input.action.scope.type !== 'mission.control') {
    return Promise.resolve({ authorized: false, terminal: true, reason: 'action-mismatch' });
  }
  return verifyPermissionActionInternal(input, true);
}

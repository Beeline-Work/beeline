/** Permission ledger fold, usage accounting, and scope attenuation. */
import type { NostrEvent } from '@beeline/nostr';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  HEX_64,
  type JsonRecord,
  type ParsedPermissionDecision,
  type ParsedPermissionExecution,
  type ParsedPermissionRequest,
  type ParsedPermissionRevocation,
  type PermissionExecutionStatus,
  type PermissionScope,
} from './permission-scope.js';

export function compareEvents(a: { event: NostrEvent }, b: { event: NostrEvent }): number {
  return a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id);
}

export type PermissionUsage = {
  uses: number;
  minorUnits: number;
  reservedTokens: number;
  committedAt: number[];
  actionStatuses: ReadonlyMap<string, PermissionExecutionStatus>;
};

export function summarizePermissionUsage(
  executions: readonly ParsedPermissionExecution[],
  grantEventId: string,
): PermissionUsage {
  const byAction = new Map<string, ParsedPermissionExecution[]>();
  for (const execution of executions) {
    if (execution.value.grantEventId !== grantEventId) continue;
    const list = byAction.get(execution.value.actionId) ?? [];
    list.push(execution);
    byAction.set(execution.value.actionId, list);
  }
  let uses = 0;
  let minorUnits = 0;
  let reservedTokens = 0;
  const committedAt: number[] = [];
  const actionStatuses = new Map<string, PermissionExecutionStatus>();
  for (const [actionId, events] of byAction) {
    events.sort(compareEvents);
    const started = events.find((event) => event.value.status === 'started');
    const terminal = [...events].reverse().find((event) => event.value.status !== 'started');
    const effective = terminal?.value.status ?? started?.value.status;
    if (!effective) continue;
    actionStatuses.set(actionId, effective);
    if (effective === 'failed') continue;
    const charge = started?.value.charge ?? terminal?.value.charge ?? { uses: 1 };
    uses += charge.uses;
    minorUnits += charge.minorUnits ?? 0;
    reservedTokens += charge.reservedTokens ?? 0;
    const committed = started?.value.at ?? terminal!.value.at;
    for (let use = 0; use < charge.uses; use += 1) committedAt.push(committed);
  }
  return { uses, minorUnits, reservedTokens, committedAt, actionStatuses };
}

export type PermissionFoldState =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'denied'; decision: ParsedPermissionDecision }
  | { status: 'granted'; decision: ParsedPermissionDecision; usage: PermissionUsage }
  | {
      status: 'revoked';
      decision: ParsedPermissionDecision;
      revocation: ParsedPermissionRevocation;
    }
  | { status: 'executing'; decision: ParsedPermissionDecision; usage: PermissionUsage }
  | { status: 'unknown'; decision: ParsedPermissionDecision; usage: PermissionUsage }
  | { status: 'consumed'; decision: ParsedPermissionDecision; usage: PermissionUsage };

export function foldPermissionLedger(input: {
  request: ParsedPermissionRequest;
  decisions: readonly ParsedPermissionDecision[];
  revocations?: readonly ParsedPermissionRevocation[];
  executions?: readonly ParsedPermissionExecution[];
  now: number;
  decisionAuthorized?: (decision: ParsedPermissionDecision) => boolean;
  revocationAuthorized?: (revocation: ParsedPermissionRevocation) => boolean;
}): PermissionFoldState {
  const decision = [...input.decisions]
    .filter(
      (candidate) =>
        candidate.value.permissionId === input.request.value.permissionId &&
        candidate.value.requestEventId === input.request.event.id &&
        candidate.value.decidedAt <= input.request.value.requestExpiresAt &&
        candidate.value.decidedAt <= input.now &&
        (input.decisionAuthorized?.(candidate) ?? true),
    )
    .sort(compareEvents)[0];
  if (!decision) {
    return input.now > input.request.value.requestExpiresAt
      ? { status: 'expired' }
      : { status: 'pending' };
  }
  if (decision.value.decision === 'deny') return { status: 'denied', decision };
  const grant = decision.value.grant!;
  if (input.now < grant.notBefore) return { status: 'pending' };
  if (input.now > grant.expiresAt) return { status: 'expired' };
  const revocation = [...(input.revocations ?? [])]
    .filter(
      (candidate) =>
        candidate.value.permissionId === input.request.value.permissionId &&
        candidate.value.grantEventId === decision.event.id &&
        candidate.value.revokedAt <= input.now &&
        (input.revocationAuthorized?.(candidate) ?? true),
    )
    .sort(compareEvents)[0];
  if (revocation) return { status: 'revoked', decision, revocation };
  const usage = summarizePermissionUsage(
    (input.executions ?? []).filter((execution) => execution.value.at <= input.now),
    decision.event.id,
  );
  if ([...usage.actionStatuses.values()].includes('unknown'))
    return { status: 'unknown', decision, usage };
  if ([...usage.actionStatuses.values()].includes('started'))
    return { status: 'executing', decision, usage };
  if (usage.uses >= grant.maxUses) return { status: 'consumed', decision, usage };
  return { status: 'granted', decision, usage };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as JsonRecord)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable action identity; callers reserve ordinals before any side effect. */
export function permissionActionId(
  scope: PermissionScope,
  requestEventId: string,
  ordinal: number,
): string {
  if (!HEX_64.test(requestEventId) || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error('invalid permission action identity');
  }
  return `pa_${bytesToHex(
    sha256(utf8ToBytes(`buzz-permission-action:v1:${requestEventId}:${ordinal}:${stable(scope)}`)),
  )}`;
}

function sameSet<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean {
  return stable([...left].map(key).sort()) === stable([...right].map(key).sort());
}

/** Whether one concrete action stays wholly inside the signed request scope. */
export function permissionScopeAllows(boundary: PermissionScope, action: PermissionScope): boolean {
  if (boundary.type !== action.type) return false;
  switch (boundary.type) {
    case 'money.spend':
      return (
        action.type === 'money.spend' &&
        boundary.currency === action.currency &&
        boundary.connectorId === action.connectorId &&
        boundary.merchant === action.merchant &&
        boundary.purpose === action.purpose &&
        action.maxMinorUnits <= boundary.maxMinorUnits
      );
    case 'message.send':
      return (
        action.type === 'message.send' &&
        boundary.channel === action.channel &&
        boundary.connectorId === action.connectorId &&
        sameSet(boundary.artifacts, action.artifacts, (value) => stable(value)) &&
        sameSet(boundary.recipients, action.recipients, (value) => stable(value))
      );
    case 'content.publish':
      return (
        action.type === 'content.publish' &&
        boundary.connectorId === action.connectorId &&
        stable(boundary.destination) === stable(action.destination) &&
        sameSet(boundary.artifacts, action.artifacts, (value) => stable(value))
      );
    case 'mission.control': {
      if (action.type !== 'mission.control') return false;
      const includes = <T>(allowed: readonly T[], requested: readonly T[]) =>
        requested.every((candidate) => allowed.includes(candidate));
      const targetsAllowed = action.targetAllocations.every((requested) => {
        const allowed = boundary.targetAllocations.find(
          (candidate) => candidate.agentPubkey === requested.agentPubkey,
        );
        return (
          allowed !== undefined &&
          requested.maxActiveCorners <= allowed.maxActiveCorners &&
          requested.maxReservedTokensPerDay <= allowed.maxReservedTokensPerDay &&
          requested.maxTotalReservedTokens <= allowed.maxTotalReservedTokens
        );
      });
      const schedulesAllowed = action.scheduleAllocations.every((requested) => {
        const allowed = boundary.scheduleAllocations.find(
          (candidate) =>
            candidate.scheduleId === requested.scheduleId &&
            candidate.targetAgentPubkey === requested.targetAgentPubkey,
        );
        return (
          allowed !== undefined &&
          includes(allowed.modes, requested.modes) &&
          requested.maxRuns <= allowed.maxRuns &&
          requested.maxReservedTokensPerRun <= allowed.maxReservedTokensPerRun &&
          requested.maxReservedTokensPerDay <= allowed.maxReservedTokensPerDay &&
          requested.maxTotalReservedTokens <= allowed.maxTotalReservedTokens &&
          requested.maxScriptRuntimeSeconds <= allowed.maxScriptRuntimeSeconds &&
          (allowed.revisionDigest === undefined ||
            allowed.revisionDigest === requested.revisionDigest)
        );
      });
      return (
        boundary.missionId === action.missionId &&
        boundary.workspaceId === action.workspaceId &&
        boundary.roomId === action.roomId &&
        boundary.controllerAgentPubkey === action.controllerAgentPubkey &&
        stable(boundary.repository) === stable(action.repository) &&
        includes(boundary.cornerOperations, action.cornerOperations) &&
        includes(boundary.scheduleOperations, action.scheduleOperations) &&
        targetsAllowed &&
        schedulesAllowed
      );
    }
    default:
      return stable(boundary) === stable(action);
  }
}

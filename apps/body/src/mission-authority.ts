/** Mission exercises attenuated through the existing signed permission ledger. */
import { createHash } from 'node:crypto';
import {
  parsePermissionDecision,
  parsePermissionRequest,
  permissionActionId,
  verifyPermissionAction,
  verifyMissionPermissionActionAuthority,
  type MissionControlScope,
  type MissionScheduleMode,
  type MissionScheduleOperation,
  type ParsedPermissionDecision,
  type ParsedPermissionRequest,
  type PermissionConcreteAction,
  type PermissionFreshReader,
  type PermissionVerificationResult,
} from '@beeline/buzz-client';

const HEX_64 = /^[0-9a-f]{64}$/;

export interface MissionGrantReference {
  missionId: string;
  grantEventId: string;
  controllerAgentPubkey: string;
}

/** Durable lineage copied onto every corner derived from a mission grant. */
export interface MissionCornerAuthority extends MissionGrantReference {
  workspaceId: string;
  roomId: string;
  principalPubkey: string;
  targetAgentPubkey: string;
  repository: { key: string; targetBranch: string };
}

export interface ResolvedMissionGrant {
  reference: MissionGrantReference;
  request: ParsedPermissionRequest;
  decision: ParsedPermissionDecision;
  scope: MissionControlScope;
}

export type MissionExercise =
  | {
      kind: 'schedule';
      operation: MissionScheduleOperation;
      scheduleId: string;
      revisionDigest: string;
      mode: MissionScheduleMode;
      targetAgentPubkey: string;
      maxRuns: number;
      perRunReservedTokens: number;
      dailyReservedTokens: number;
      totalReservedTokens: number;
      scriptRuntimeSeconds: number;
    }
  | { kind: 'corner'; operation: 'open' | 'close'; targetAgentPubkey: string }
  | { kind: 'land'; cornerId: string; sourceSha: string };

export interface MissionActionInput {
  reader: PermissionFreshReader;
  reference: MissionGrantReference;
  workspaceId: string;
  roomId: string;
  principalPubkey?: string;
  repository: { key: string; targetBranch: string };
  executorPubkey: string;
  exercise: MissionExercise;
  ordinal: number;
  idempotencyKey: string;
  reservedTokens?: number;
}

function requestEventId(grantContent: string): string | undefined {
  try {
    const parsed = JSON.parse(grantContent) as { requestEventId?: unknown };
    return typeof parsed.requestEventId === 'string' && HEX_64.test(parsed.requestEventId)
      ? parsed.requestEventId
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveMissionGrant(
  reader: PermissionFreshReader,
  reference: MissionGrantReference,
): Promise<ResolvedMissionGrant | undefined> {
  const grantEvent = await reader.readEvent(reference.grantEventId);
  const linkedRequestId = grantEvent ? requestEventId(grantEvent.content) : undefined;
  const requestEvent = linkedRequestId ? await reader.readEvent(linkedRequestId) : undefined;
  const request = requestEvent ? parsePermissionRequest(requestEvent) : undefined;
  const decision = request && grantEvent ? parsePermissionDecision(grantEvent, request) : undefined;
  const scope = request?.value.scope;
  if (
    !request ||
    !decision ||
    decision.value.decision !== 'grant' ||
    !scope ||
    scope.type !== 'mission.control' ||
    scope.missionId !== reference.missionId ||
    scope.controllerAgentPubkey !== reference.controllerAgentPubkey ||
    request.event.pubkey !== reference.controllerAgentPubkey ||
    request.value.requesterAgentPubkey !== reference.controllerAgentPubkey
  ) {
    return undefined;
  }
  return { reference, request, decision, scope };
}

function zeroControllerAllocation(boundary: MissionControlScope) {
  const controller = boundary.targetAllocations.find(
    (allocation) => allocation.agentPubkey === boundary.controllerAgentPubkey,
  );
  if (!controller) throw new Error('mission controller allocation is missing');
  return {
    agentPubkey: controller.agentPubkey,
    maxActiveCorners: 0,
    maxReservedTokensPerDay: 0,
    maxTotalReservedTokens: 0,
  };
}

export function attenuateMissionScope(
  boundary: MissionControlScope,
  exercise: MissionExercise,
): MissionControlScope {
  const common = {
    type: 'mission.control' as const,
    missionId: boundary.missionId,
    workspaceId: boundary.workspaceId,
    roomId: boundary.roomId,
    controllerAgentPubkey: boundary.controllerAgentPubkey,
    repository: boundary.repository,
  };
  if (exercise.kind === 'schedule') {
    const target = boundary.targetAllocations.find(
      (allocation) => allocation.agentPubkey === exercise.targetAgentPubkey,
    );
    if (!target) throw new Error('mission schedule target allocation is missing');
    return {
      ...common,
      cornerOperations: [],
      scheduleOperations: [exercise.operation],
      targetAllocations: [
        {
          agentPubkey: target.agentPubkey,
          maxActiveCorners: 0,
          maxReservedTokensPerDay: exercise.dailyReservedTokens,
          maxTotalReservedTokens: exercise.totalReservedTokens,
        },
      ],
      scheduleAllocations: [
        {
          scheduleId: exercise.scheduleId,
          targetAgentPubkey: exercise.targetAgentPubkey,
          modes: [exercise.mode],
          maxRuns: exercise.maxRuns,
          maxReservedTokensPerRun: exercise.perRunReservedTokens,
          maxReservedTokensPerDay: exercise.dailyReservedTokens,
          maxTotalReservedTokens: exercise.totalReservedTokens,
          maxScriptRuntimeSeconds: Math.max(1, exercise.scriptRuntimeSeconds),
          revisionDigest: exercise.revisionDigest,
        },
      ],
      land: false,
    };
  }
  if (exercise.kind === 'corner') {
    const target = boundary.targetAllocations.find(
      (allocation) => allocation.agentPubkey === exercise.targetAgentPubkey,
    );
    if (!target) throw new Error('mission corner target allocation is missing');
    return {
      ...common,
      cornerOperations: [exercise.operation],
      scheduleOperations: [],
      targetAllocations: [
        {
          agentPubkey: target.agentPubkey,
          maxActiveCorners: exercise.operation === 'open' ? 1 : 0,
          maxReservedTokensPerDay: 0,
          maxTotalReservedTokens: 0,
        },
      ],
      scheduleAllocations: [],
      land: false,
    };
  }
  return {
    ...common,
    cornerOperations: [],
    scheduleOperations: [],
    targetAllocations: [zeroControllerAllocation(boundary)],
    scheduleAllocations: [],
    land: true,
    landBinding: { cornerId: exercise.cornerId, sourceSha: exercise.sourceSha },
  };
}

/** Stable safe integer for one derived exercise; used only as ledger ordinal. */
export function missionActionOrdinal(seed: string): number {
  return Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 12), 16);
}

/**
 * Resolve a narrowed concrete action from the captain's grant. Signature,
 * revocation, current role/membership, usage, rate, and budget remain the job
 * of `verifyPermissionAction` / `PermissionRuntime.begin` at exercise time.
 */
export async function resolveMissionAction(
  input: MissionActionInput,
): Promise<PermissionConcreteAction | undefined> {
  const grant = await resolveMissionGrant(input.reader, input.reference);
  const boundary = grant?.scope;
  if (
    !grant ||
    !boundary ||
    boundary.workspaceId !== input.workspaceId ||
    boundary.roomId !== input.roomId ||
    boundary.repository.key !== input.repository.key ||
    boundary.repository.targetBranch !== input.repository.targetBranch ||
    (input.principalPubkey !== undefined && grant.decision.event.pubkey !== input.principalPubkey)
  ) {
    return undefined;
  }
  const scope = attenuateMissionScope(boundary, input.exercise);
  return {
    permissionId: grant.request.value.permissionId,
    requestEventId: grant.request.event.id,
    grantEventId: grant.decision.event.id,
    ordinal: input.ordinal,
    actionId: permissionActionId(scope, grant.request.event.id, input.ordinal),
    idempotencyKey: input.idempotencyKey,
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    scope,
    executor: 'body',
    executorPubkey: input.executorPubkey,
    charge: {
      uses: 1,
      ...(input.reservedTokens !== undefined ? { reservedTokens: input.reservedTokens } : {}),
    },
  };
}

export async function verifyMissionAction(
  input: MissionActionInput & { now: number },
): Promise<PermissionVerificationResult> {
  try {
    const action = await resolveMissionAction(input);
    if (!action) return { authorized: false, terminal: true, reason: 'action-mismatch' };
    return verifyPermissionAction({ reader: input.reader, action, now: input.now });
  } catch {
    return { authorized: false, terminal: false, reason: 'authority-unavailable' };
  }
}

export async function verifyMissionActionAuthority(
  input: MissionActionInput & { now: number },
): Promise<PermissionVerificationResult> {
  try {
    const action = await resolveMissionAction(input);
    if (!action) return { authorized: false, terminal: true, reason: 'action-mismatch' };
    return verifyMissionPermissionActionAuthority({ reader: input.reader, action, now: input.now });
  } catch {
    return { authorized: false, terminal: false, reason: 'authority-unavailable' };
  }
}

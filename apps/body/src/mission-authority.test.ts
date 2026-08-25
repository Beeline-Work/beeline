import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPermissionDecision,
  buildPermissionRequest,
  buildPermissionRevocation,
  createIdentity,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionRequest,
  type MissionControlScope,
  type PermissionFreshReader,
} from '@beeline/buzz-client';
import { resolveMissionAction, verifyMissionAction } from './mission-authority.js';

const NOW = 2_000_000_000;

function fixture() {
  const controller = createIdentity('chief-of-staff');
  const captain = createIdentity('captain');
  const target = createIdentity('target');
  const roomId = 'mission-room';
  const workspaceId = 'mission-workspace';
  const scope: MissionControlScope = {
    type: 'mission.control',
    missionId: 'mission-one',
    workspaceId,
    roomId,
    controllerAgentPubkey: controller.publicKey,
    repository: { key: 'github:123456', targetBranch: 'refs/heads/main' },
    cornerOperations: ['open', 'close'],
    scheduleOperations: ['create', 'update', 'fire'],
    targetAllocations: [
      {
        agentPubkey: controller.publicKey,
        maxActiveCorners: 1,
        maxReservedTokensPerDay: 0,
        maxTotalReservedTokens: 0,
      },
      {
        agentPubkey: target.publicKey,
        maxActiveCorners: 1,
        maxReservedTokensPerDay: 1_000,
        maxTotalReservedTokens: 5_000,
      },
    ],
    scheduleAllocations: [
      {
        scheduleId: 'summary',
        targetAgentPubkey: target.publicKey,
        modes: ['script'],
        maxRuns: 5,
        maxReservedTokensPerRun: 1_000,
        maxReservedTokensPerDay: 1_000,
        maxTotalReservedTokens: 5_000,
        maxScriptRuntimeSeconds: 60,
      },
    ],
    land: true,
  };
  const request = parsePermissionRequest(
    buildPermissionRequest(
      controller,
      {
        version: 1,
        permissionId: randomUUID(),
        roomId,
        workspaceId,
        requesterAgentPubkey: controller.publicKey,
        audience: 'owner',
        summary: 'Run the bounded mission.',
        scope,
        provenance: {
          immediateTurnEventId: '1'.repeat(64),
          rootEventId: '1'.repeat(64),
        },
        requestedAt: NOW,
        requestExpiresAt: NOW + 3_600,
      },
      [captain.publicKey],
    ),
  )!;
  const grant = defaultPermissionGrantEnvelope(scope, NOW + 1);
  grant.expiresAt = NOW + 5;
  const decision = parsePermissionDecision(
    buildPermissionDecision(captain, request, {
      version: 1,
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      decision: 'grant',
      decidedAt: NOW + 1,
      grant,
    }),
    request,
  )!;
  const events = new Map([
    [request.event.id, request.event],
    [decision.event.id, decision.event],
  ]);
  let revocations = [] as ReturnType<typeof buildPermissionRevocation>[];
  const reader: PermissionFreshReader = {
    readEvent: async (id) => events.get(id),
    isRegisteredAgent: async (pubkey) =>
      pubkey === controller.publicKey || pubkey === target.publicKey,
    isRoomMember: async () => true,
    isWorkspaceMember: async () => true,
    roleForRoom: async (_room, pubkey) => (pubkey === captain.publicKey ? 'owner' : 'member'),
    hasDeviceCustody: async (pubkey) => pubkey === captain.publicKey,
    permissionHistory: async () => [decision.event],
    permissionRevocations: async () => revocations,
  };
  const reference = {
    missionId: scope.missionId,
    grantEventId: decision.event.id,
    controllerAgentPubkey: controller.publicKey,
  };
  const input = {
    reader,
    reference,
    workspaceId,
    roomId,
    principalPubkey: captain.publicKey,
    repository: scope.repository,
    executorPubkey: controller.publicKey,
    exercise: {
      kind: 'schedule' as const,
      operation: 'fire' as const,
      scheduleId: 'summary',
      revisionDigest: 'a'.repeat(64),
      mode: 'script' as const,
      targetAgentPubkey: target.publicKey,
      maxRuns: 5,
      perRunReservedTokens: 1_000,
      dailyReservedTokens: 1_000,
      totalReservedTokens: 5_000,
      scriptRuntimeSeconds: 60,
    },
    ordinal: 1,
    idempotencyKey: 'mission-fire-one',
    reservedTokens: 1_000,
  };
  return {
    captain,
    request,
    decision,
    reader,
    input,
    revoke() {
      revocations = [
        buildPermissionRevocation(captain, request, {
          version: 1,
          permissionId: request.value.permissionId,
          grantEventId: decision.event.id,
          revokedAt: NOW + 3,
          reason: 'captain-stopped-mission',
        }),
      ];
    },
  };
}

describe('mission authority funnel', () => {
  it('authorizes an exact static allocation and self-authored revision digest', async () => {
    const fx = fixture();
    expect(await resolveMissionAction(fx.input)).toMatchObject({
      grantEventId: fx.decision.event.id,
      scope: {
        type: 'mission.control',
        scheduleAllocations: [{ revisionDigest: 'a'.repeat(64) }],
      },
      charge: { uses: 1, reservedTokens: 1_000 },
    });
    await expect(verifyMissionAction({ ...fx.input, now: NOW + 2 })).resolves.toMatchObject({
      authorized: true,
    });
  });

  it('stops every next exercise on a directly-read revocation or mid-mission expiry', async () => {
    const fx = fixture();
    fx.revoke();
    for (const exercise of [
      fx.input.exercise,
      {
        kind: 'corner' as const,
        operation: 'open' as const,
        targetAgentPubkey: fx.input.exercise.targetAgentPubkey,
      },
      {
        kind: 'corner' as const,
        operation: 'close' as const,
        targetAgentPubkey: fx.input.exercise.targetAgentPubkey,
      },
      { kind: 'land' as const },
    ]) {
      await expect(verifyMissionAction({ ...fx.input, exercise, now: NOW + 4 })).resolves.toEqual({
        authorized: false,
        terminal: true,
        reason: 'revoked',
      });
    }

    const expired = fixture();
    await expect(verifyMissionAction({ ...expired.input, now: NOW + 6 })).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'expired',
    });
  });

  it('refuses a different repository, target allocation, or schedule slice', async () => {
    const fx = fixture();
    await expect(
      resolveMissionAction({
        ...fx.input,
        repository: { key: 'github:other', targetBranch: 'refs/heads/main' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyMissionAction({
        ...fx.input,
        exercise: { ...fx.input.exercise, scheduleId: 'unallocated' },
        now: NOW + 2,
      }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'action-mismatch' });
  });
});

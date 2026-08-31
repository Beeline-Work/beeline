import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPermissionDecision,
  buildPermissionExecution,
  buildPermissionRequest,
  buildPermissionRevocation,
  createIdentity,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionRequest,
  type MissionControlScope,
  type PermissionFreshReader,
} from '@beeline/buzz-client';
import {
  resolveMissionAction,
  verifyMissionAction,
  verifyMissionActionAuthority,
} from './mission-authority.js';
import { PermissionRuntime } from './permission-runtime.js';

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
  grant.maxUses = 1;
  grant.rate.maxUses = 1;
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
  const history = [decision.event];
  const reader: PermissionFreshReader = {
    readEvent: async (id) => events.get(id),
    isRegisteredAgent: async (pubkey) =>
      pubkey === controller.publicKey || pubkey === target.publicKey,
    isRoomMember: async () => true,
    isWorkspaceMember: async () => true,
    roleForRoom: async (_room, pubkey) => (pubkey === captain.publicKey ? 'owner' : 'member'),
    hasDeviceCustody: async (pubkey) => pubkey === captain.publicKey,
    permissionHistory: async () => history,
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
    controller,
    request,
    decision,
    history,
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

  it('lets admitted work finish and refuses every post-revocation admission', async () => {
    const fx = fixture();
    const first = await resolveMissionAction(fx.input);
    const second = await resolveMissionAction({
      ...fx.input,
      ordinal: 2,
      idempotencyKey: 'mission-fire-two',
    });
    if (!first || !second) throw new Error('mission action fixture did not resolve');
    let now = NOW + 2;
    const published: unknown[] = [];
    const reservations = new Set<string>();
    const runtime = new PermissionRuntime({
      identity: fx.controller,
      reader: fx.reader,
      now: () => now,
      claim: async () => 'claimed',
      reserveCapacity: async (input) => {
        if (reservations.has(input.key)) return 'duplicate';
        reservations.add(input.key);
        return 'claimed';
      },
      publish: async (event) => {
        published.push(event);
      },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admittedInvoke = vi.fn(async () => {
      await held;
      return { result: 'finished' };
    });
    const admitted = runtime.execute({ action: first, attempt: 1, invoke: admittedInvoke });
    await vi.waitFor(() => expect(admittedInvoke).toHaveBeenCalledOnce());

    fx.revoke();
    now = NOW + 4;
    release();
    await expect(admitted).resolves.toMatchObject({ status: 'succeeded', result: 'finished' });

    const refusedInvoke = vi.fn(async () => ({ result: 'must-not-run' }));
    await expect(
      runtime.execute({ action: second, attempt: 1, invoke: refusedInvoke }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'revoked' });
    expect(refusedInvoke).not.toHaveBeenCalled();
    expect(published).toHaveLength(3);
  });

  it('fresh-checks an already-charged child without reserving the schedule slice again', async () => {
    const fx = fixture();
    const action = await resolveMissionAction(fx.input);
    if (!action) throw new Error('mission action fixture did not resolve');
    fx.history.push(
      buildPermissionExecution(fx.controller, fx.request, {
        version: 1,
        permissionId: fx.request.value.permissionId,
        grantEventId: fx.decision.event.id,
        actionId: action.actionId,
        idempotencyKey: action.idempotencyKey,
        attempt: 1,
        status: 'succeeded',
        at: NOW + 2,
        charge: action.charge,
      }),
    );
    const child = {
      ...fx.input,
      ordinal: 2,
      idempotencyKey: 'mission-child-activation',
      now: NOW + 2,
    };

    await expect(verifyMissionAction(child)).resolves.toMatchObject({
      authorized: false,
      reason: 'exhausted',
    });
    await expect(verifyMissionActionAuthority(child)).resolves.toMatchObject({
      authorized: true,
      usage: { uses: 1, reservedTokens: 1_000 },
    });

    fx.revoke();
    await expect(verifyMissionActionAuthority({ ...child, now: NOW + 4 })).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'revoked',
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

import { randomUUID } from 'node:crypto';
import { signEvent } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDelegationTurn,
  createIdentity,
  defaultDelegationBudget,
  KIND_STREAM_MESSAGE,
  parseDelegationTurn,
  parsePermissionRequest,
  type DelegationTurnV1,
} from '@beeline/buzz-client';
import {
  DelegationRuntime,
  buildDelegationEscalationPermission,
  dispatchRootFactoryDirectives,
  type DelegationRuntimeDependencies,
} from './delegation-runtime.js';

const NOW = 1_900_000_000;

function fixture(
  overrides: Partial<DelegationRuntimeDependencies['reader']> = {},
  dependencyOverrides: Partial<DelegationRuntimeDependencies> = {},
) {
  const sender = createIdentity();
  const recipient = createIdentity();
  const principal = createIdentity();
  const value: DelegationTurnV1 = {
    version: 1,
    delegationId: randomUUID(),
    workItemId: randomUUID(),
    phase: 'assign',
    roomId: randomUUID(),
    workspaceId: 'workspace-one',
    fromAgentPubkey: sender.publicKey,
    toAgentPubkey: recipient.publicKey,
    rootEventId: '1'.repeat(64),
    parentEventId: '2'.repeat(64),
    principalPubkey: principal.publicKey,
    path: [sender.publicKey],
    depth: 1,
    budget: defaultDelegationBudget(NOW, 100),
    task: 'Research ten verified candidates.',
    createdAt: NOW,
  };
  const event = buildDelegationTurn(sender, value);
  const claimed = new Set<string>();
  const published: (typeof event)[] = [];
  const reader: DelegationRuntimeDependencies['reader'] = {
    isRegisteredAgent: async (pubkey) => pubkey === sender.publicKey,
    isRoomMember: async () => true,
    isWorkspaceMember: async () => true,
    accessPermitted: async () => true,
    targetOnline: async () => true,
    targetSupportsDelegationV1: async () => true,
    rootAuthorized: async () => true,
    escalationAuthorized: async () => true,
    consumeEscalation: async () => true,
    graph: async () => ({ turns: [], receipts: [] }),
    delegatedUsage: async () => ({ calls: 0, reservedTokens: 0, turnEventIds: [] }),
    ...overrides,
  };
  const runtime = new DelegationRuntime({
    identity: recipient,
    reader,
    now: () => NOW + 1,
    dailyLimit: { maxCalls: 20, maxReservedTokens: 20_000 },
    claimInbound: async (id) => {
      if (claimed.has(id)) return 'duplicate';
      claimed.add(id);
      return 'claimed';
    },
    reserveInboundCapacity: async (input) => {
      if (claimed.has(input.eventId)) return 'duplicate';
      claimed.add(input.eventId);
      return 'claimed';
    },
    reserveOutbound: async (outbound) => ({ state: 'reserved', event: outbound }),
    markOutboundDelivered: async () => undefined,
    publish: async (receipt) => {
      published.push(receipt);
    },
    ...dependencyOverrides,
  });
  return { claimed, event, principal, published, recipient, runtime, sender, value };
}

describe('DelegationRuntime', () => {
  it('turns concurrent WS and HTTP delivery into exactly one real target turn', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => held);
    const first = f.runtime.handleEvent(f.event, invoke);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await expect(f.runtime.handleEvent(f.event, invoke)).resolves.toEqual({ status: 'duplicate' });
    release();
    await expect(first).resolves.toMatchObject({ status: 'complete' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.published.map((event) => JSON.parse(event.content).status)).toEqual([
      'working',
      'complete',
    ]);
  });

  it('wakes only the exact target daemon for a mission assignment', async () => {
    const target = fixture();
    const otherDaemon = fixture();
    const event = buildDelegationTurn(target.sender, {
      ...target.value,
      rootEventId: 'a'.repeat(64),
      mission: {
        missionId: 'mission-one',
        grantEventId: 'a'.repeat(64),
        controllerAgentPubkey: target.sender.publicKey,
        scheduleId: 'summary',
        scheduleRevision: 1,
        scheduleRevisionDigest: 'b'.repeat(64),
        scheduleRunId: 'run-one',
        mode: 'model',
        targetAgentPubkey: target.recipient.publicKey,
        maxRuns: 10,
        perRunReservedTokens: 100,
        dailyReservedTokens: 500,
        totalReservedTokens: 1_000,
        scriptRuntimeSeconds: 1,
        repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
      },
    });
    const targetTurn = vi.fn(async () => undefined);
    const wrongTurn = vi.fn(async () => undefined);

    await expect(otherDaemon.runtime.handleEvent(event, wrongTurn)).resolves.toEqual({
      status: 'ignored',
    });
    await expect(target.runtime.handleEvent(event, targetTurn)).resolves.toMatchObject({
      status: 'complete',
    });
    expect(wrongTurn).not.toHaveBeenCalled();
    expect(targetTurn).toHaveBeenCalledOnce();
  });

  it('admits a verified mission return without reverse ordinary access', async () => {
    const f = fixture();
    const mission = {
      missionId: 'mission-one',
      grantEventId: 'a'.repeat(64),
      controllerAgentPubkey: f.recipient.publicKey,
      scheduleId: 'summary',
      scheduleRevision: 1,
      scheduleRevisionDigest: 'b'.repeat(64),
      scheduleRunId: 'run-one',
      mode: 'model' as const,
      targetAgentPubkey: f.sender.publicKey,
      maxRuns: 10,
      perRunReservedTokens: 100,
      dailyReservedTokens: 500,
      totalReservedTokens: 1_000,
      scriptRuntimeSeconds: 1,
      repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
    };
    const assignmentValue: DelegationTurnV1 = {
      ...f.value,
      rootEventId: mission.grantEventId,
      fromAgentPubkey: f.recipient.publicKey,
      toAgentPubkey: f.sender.publicKey,
      path: [f.recipient.publicKey],
      mission,
    };
    const assignment = buildDelegationTurn(f.recipient, assignmentValue);
    const returned = buildDelegationTurn(f.sender, {
      ...f.value,
      rootEventId: mission.grantEventId,
      workItemId: randomUUID(),
      phase: 'return',
      parentEventId: assignment.id,
      parentWorkItemId: assignmentValue.workItemId,
      path: [f.recipient.publicKey, f.sender.publicKey],
      depth: 2,
      budget: { ...f.value.budget, maxAgentTurns: 1, maxChildren: 1, reservedTokens: 0 },
      mission,
    });
    const accessPermitted = vi.fn(async () => false);
    const reader = (Reflect.get(f.runtime, 'dependencies') as DelegationRuntimeDependencies).reader;
    reader.accessPermitted = accessPermitted;
    reader.graph = async () => ({ turns: [parseDelegationTurn(assignment)!], receipts: [] });
    const invoke = vi.fn(async () => undefined);
    await expect(f.runtime.handleEvent(returned, invoke)).resolves.toMatchObject({ status: 'complete' });
    expect(accessPermitted).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('keeps ordinary agent-authored Room messages context-only', async () => {
    const f = fixture();
    const ordinary = signEvent(
      {
        pubkey: f.sender.publicKey,
        created_at: NOW,
        kind: KIND_STREAM_MESSAGE,
        tags: [['h', f.value.roomId]],
        content: '@Scout: this prose alone is not authority',
      },
      f.sender.secretKey,
    );
    const invoke = vi.fn(async () => undefined);
    await expect(f.runtime.handleEvent(ordinary, invoke)).resolves.toEqual({ status: 'ignored' });
    expect(invoke).not.toHaveBeenCalled();
    expect(f.published).toHaveLength(0);
  });

  it('publishes one failed receipt and never auto-retries a failed model invocation', async () => {
    const f = fixture();
    const invoke = vi.fn(async () => {
      throw new Error('ACP exited');
    });
    await expect(f.runtime.handleEvent(f.event, invoke)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(f.runtime.handleEvent(f.event, invoke)).resolves.toEqual({ status: 'duplicate' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.published.map((event) => JSON.parse(event.content).status)).toEqual([
      'working',
      'failed',
    ]);
  });

  it('retries the exact pending outbound event after a transient publish failure', async () => {
    let stored: ReturnType<typeof buildDelegationTurn> | undefined;
    let delivered = false;
    let fail = true;
    const published: ReturnType<typeof buildDelegationTurn>[] = [];
    const f = fixture(
      {},
      {
        reserveOutbound: async (event) => {
          if (!stored) {
            stored = event;
            return { state: 'reserved', event };
          }
          return { state: delivered ? 'delivered' : 'pending', event: stored };
        },
        markOutboundDelivered: async () => {
          delivered = true;
        },
        publish: async (event) => {
          if (fail) {
            fail = false;
            throw new Error('relay unavailable');
          }
          published.push(event);
        },
      },
    );
    const outbound = {
      ...f.value,
      fromAgentPubkey: f.recipient.publicKey,
      toAgentPubkey: f.sender.publicKey,
      path: [f.recipient.publicKey],
    };
    await expect(f.runtime.publishTurn(outbound)).rejects.toThrow('relay unavailable');
    const retried = await f.runtime.publishTurn(outbound);
    expect(retried.event.id).toBe(stored?.id);
    expect(retried.duplicate).toBe(true);
    expect(published[0]?.id).toBe(stored?.id);
    expect(delivered).toBe(true);
  });

  it('fails closed on access, circuit-breaker, and authority boundaries', async () => {
    const denied = fixture({ accessPermitted: async () => false });
    const invoke = vi.fn(async () => undefined);
    await expect(denied.runtime.handleEvent(denied.event, invoke)).resolves.toMatchObject({
      status: 'refused',
      reason: 'access-denied',
    });

    const exhausted = fixture({
      delegatedUsage: async () => ({ calls: 20, reservedTokens: 0, turnEventIds: [] }),
    });
    await expect(exhausted.runtime.handleEvent(exhausted.event, invoke)).resolves.toMatchObject({
      status: 'refused',
      reason: 'over-turn-budget',
    });

    const unavailable = fixture({
      isWorkspaceMember: async () => {
        throw new Error('relay unavailable');
      },
    });
    await expect(unavailable.runtime.handleEvent(unavailable.event, invoke)).resolves.toEqual({
      status: 'deferred',
      reason: 'authority-unavailable',
    });
    expect(unavailable.claimed.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires and consumes a verified escalation grant before an enlarged root turn', async () => {
    const consumeEscalation = vi.fn(async () => false);
    const f = fixture({
      escalationAuthorized: async () => true,
      consumeEscalation,
    });
    const value: DelegationTurnV1 = {
      ...f.value,
      budget: { ...f.value.budget, maxAgentTurns: 9 },
      escalationGrantEventId: '3'.repeat(64),
    };
    const event = buildDelegationTurn(f.sender, value);
    const invoke = vi.fn(async () => undefined);
    await expect(f.runtime.handleEvent(event, invoke)).resolves.toMatchObject({
      status: 'refused',
      reason: 'escalation-required',
    });
    expect(consumeEscalation).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('root factory directive dispatch', () => {
  it('turns exact fan-out and Room prose into deterministic typed events under one root budget', async () => {
    const atlas = createIdentity();
    const scout = createIdentity();
    const writer = createIdentity();
    const owner = createIdentity();
    const roster = [
      { handle: 'Atlas', pubkey: atlas.publicKey, kind: 'agent' as const },
      { handle: 'Scout', pubkey: scout.publicKey, kind: 'agent' as const },
      { handle: 'Writer', pubkey: writer.publicKey, kind: 'agent' as const },
      { handle: 'Owner', pubkey: owner.publicKey, kind: 'human' as const, role: 'owner' },
    ];
    const run = async () => {
      const turns: DelegationTurnV1[] = [];
      const permissions: ReturnType<typeof parsePermissionRequest>[] = [];
      const result = await dispatchRootFactoryDirectives(
        {
          identity: atlas,
          publishTurn: async (value) => turns.push(value),
          publishPermission: async (event) => permissions.push(parsePermissionRequest(event)),
          targetReady: async () => true,
        },
        {
          roomId: 'room-one',
          workspaceId: 'workspace-one',
          principalPubkey: owner.publicKey,
          rootEventId: '1'.repeat(64),
          immediateTurnEventId: '2'.repeat(64),
          completedAt: NOW,
          finalText: [
            '@Scout: research the market',
            '@Writer: draft the brief',
            '@admin: create an outcome Room named “Launch” with @Scout and @Writer.',
          ].join('\n'),
          roster,
        },
      );
      return { turns, permissions, result };
    };
    const first = await run();
    const replay = await run();
    expect(first.result).toEqual({ delegations: 2, permissions: 1, errors: 0 });
    expect(first.turns.map((turn) => turn.budget.maxAgentTurns)).toEqual([4, 3]);
    expect(first.turns.reduce((sum, turn) => sum + turn.budget.maxAgentTurns, 0)).toBe(7);
    expect(first.permissions[0]?.value.scope).toMatchObject({
      type: 'room.create',
      name: 'Launch',
      agentPubkeys: [scout.publicKey, writer.publicKey],
    });
    expect(
      replay.turns.map(({ delegationId, workItemId }) => ({ delegationId, workItemId })),
    ).toEqual(first.turns.map(({ delegationId, workItemId }) => ({ delegationId, workItemId })));
    expect(replay.permissions[0]?.event.id).toBe(first.permissions[0]?.event.id);
  });

  it('does not publish a turn for an offline or incompatible target', async () => {
    const atlas = createIdentity();
    const scout = createIdentity();
    const publishTurn = vi.fn(async () => undefined);
    await expect(
      dispatchRootFactoryDirectives(
        {
          identity: atlas,
          publishTurn,
          publishPermission: async () => undefined,
          targetReady: async () => false,
        },
        {
          roomId: 'room-one',
          workspaceId: 'workspace-one',
          principalPubkey: 'f'.repeat(64),
          rootEventId: '1'.repeat(64),
          immediateTurnEventId: '2'.repeat(64),
          completedAt: NOW,
          finalText: '@Scout: research',
          roster: [{ handle: 'Scout', pubkey: scout.publicKey, kind: 'agent' }],
        },
      ),
    ).resolves.toMatchObject({ delegations: 0 });
    expect(publishTurn).not.toHaveBeenCalled();
  });
});

describe('delegation boundary escalation request', () => {
  it('binds the exact graph, extra budget, roster, and provenance in a typed request', () => {
    const f = fixture();
    const turn = parseDelegationTurn(f.event)!;
    const event = buildDelegationEscalationPermission({
      identity: f.recipient,
      turn,
      immediateTurnEventId: '4'.repeat(64),
      requestedAt: NOW + 2,
      extraTurns: 3,
      extraReservedTokens: 500,
      permittedAgentPubkeys: [f.sender.publicKey, f.recipient.publicKey],
      eligibleHumanPubkeys: [f.principal.publicKey],
    });
    expect(parsePermissionRequest(event)?.value).toMatchObject({
      requesterAgentPubkey: f.recipient.publicKey,
      scope: {
        type: 'delegation.escalate',
        delegationId: f.value.delegationId,
        extraTurns: 3,
        extraReservedTokens: 500,
        permittedAgentPubkeys: [f.sender.publicKey, f.recipient.publicKey],
      },
      provenance: {
        immediateTurnEventId: '4'.repeat(64),
        rootEventId: f.value.rootEventId,
        delegationId: f.value.delegationId,
      },
    });
  });
});

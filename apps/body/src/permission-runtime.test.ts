import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPermissionDecision,
  buildPermissionRequest,
  createIdentity,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionRequest,
  permissionActionId,
  type PermissionConcreteAction,
  type PermissionFreshReader,
  type PermissionRequestV1,
  type PermissionScope,
} from '@beeline/buzz-client';
import {
  PermissionKnownFailure,
  PermissionRuntime,
  parseRoomCreatePermissionDirective,
} from './permission-runtime.js';

const NOW = 1_900_000_000;

function fixture() {
  const agent = createIdentity();
  const admin = createIdentity();
  const executor = createIdentity();
  const scope: PermissionScope = {
    type: 'money.spend',
    currency: 'USD',
    maxMinorUnits: 5_000,
    merchant: 'Research API',
    purpose: 'verified company research',
    connectorId: 'research-api',
  };
  const requestValue: PermissionRequestV1 = {
    version: 1,
    permissionId: randomUUID(),
    roomId: randomUUID(),
    workspaceId: 'workspace-one',
    requesterAgentPubkey: agent.publicKey,
    audience: 'owner',
    summary: 'Spend within the research envelope',
    scope,
    provenance: {
      immediateTurnEventId: '1'.repeat(64),
      rootEventId: '2'.repeat(64),
    },
    requestedAt: NOW,
    requestExpiresAt: NOW + 60,
  };
  const request = parsePermissionRequest(
    buildPermissionRequest(agent, requestValue, [admin.publicKey]),
  )!;
  const envelope = defaultPermissionGrantEnvelope(scope, NOW + 1);
  envelope.maxUses = 4;
  envelope.rate.maxUses = 4;
  const decision = parsePermissionDecision(
    buildPermissionDecision(admin, request, {
      version: 1,
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      decision: 'grant',
      decidedAt: NOW + 1,
      grant: envelope,
    }),
    request,
  )!;
  const history = [decision.event];
  const events = new Map([
    [request.event.id, request.event],
    [decision.event.id, decision.event],
  ]);
  const reader: PermissionFreshReader = {
    readEvent: async (id) => events.get(id),
    isRegisteredAgent: async (pubkey) => pubkey === agent.publicKey,
    isRoomMember: async () => true,
    isWorkspaceMember: async () => true,
    roleForRoom: async (_roomId, pubkey) => (pubkey === admin.publicKey ? 'owner' : 'member'),
    hasDeviceCustody: async (pubkey) => pubkey === admin.publicKey,
    permissionHistory: async () => history,
  };
  function action(ordinal: number, amount = 500): PermissionConcreteAction {
    const concreteScope = { ...scope, maxMinorUnits: amount };
    const actionId = permissionActionId(concreteScope, request.event.id, ordinal);
    return {
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      grantEventId: decision.event.id,
      ordinal,
      actionId,
      idempotencyKey: `research:${actionId}`,
      workspaceId: request.value.workspaceId,
      roomId: request.value.roomId,
      scope: concreteScope,
      executor: 'ops-broker',
      executorPubkey: executor.publicKey,
      charge: { uses: 1, minorUnits: amount, currency: 'USD' },
    };
  }
  const claimed = new Set<string>();
  const reserved = new Set<string>();
  const published: typeof history = [];
  const runtime = new PermissionRuntime({
    identity: executor,
    reader,
    now: () => NOW + 2,
    claim: async (key) => {
      if (claimed.has(key)) return 'duplicate';
      claimed.add(key);
      return 'claimed';
    },
    reserveCapacity: async (input) => {
      if (reserved.has(input.key)) return 'duplicate';
      reserved.add(input.key);
      return 'claimed';
    },
    publish: async (event) => {
      published.push(event);
      history.push(event);
      events.set(event.id, event);
    },
  });
  return { action, history, published, runtime };
}

describe('PermissionRuntime', () => {
  it('executes multiple autonomous actions inside one standing envelope', async () => {
    const f = fixture();
    const invoke = vi.fn(async ({ actionId }: { actionId: string }) => ({ result: actionId }));
    await expect(
      f.runtime.execute({ action: f.action(0), attempt: 1, invoke }),
    ).resolves.toMatchObject({
      status: 'succeeded',
    });
    await expect(
      f.runtime.execute({ action: f.action(1), attempt: 1, invoke }),
    ).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(f.published.map((event) => JSON.parse(event.content).status)).toEqual([
      'started',
      'succeeded',
      'started',
      'succeeded',
    ]);
  });

  it('refuses an envelope boundary excess before invoking the adapter', async () => {
    const f = fixture();
    const invoke = vi.fn(async () => ({}));
    await expect(
      f.runtime.execute({ action: f.action(0, 5_001), attempt: 1, invoke }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'action-mismatch' });
    expect(invoke).not.toHaveBeenCalled();
    expect(f.published).toHaveLength(1);
    expect(JSON.parse(f.published[0]!.content)).toMatchObject({
      status: 'failed',
      result: 'refused:action-mismatch',
    });
  });

  it('never blindly retries an ambiguous adapter result; known failures require an explicit attempt', async () => {
    const f = fixture();
    const ambiguous = vi.fn(async () => {
      throw new Error('socket closed after submit');
    });
    await expect(
      f.runtime.execute({ action: f.action(0), attempt: 1, invoke: ambiguous }),
    ).resolves.toMatchObject({ status: 'unknown' });
    await expect(
      f.runtime.execute({ action: f.action(0), attempt: 2, invoke: ambiguous }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'action-outcome-unknown' });
    expect(ambiguous).toHaveBeenCalledTimes(1);

    const known = vi.fn(async () => {
      throw new PermissionKnownFailure('provider-rejected');
    });
    await expect(
      f.runtime.execute({ action: f.action(1), attempt: 1, invoke: known }),
    ).resolves.toMatchObject({ status: 'failed', result: 'provider-rejected' });
    await expect(
      f.runtime.execute({ action: f.action(1), attempt: 2, invoke: async () => ({}) }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });
});

describe('room.create directive normalization', () => {
  const principal = 'a'.repeat(64);
  const atlas = 'b'.repeat(64);
  const scout = 'c'.repeat(64);
  const roster = [
    { handle: 'owner', pubkey: principal, kind: 'human' as const },
    { handle: 'Atlas', pubkey: atlas, kind: 'agent' as const },
    { handle: 'Scout', pubkey: scout, kind: 'agent' as const },
  ];

  it('normalizes one exact outcome Room request with a reserved id', () => {
    expect(
      parseRoomCreatePermissionDirective({
        task: 'create an outcome Room named “Q3 launch” with @Atlas and @Scout.',
        workspaceId: 'workspace-one',
        reservedRoomId: 'room-reservation',
        principalPubkey: principal,
        roster,
      }),
    ).toEqual({
      type: 'room.create',
      workspaceId: 'workspace-one',
      roomId: 'room-reservation',
      name: 'Q3 launch',
      visibility: 'invite-only',
      participantPubkeys: [principal],
      agentPubkeys: [atlas, scout],
    });
  });

  it.each([
    'may I create a Room?',
    'create an outcome Room named Q3 launch with @Atlas',
    'create an outcome Room named “Q3 launch” with @Unknown',
    'create an outcome Room named “Q3 launch” with @Atlas and @Atlas',
  ])('keeps non-exact prose inert: %s', (task) => {
    expect(
      parseRoomCreatePermissionDirective({
        task,
        workspaceId: 'workspace-one',
        reservedRoomId: 'room-reservation',
        principalPubkey: principal,
        roster,
      }),
    ).toBeUndefined();
  });
});

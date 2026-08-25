import { randomUUID } from 'node:crypto';
import { signEvent } from '@beeline/nostr';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createIdentity } from './identity.js';
import { KIND_STREAM_MESSAGE } from './kinds.js';
import {
  buildPermissionDecision,
  buildPermissionExecution,
  buildPermissionRequest,
  buildPermissionRevocation,
  defaultPermissionGrantEnvelope,
  foldPermissionLedger,
  parsePermissionDecision,
  parsePermissionExecution,
  parsePermissionRequest,
  parsePermissionRevocation,
  permissionActionId,
  permissionScopeAllows,
  verifyPermissionAction,
  type PermissionConcreteAction,
  type PermissionDecisionV1,
  type PermissionExecutionV1,
  type PermissionFreshReader,
  type PermissionRequestV1,
  type PermissionScope,
} from './permission-request.js';

const NOW = 2_000_000_000;
const ROOT = '1'.repeat(64);
const TURN = '2'.repeat(64);

function roomScope(): PermissionScope {
  return {
    type: 'room.create',
    workspaceId: 'workspace-one',
    roomId: randomUUID(),
    name: 'Launch room',
    visibility: 'invite-only',
    participantPubkeys: ['a'.repeat(64)],
    agentPubkeys: ['b'.repeat(64)],
  };
}

function moneyScope(maxMinorUnits = 5_000): PermissionScope {
  return {
    type: 'money.spend',
    currency: 'USD',
    maxMinorUnits,
    merchant: 'ExampleVendor',
    purpose: 'Research API',
    connectorId: 'research-api',
  };
}

function requestValue(agentPubkey: string, scope: PermissionScope = roomScope()): PermissionRequestV1 {
  return {
    version: 1,
    permissionId: randomUUID(),
    roomId: 'source-room',
    workspaceId: 'workspace-one',
    requesterAgentPubkey: agentPubkey,
    audience: 'admin',
    summary: 'Create the exact launch room',
    scope,
    provenance: { immediateTurnEventId: TURN, rootEventId: ROOT },
    requestedAt: NOW,
    requestExpiresAt: NOW + 86_400,
  };
}

function decisionValue(
  request: ReturnType<typeof parsePermissionRequest> & {},
  decidedAt = NOW + 1,
): PermissionDecisionV1 {
  return {
    version: 1,
    permissionId: request.value.permissionId,
    requestEventId: request.event.id,
    decision: 'grant',
    decidedAt,
    grant: defaultPermissionGrantEnvelope(request.value.scope, decidedAt),
  };
}

function setup(scope: PermissionScope = roomScope()) {
  const agent = createIdentity('agent');
  const admin = createIdentity('admin');
  const executor = createIdentity('executor');
  const requestEvent = buildPermissionRequest(
    agent,
    requestValue(agent.publicKey, scope),
    [admin.publicKey],
  );
  const request = parsePermissionRequest(requestEvent)!;
  const decisionEvent = buildPermissionDecision(admin, request, decisionValue(request));
  const decision = parsePermissionDecision(decisionEvent, request)!;
  return { agent, admin, executor, request, decision };
}

describe('permission protocol codecs', () => {
  it('round-trips request, standing grant, revocation, and execution receipts', () => {
    const { admin, executor, request, decision } = setup(moneyScope());
    expect(decision.value.grant).toMatchObject({ tier: 1, mode: 'standing' });

    const revocationEvent = buildPermissionRevocation(admin, request, {
      version: 1,
      permissionId: request.value.permissionId,
      grantEventId: decision.event.id,
      revokedAt: NOW + 2,
      reason: 'owner-paused',
    });
    expect(parsePermissionRevocation(revocationEvent, request)?.value.reason).toBe('owner-paused');

    const executionEvent = buildPermissionExecution(executor, request, {
      version: 1,
      permissionId: request.value.permissionId,
      grantEventId: decision.event.id,
      actionId: 'research-charge-1',
      idempotencyKey: 'provider-research-charge-1',
      attempt: 1,
      status: 'started',
      at: NOW + 3,
      charge: { uses: 1, minorUnits: 500, currency: 'USD' },
    });
    expect(parsePermissionExecution(executionEvent, request)?.value.charge?.minorUnits).toBe(500);
  });

  it('makes irreversible operations Tier 2 and structurally per-action only', () => {
    const scope: PermissionScope = {
      type: 'operation.execute',
      connectorId: 'production',
      tool: 'delete-database',
      argumentsDigest: 'a'.repeat(64),
      target: 'production/customers',
      risk: 'irreversible',
    };
    const { admin, request } = setup(scope);
    const grant = defaultPermissionGrantEnvelope(scope, NOW + 1);
    expect(grant).toMatchObject({ tier: 2, mode: 'per-action', maxUses: 1 });
    const standing = { ...grant, tier: 1 as const, mode: 'standing' as const, maxUses: 10 };
    expect(() =>
      buildPermissionDecision(admin, request, {
        ...decisionValue(request),
        grant: standing,
      }),
    ).toThrow('invalid permission decision');
  });

  it('rejects missing, duplicate, conflicting, forged, oversized, and future-version fields', () => {
    const { agent, admin, request } = setup();
    const original = request.event;
    const resign = (tags: string[][], content = original.content) =>
      signEvent(
        { ...original, id: undefined as never, sig: undefined as never, tags, content },
        agent.secretKey,
      );
    expect(parsePermissionRequest(resign(original.tags.filter((tag) => tag[0] !== 'h')))).toBeUndefined();
    expect(parsePermissionRequest(resign([...original.tags, ['h', request.value.roomId]]))).toBeUndefined();
    expect(
      parsePermissionRequest(
        resign([...original.tags, ['p', original.tags.find((tag) => tag[0] === 'p')![1]!]]),
      ),
    ).toBeUndefined();
    expect(
      parsePermissionRequest(
        resign(original.tags.map((tag) => (tag[0] === 'scope' ? ['scope', 'money.spend'] : tag))),
      ),
    ).toBeUndefined();
    const future = JSON.stringify({ ...request.value, version: 2 });
    expect(parsePermissionRequest(resign(original.tags, future))).toBeUndefined();
    const oversized = JSON.stringify({ ...request.value, summary: 'x'.repeat(601) });
    expect(parsePermissionRequest(resign(original.tags, oversized))).toBeUndefined();
    const wrongWorkspace = JSON.stringify({
      ...request.value,
      scope: { ...request.value.scope, workspaceId: 'other-workspace' },
    });
    expect(parsePermissionRequest(resign(original.tags, wrongWorkspace))).toBeUndefined();
    const forged = { ...original, content: `${original.content} ` };
    expect(parsePermissionRequest(forged)).toBeUndefined();

    const decision = buildPermissionDecision(admin, request, decisionValue(request));
    const crossRoom = signEvent(
      {
        ...decision,
        id: undefined as never,
        sig: undefined as never,
        tags: decision.tags.map((tag) => (tag[0] === 'h' ? ['h', 'another-room'] : tag)),
      },
      admin.secretKey,
    );
    expect(parsePermissionDecision(crossRoom, request)).toBeUndefined();
  });
});

describe('permission fold', () => {
  it('uses the first valid decision and keeps later concurrent decisions audit-only', () => {
    const { request } = setup();
    const firstAdmin = createIdentity('first');
    const secondAdmin = createIdentity('second');
    const deny = parsePermissionDecision(
      buildPermissionDecision(firstAdmin, request, {
        version: 1,
        permissionId: request.value.permissionId,
        requestEventId: request.event.id,
        decision: 'deny',
        decidedAt: NOW + 2,
      }),
      request,
    )!;
    const grant = parsePermissionDecision(
      buildPermissionDecision(secondAdmin, request, decisionValue(request, NOW + 3)),
      request,
    )!;
    expect(
      foldPermissionLedger({ request, decisions: [grant, deny], now: NOW + 4 }),
    ).toMatchObject({ status: 'denied', decision: { event: { id: deny.event.id } } });
    expect(
      foldPermissionLedger({
        request,
        decisions: [grant, deny],
        now: NOW + 4,
        decisionAuthorized: (candidate) => candidate.event.id !== deny.event.id,
      }),
    ).toMatchObject({ status: 'granted', decision: { event: { id: grant.event.id } } });
  });

  it('folds expiry, revocation, use exhaustion, unknown, and retryable failure', () => {
    const { admin, executor, request, decision } = setup();
    expect(
      foldPermissionLedger({ request, decisions: [], now: request.value.requestExpiresAt + 1 }),
    ).toEqual({ status: 'expired' });

    const revocation = parsePermissionRevocation(
      buildPermissionRevocation(admin, request, {
        version: 1,
        permissionId: request.value.permissionId,
        grantEventId: decision.event.id,
        revokedAt: NOW + 2,
        reason: 'stopped',
      }),
      request,
    )!;
    expect(
      foldPermissionLedger({ request, decisions: [decision], revocations: [revocation], now: NOW + 3 }),
    ).toMatchObject({ status: 'revoked' });

    const receipt = (status: PermissionExecutionV1['status']) =>
      parsePermissionExecution(
        buildPermissionExecution(executor, request, {
          version: 1,
          permissionId: request.value.permissionId,
          grantEventId: decision.event.id,
          actionId: 'create-room',
          idempotencyKey: 'create-room',
          attempt: 1,
          status,
          at: NOW + 4,
          charge: { uses: 1 },
        }),
        request,
      )!;
    expect(
      foldPermissionLedger({ request, decisions: [decision], executions: [receipt('succeeded')], now: NOW + 5 }),
    ).toMatchObject({ status: 'consumed' });
    expect(
      foldPermissionLedger({ request, decisions: [decision], executions: [receipt('unknown')], now: NOW + 5 }),
    ).toMatchObject({ status: 'unknown' });
    expect(
      foldPermissionLedger({ request, decisions: [decision], executions: [receipt('failed')], now: NOW + 5 }),
    ).toMatchObject({ status: 'granted' });
  });
});

describe('standing envelope execution verification', () => {
  function verifierFixture(scope: PermissionScope = moneyScope()) {
    const setupResult = setup(scope);
    const events = new Map([
      [setupResult.request.event.id, setupResult.request.event],
      [setupResult.decision.event.id, setupResult.decision.event],
    ]);
    const history = [setupResult.decision.event];
    const reader: PermissionFreshReader = {
      readEvent: async (id) => events.get(id),
      isRegisteredAgent: async (key) => key === setupResult.agent.publicKey,
      isRoomMember: async () => true,
      isWorkspaceMember: async () => true,
      roleForRoom: async (roomId, key) =>
        roomId === setupResult.request.value.roomId && key === setupResult.admin.publicKey
          ? 'owner'
          : 'member',
      hasDeviceCustody: async (key) => key === setupResult.admin.publicKey,
      permissionHistory: async () => history,
    };
    const action: PermissionConcreteAction = {
      permissionId: setupResult.request.value.permissionId,
      requestEventId: setupResult.request.event.id,
      grantEventId: setupResult.decision.event.id,
      ordinal: 0,
      actionId: permissionActionId(moneyScope(500), setupResult.request.event.id, 0),
      idempotencyKey: 'charge-one',
      workspaceId: setupResult.request.value.workspaceId,
      roomId: setupResult.request.value.roomId,
      scope: moneyScope(500),
      executor: 'ops-broker',
      executorPubkey: setupResult.executor.publicKey,
      charge: { uses: 1, minorUnits: 500, currency: 'USD' },
    };
    return { ...setupResult, events, history, reader, action };
  }

  it('authorizes autonomous repeated actions inside one standing envelope', async () => {
    const fixture = verifierFixture();
    await expect(
      verifyPermissionAction({ reader: fixture.reader, action: fixture.action, now: NOW + 2 }),
    ).resolves.toMatchObject({ authorized: true });

    const succeeded = buildPermissionExecution(fixture.executor, fixture.request, {
      version: 1,
      permissionId: fixture.request.value.permissionId,
      grantEventId: fixture.decision.event.id,
      actionId: fixture.action.actionId,
      idempotencyKey: fixture.action.idempotencyKey,
      attempt: 1,
      status: 'succeeded',
      at: NOW + 3,
      charge: fixture.action.charge,
    });
    fixture.history.push(succeeded);
    await expect(
      verifyPermissionAction({
        reader: fixture.reader,
        action: {
          ...fixture.action,
          ordinal: 1,
          actionId: permissionActionId(fixture.action.scope, fixture.request.event.id, 1),
          idempotencyKey: 'charge-two',
        },
        now: NOW + 4,
      }),
    ).resolves.toMatchObject({ authorized: true, usage: { uses: 1, minorUnits: 500 } });
  });

  it('escalates boundary, budget, replay, Workspace, and authority failures without a side effect', async () => {
    const fixture = verifierFixture();
    await expect(
      verifyPermissionAction({
        reader: fixture.reader,
        action: { ...fixture.action, scope: moneyScope(5_001), charge: { uses: 1, minorUnits: 5_001, currency: 'USD' } },
        now: NOW + 2,
      }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'action-mismatch' });
    await expect(
      verifyPermissionAction({
        reader: fixture.reader,
        action: { ...fixture.action, workspaceId: 'another-workspace' },
        now: NOW + 2,
      }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'request-invalid' });
    await expect(
      verifyPermissionAction({
        reader: fixture.reader,
        action: {
          ...fixture.action,
          actionId: permissionActionId(fixture.action.scope, fixture.request.event.id, 1),
        },
        now: NOW + 2,
      }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'action-mismatch' });

    fixture.reader.isRegisteredAgent = async () => true;
    await expect(
      verifyPermissionAction({ reader: fixture.reader, action: fixture.action, now: NOW + 2 }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'signer-is-agent' });
  });

  it('rejects revocation and exhausted total/rate budgets from fresh history', async () => {
    const fixture = verifierFixture(moneyScope(1_000));
    const grant = fixture.decision.value.grant!;
    grant.maxUses = 2;
    grant.rate.maxUses = 2;
    grant.budget.maxMinorUnits = 1_000;
    // Rebuild the signed decision after changing the envelope.
    const replacement = parsePermissionDecision(
      buildPermissionDecision(fixture.admin, fixture.request, {
        ...decisionValue(fixture.request),
        grant,
      }),
      fixture.request,
    )!;
    fixture.events.delete(fixture.decision.event.id);
    fixture.events.set(replacement.event.id, replacement.event);
    fixture.action.grantEventId = replacement.event.id;
    fixture.history.splice(0, 1, replacement.event);

    const spent = buildPermissionExecution(fixture.executor, fixture.request, {
      version: 1,
      permissionId: fixture.request.value.permissionId,
      grantEventId: replacement.event.id,
      actionId: 'spent',
      idempotencyKey: 'spent',
      attempt: 1,
      status: 'succeeded',
      at: NOW + 2,
      charge: { uses: 1, minorUnits: 900, currency: 'USD' },
    });
    fixture.history.push(spent);
    await expect(
      verifyPermissionAction({
        reader: fixture.reader,
        action: { ...fixture.action, charge: { uses: 1, minorUnits: 500, currency: 'USD' } },
        now: NOW + 3,
      }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'budget-exhausted' });

    const revoked = buildPermissionRevocation(fixture.admin, fixture.request, {
      version: 1,
      permissionId: fixture.request.value.permissionId,
      grantEventId: replacement.event.id,
      revokedAt: NOW + 4,
      reason: 'owner-stopped',
    });
    fixture.history.push(revoked);
    await expect(
      verifyPermissionAction({ reader: fixture.reader, action: fixture.action, now: NOW + 5 }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'revoked' });
  });

  it('fails closed when current authority reads throw', async () => {
    const fixture = verifierFixture();
    fixture.reader.roleForRoom = async () => {
      throw new Error('relay unavailable');
    };
    await expect(
      verifyPermissionAction({ reader: fixture.reader, action: fixture.action, now: NOW + 2 }),
    ).resolves.toEqual({ authorized: false, terminal: false, reason: 'authority-unavailable' });
  });

  it.each([
    ['removed admin', { roomMember: false, workspaceMember: true, role: 'owner', custody: true, agent: false }, 'signer-not-current-admin'],
    ['unrelated member', { roomMember: true, workspaceMember: true, role: 'member', custody: true, agent: false }, 'signer-not-current-admin'],
    ['non-device key', { roomMember: true, workspaceMember: true, role: 'owner', custody: false, agent: false }, 'signer-not-device-held'],
    ['agent signer', { roomMember: true, workspaceMember: true, role: 'owner', custody: true, agent: true }, 'signer-is-agent'],
  ] as const)('rejects a %s using current authority facts', async (_label, facts, reason) => {
    const fixture = verifierFixture();
    fixture.reader.isRegisteredAgent = async (pubkey) =>
      pubkey === fixture.agent.publicKey || (facts.agent && pubkey === fixture.admin.publicKey);
    fixture.reader.isRoomMember = async (_room, pubkey) =>
      pubkey === fixture.admin.publicKey ? facts.roomMember : true;
    fixture.reader.isWorkspaceMember = async (_workspace, pubkey) =>
      pubkey === fixture.admin.publicKey ? facts.workspaceMember : true;
    fixture.reader.roleForRoom = async (_room, pubkey) =>
      pubkey === fixture.admin.publicKey ? facts.role : 'member';
    fixture.reader.hasDeviceCustody = async (pubkey) =>
      pubkey === fixture.admin.publicKey && facts.custody;
    await expect(
      verifyPermissionAction({ reader: fixture.reader, action: fixture.action, now: NOW + 2 }),
    ).resolves.toEqual({ authorized: false, terminal: true, reason });
  });

  it('honors an owner-only audience even when the registry minimum is admin', async () => {
    const scope = roomScope();
    const agent = createIdentity('agent');
    const admin = createIdentity('admin');
    const executor = admin;
    const value = { ...requestValue(agent.publicKey, scope), audience: 'owner' as const };
    const request = parsePermissionRequest(buildPermissionRequest(agent, value, [admin.publicKey]))!;
    const decision = parsePermissionDecision(
      buildPermissionDecision(admin, request, decisionValue(request)),
      request,
    )!;
    const events = new Map([[request.event.id, request.event], [decision.event.id, decision.event]]);
    const reader: PermissionFreshReader = {
      readEvent: async (id) => events.get(id),
      isRegisteredAgent: async (pubkey) => pubkey === agent.publicKey,
      isRoomMember: async () => true,
      isWorkspaceMember: async () => true,
      roleForRoom: async (_room, pubkey) => pubkey === admin.publicKey ? 'admin' : 'member',
      hasDeviceCustody: async (pubkey) => pubkey === admin.publicKey,
      permissionHistory: async () => [decision.event],
    };
    const action: PermissionConcreteAction = {
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      grantEventId: decision.event.id,
      ordinal: 0,
      actionId: permissionActionId(scope, request.event.id, 0),
      idempotencyKey: 'room-create',
      workspaceId: request.value.workspaceId,
      roomId: request.value.roomId,
      scope,
      executor: 'human-device',
      executorPubkey: executor.publicKey,
      charge: { uses: 1 },
    };
    await expect(verifyPermissionAction({ reader, action, now: NOW + 2 })).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'signer-not-current-admin',
    });
  });

  it('property-checks monetary scope containment at the exact signed boundary', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 200_000 }), (limit, spend) => {
        expect(permissionScopeAllows(moneyScope(limit), moneyScope(spend))).toBe(spend <= limit);
      }),
    );
  });
});

describe('reserved markers do not become authority from prose', () => {
  it('rejects an unsigned visible @admin request', () => {
    const human = createIdentity('human');
    const event = signEvent(
      {
        pubkey: human.publicKey,
        created_at: NOW,
        kind: KIND_STREAM_MESSAGE,
        tags: [['h', 'source-room']],
        content: '@admin: approve sending this',
      },
      human.secretKey,
    );
    expect(parsePermissionRequest(event)).toBeUndefined();
  });
});

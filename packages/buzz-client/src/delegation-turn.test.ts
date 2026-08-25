import { randomUUID } from 'node:crypto';
import { signEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import { createIdentity } from './identity.js';
import {
  admitDelegationTurn,
  buildDelegationReceipt,
  buildDelegationTurn,
  defaultDelegationBudget,
  parseDelegationDirectives,
  parseDelegationReceipt,
  parseDelegationTurn,
  type DelegationTurnV1,
  type ParsedDelegationTurn,
} from './delegation-turn.js';

const NOW = 2_000_000_000;
const ROOT = '1'.repeat(64);
const PARENT = '2'.repeat(64);

function turnValue(
  from: string,
  to: string,
  extra: Partial<DelegationTurnV1> = {},
): DelegationTurnV1 {
  return {
    version: 1,
    delegationId: randomUUID(),
    workItemId: randomUUID(),
    phase: 'assign',
    roomId: 'room-one',
    workspaceId: 'workspace-one',
    fromAgentPubkey: from,
    toAgentPubkey: to,
    rootEventId: ROOT,
    parentEventId: PARENT,
    principalPubkey: 'f'.repeat(64),
    path: [from],
    depth: 1,
    budget: defaultDelegationBudget(NOW, 10_000),
    task: 'Research ten verified candidates.',
    createdAt: NOW,
    ...extra,
  };
}

function admission(turn: ParsedDelegationTurn, history: ParsedDelegationTurn[] = []) {
  return admitDelegationTurn({
    turn,
    history,
    now: NOW + 1,
    expectedRecipientPubkey: turn.value.toAgentPubkey,
    senderIsRegisteredAgent: true,
    senderRoomMember: true,
    senderWorkspaceMember: true,
    recipientRoomMember: true,
    recipientWorkspaceMember: true,
    principalRoomMember: true,
    principalWorkspaceMember: true,
    rootAuthorized: true,
    escalationAuthorized: true,
    accessPermitted: true,
    targetOnline: true,
    targetSupportsDelegationV1: true,
  });
}

describe('delegation codecs', () => {
  it('round-trips exact signed turn and receipt objects', () => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const event = buildDelegationTurn(atlas, turnValue(atlas.publicKey, scout.publicKey));
    const parsed = parseDelegationTurn(event)!;
    expect(parsed.value).toMatchObject({
      fromAgentPubkey: atlas.publicKey,
      toAgentPubkey: scout.publicKey,
      phase: 'assign',
    });
    const receipt = buildDelegationReceipt(scout, parsed.value.roomId, {
      version: 1,
      delegationId: parsed.value.delegationId,
      workItemId: parsed.value.workItemId,
      turnEventId: parsed.event.id,
      status: 'failed',
      at: NOW + 1,
      reason: 'model invocation failed',
    });
    expect(parseDelegationReceipt(receipt)?.value).toMatchObject({
      status: 'failed',
      reason: 'model invocation failed',
    });
  });

  it('rejects forgery, conflicting recipients, unknown versions, and oversized tasks', () => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const event = buildDelegationTurn(atlas, turnValue(atlas.publicKey, scout.publicKey));
    expect(parseDelegationTurn({ ...event, content: `${event.content} ` })).toBeUndefined();
    const resign = (tags: string[][], content = event.content) =>
      signEvent(
        { ...event, id: undefined as never, sig: undefined as never, tags, content },
        atlas.secretKey,
      );
    expect(parseDelegationTurn(resign([...event.tags, ['p', scout.publicKey]]))).toBeUndefined();
    const parsed = JSON.parse(event.content) as DelegationTurnV1;
    expect(
      parseDelegationTurn(resign(event.tags, JSON.stringify({ ...parsed, version: 2 }))),
    ).toBeUndefined();
    expect(
      parseDelegationTurn(
        resign(event.tags, JSON.stringify({ ...parsed, task: 'x'.repeat(1_201) })),
      ),
    ).toBeUndefined();
    expect(
      parseDelegationTurn(
        resign(event.tags, JSON.stringify({ ...parsed, path: ['e'.repeat(64)], depth: 1 })),
      ),
    ).toBeUndefined();
    expect(
      parseDelegationTurn(
        resign(
          event.tags,
          JSON.stringify({ ...parsed, depth: 2, path: [atlas.publicKey, atlas.publicKey] }),
        ),
      ),
    ).toBeUndefined();
  });

  it('binds mission assign/return lineage to the CoS and exact target daemon', () => {
    const controller = createIdentity('CoS');
    const target = createIdentity('Target');
    const mission = {
      missionId: 'mission-one',
      grantEventId: 'a'.repeat(64),
      controllerAgentPubkey: controller.publicKey,
      scheduleId: 'summary',
      scheduleRevision: 2,
      scheduleRevisionDigest: 'b'.repeat(64),
      scheduleRunId: 'run-one',
      mode: 'script' as const,
      targetAgentPubkey: target.publicKey,
      maxRuns: 10,
      perRunReservedTokens: 100,
      dailyReservedTokens: 500,
      totalReservedTokens: 1_000,
      scriptRuntimeSeconds: 30,
      repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
    };
    const assign = parseDelegationTurn(
      buildDelegationTurn(
        controller,
        turnValue(controller.publicKey, target.publicKey, {
          rootEventId: mission.grantEventId,
          mission,
        }),
      ),
    )!;
    expect(assign.value.toAgentPubkey).toBe(target.publicKey);
    expect(assign.value.mission).toEqual(mission);

    const malformed = JSON.parse(assign.event.content) as DelegationTurnV1;
    const forgedTarget = signEvent(
      {
        ...assign.event,
        id: undefined as never,
        sig: undefined as never,
        content: JSON.stringify({
          ...malformed,
          mission: { ...mission, targetAgentPubkey: controller.publicKey },
        }),
      },
      controller.secretKey,
    );
    expect(parseDelegationTurn(forgedTarget)).toBeUndefined();

    const returned = parseDelegationTurn(
      buildDelegationTurn(
        target,
        turnValue(target.publicKey, controller.publicKey, {
          delegationId: assign.value.delegationId,
          phase: 'return',
          rootEventId: mission.grantEventId,
          parentEventId: assign.event.id,
          parentWorkItemId: assign.value.workItemId,
          path: [controller.publicKey, target.publicKey],
          depth: 2,
          mission,
        }),
      ),
    );
    expect(returned?.value.toAgentPubkey).toBe(controller.publicKey);
  });
});

describe('directive grammar', () => {
  const atlas = 'a'.repeat(64);
  const scout = 'b'.repeat(64);
  const writer = 'c'.repeat(64);
  const roster = [
    { handle: 'Atlas', pubkey: atlas },
    { handle: 'Scout', pubkey: scout },
    { handle: 'Writer', pubkey: writer },
  ];

  it('parses real top-level fan-out and permission directives', () => {
    expect(
      parseDelegationDirectives(
        '@Scout: research the market\n\n@Writer: draft the brief\n@admin: create the outcome room',
        roster,
      ),
    ).toEqual({
      directives: [
        { kind: 'delegate', handle: 'Scout', targetPubkey: scout, task: 'research the market' },
        { kind: 'delegate', handle: 'Writer', targetPubkey: writer, task: 'draft the brief' },
        { kind: 'permission', audience: 'admin', task: 'create the outcome room' },
      ],
      errors: [],
    });
  });

  it('keeps mid-sentence, quotes, and fenced examples inert', () => {
    const result = parseDelegationDirectives(
      'Please ask @Scout: later\n> @Scout: quoted\n```\n@Scout: code\n```\nordinary text',
      roster,
    );
    expect(result).toEqual({ directives: [], errors: [] });
  });

  it('fails ambiguous handles and caps one turn at four directives', () => {
    const ambiguous = parseDelegationDirectives('@Scout: research', [
      ...roster,
      { handle: 'scout', pubkey: 'd'.repeat(64) },
    ]);
    expect(ambiguous.errors).toContainEqual({ reason: 'ambiguous-handle', handle: 'Scout' });
    const tooMany = parseDelegationDirectives(
      Array.from({ length: 5 }, (_, index) => `@Scout: task ${index}`).join('\n'),
      roster,
    );
    expect(tooMany.errors).toContainEqual({ reason: 'too-many-directives' });
    expect(tooMany.directives).toHaveLength(4);
  });
});

describe('delegation graph admission', () => {
  it('admits Atlas → Scout and exactly one Scout → Atlas return', () => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const assign = parseDelegationTurn(
      buildDelegationTurn(atlas, turnValue(atlas.publicKey, scout.publicKey)),
    )!;
    expect(admission(assign)).toMatchObject({ admitted: true, turnOrdinal: 1 });

    const returnedValue = turnValue(scout.publicKey, atlas.publicKey, {
      delegationId: assign.value.delegationId,
      workItemId: randomUUID(),
      phase: 'return',
      rootEventId: assign.value.rootEventId,
      parentEventId: assign.event.id,
      parentWorkItemId: assign.value.workItemId,
      principalPubkey: assign.value.principalPubkey,
      roomId: assign.value.roomId,
      workspaceId: assign.value.workspaceId,
      path: [atlas.publicKey, scout.publicKey],
      depth: 2,
      budget: assign.value.budget,
      task: 'Return the verified findings.',
      createdAt: NOW + 1,
    });
    const returned = parseDelegationTurn(buildDelegationTurn(scout, returnedValue))!;
    expect(admission(returned, [assign])).toMatchObject({ admitted: true, turnOrdinal: 2 });
    expect(admission(returned, [assign, returned])).toEqual({
      admitted: false,
      reason: 'duplicate',
    });
  });

  it.each([
    ['wrong-recipient', { expectedRecipientPubkey: 'e'.repeat(64) }],
    ['sender-not-agent', { senderIsRegisteredAgent: false }],
    ['sender-not-member', { senderRoomMember: false }],
    ['sender-not-member', { senderWorkspaceMember: false }],
    ['recipient-not-member', { recipientRoomMember: false }],
    ['recipient-not-member', { recipientWorkspaceMember: false }],
    ['principal-not-member', { principalRoomMember: false }],
    ['principal-not-member', { principalWorkspaceMember: false }],
    ['root-mismatch', { rootAuthorized: false }],
    ['access-denied', { accessPermitted: false }],
    ['target-offline', { targetOnline: false }],
    ['target-incompatible', { targetSupportsDelegationV1: false }],
  ] as const)('refuses %s before any model turn', (reason, override) => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const turn = parseDelegationTurn(
      buildDelegationTurn(atlas, turnValue(atlas.publicKey, scout.publicKey)),
    )!;
    expect(
      admitDelegationTurn({
        turn,
        history: [],
        now: NOW + 1,
        expectedRecipientPubkey: turn.value.toAgentPubkey,
        senderIsRegisteredAgent: true,
        senderRoomMember: true,
        senderWorkspaceMember: true,
        recipientRoomMember: true,
        recipientWorkspaceMember: true,
        principalRoomMember: true,
        principalWorkspaceMember: true,
        rootAuthorized: true,
        escalationAuthorized: true,
        accessPermitted: true,
        targetOnline: true,
        targetSupportsDelegationV1: true,
        ...override,
      }),
    ).toEqual({ admitted: false, reason });
  });

  it('refuses ancestry cycles, expired work, over-depth, and ungranted escalation', () => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const cycle = parseDelegationTurn(
      buildDelegationTurn(
        atlas,
        turnValue(atlas.publicKey, scout.publicKey, {
          path: [scout.publicKey, atlas.publicKey],
          depth: 2,
          parentWorkItemId: randomUUID(),
        }),
      ),
    )!;
    expect(admission(cycle)).toEqual({ admitted: false, reason: 'cycle' });

    const expired = parseDelegationTurn(
      buildDelegationTurn(
        atlas,
        turnValue(atlas.publicKey, scout.publicKey, {
          budget: { ...defaultDelegationBudget(NOW), deadlineAt: NOW },
        }),
      ),
    )!;
    expect(admission(expired)).toEqual({ admitted: false, reason: 'expired' });

    const escalated = parseDelegationTurn(
      buildDelegationTurn(
        atlas,
        turnValue(atlas.publicKey, scout.publicKey, {
          budget: { ...defaultDelegationBudget(NOW), maxAgentTurns: 9 },
        }),
      ),
    )!;
    expect(admission(escalated)).toEqual({ admitted: false, reason: 'escalation-required' });

    const forgedGrant = parseDelegationTurn(
      buildDelegationTurn(
        atlas,
        turnValue(atlas.publicKey, scout.publicKey, {
          budget: { ...defaultDelegationBudget(NOW), maxAgentTurns: 9 },
          escalationGrantEventId: '3'.repeat(64),
        }),
      ),
    )!;
    expect(
      admitDelegationTurn({
        turn: forgedGrant,
        history: [],
        now: NOW + 1,
        expectedRecipientPubkey: scout.publicKey,
        senderIsRegisteredAgent: true,
        senderRoomMember: true,
        senderWorkspaceMember: true,
        recipientRoomMember: true,
        recipientWorkspaceMember: true,
        principalRoomMember: true,
        principalWorkspaceMember: true,
        rootAuthorized: true,
        escalationAuthorized: false,
        accessPermitted: true,
        targetOnline: true,
        targetSupportsDelegationV1: true,
      }),
    ).toEqual({ admitted: false, reason: 'escalation-required' });
  });

  it('conserves sibling turn and token allocations', () => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const writer = createIdentity('Writer');
    const rootBudget = { ...defaultDelegationBudget(NOW, 1_000), maxAgentTurns: 4 };
    const root = parseDelegationTurn(
      buildDelegationTurn(
        atlas,
        turnValue(atlas.publicKey, scout.publicKey, { budget: rootBudget }),
      ),
    )!;
    const child = parseDelegationTurn(
      buildDelegationTurn(
        scout,
        turnValue(scout.publicKey, writer.publicKey, {
          delegationId: root.value.delegationId,
          rootEventId: root.value.rootEventId,
          parentEventId: root.event.id,
          parentWorkItemId: root.value.workItemId,
          principalPubkey: root.value.principalPubkey,
          roomId: root.value.roomId,
          workspaceId: root.value.workspaceId,
          path: [atlas.publicKey, scout.publicKey],
          depth: 2,
          budget: { ...rootBudget, maxAgentTurns: 4, reservedTokens: 1_001 },
          createdAt: NOW + 1,
        }),
      ),
    )!;
    expect(admission(child, [root])).toEqual({ admitted: false, reason: 'over-child-budget' });
  });

  it('allows only one root assignment per delegation graph', () => {
    const atlas = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const writer = createIdentity('Writer');
    const root = parseDelegationTurn(
      buildDelegationTurn(atlas, turnValue(atlas.publicKey, scout.publicKey)),
    )!;
    const secondRoot = parseDelegationTurn(
      buildDelegationTurn(
        atlas,
        turnValue(atlas.publicKey, writer.publicKey, {
          delegationId: root.value.delegationId,
          rootEventId: root.value.rootEventId,
          principalPubkey: root.value.principalPubkey,
          roomId: root.value.roomId,
          workspaceId: root.value.workspaceId,
          budget: root.value.budget,
        }),
      ),
    )!;
    expect(admission(secondRoot, [root])).toEqual({ admitted: false, reason: 'root-mismatch' });
  });
});

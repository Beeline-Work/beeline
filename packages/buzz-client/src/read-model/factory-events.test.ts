import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDelegationReceipt,
  buildDelegationTurn,
  defaultDelegationBudget,
} from '../delegation-turn.js';
import { createIdentity } from '../identity.js';
import {
  buildPermissionDecision,
  buildPermissionExecution,
  buildPermissionRequest,
  buildPermissionRevocation,
  defaultPermissionGrantEnvelope,
  parsePermissionRequest,
} from '../permission-request.js';
import { createWorkspaceSnapshot, reduceWorkspaceEvents } from './reducer.js';
import { parseRelayEvents } from './parser.js';
import { selectTranscript } from './selectors.js';
import type { ParseAuthority, Pubkey } from './types.js';

const NOW = 2_000_000_000;
const ROOT = '1'.repeat(64);
const TURN = '2'.repeat(64);

describe('factory event read-model taxonomy', () => {
  it('classifies permission and delegation wires as typed commands/receipts, never chat', () => {
    const agent = createIdentity('Atlas');
    const scout = createIdentity('Scout');
    const admin = createIdentity('Owner');
    const permissionEvent = buildPermissionRequest(
      agent,
      {
        version: 1,
        permissionId: randomUUID(),
        roomId: 'room-one',
        workspaceId: 'workspace-one',
        requesterAgentPubkey: agent.publicKey,
        audience: 'admin',
        summary: 'Create the exact outcome room',
        scope: {
          type: 'room.create',
          workspaceId: 'workspace-one',
          roomId: randomUUID(),
          name: 'Outcome',
          visibility: 'invite-only',
          participantPubkeys: [admin.publicKey],
          agentPubkeys: [agent.publicKey, scout.publicKey],
        },
        provenance: { immediateTurnEventId: TURN, rootEventId: ROOT },
        requestedAt: NOW,
        requestExpiresAt: NOW + 3_600,
      },
      [admin.publicKey],
    );
    const request = parsePermissionRequest(permissionEvent)!;
    const decisionEvent = buildPermissionDecision(admin, request, {
      version: 1,
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      decision: 'grant',
      decidedAt: NOW + 1,
      grant: defaultPermissionGrantEnvelope(request.value.scope, NOW + 1),
    });
    const executionEvent = buildPermissionExecution(agent, request, {
      version: 1,
      permissionId: request.value.permissionId,
      grantEventId: decisionEvent.id,
      actionId: 'create-outcome-room',
      idempotencyKey: 'create-outcome-room',
      attempt: 1,
      status: 'started',
      at: NOW + 2,
      charge: { uses: 1 },
    });
    const revocationEvent = buildPermissionRevocation(admin, request, {
      version: 1,
      permissionId: request.value.permissionId,
      grantEventId: decisionEvent.id,
      revokedAt: NOW + 3,
      reason: 'owner-paused',
    });
    const delegationEvent = buildDelegationTurn(agent, {
      version: 1,
      delegationId: randomUUID(),
      workItemId: randomUUID(),
      phase: 'assign',
      roomId: 'room-one',
      workspaceId: 'workspace-one',
      fromAgentPubkey: agent.publicKey,
      toAgentPubkey: scout.publicKey,
      rootEventId: ROOT,
      parentEventId: TURN,
      principalPubkey: admin.publicKey,
      path: [agent.publicKey],
      depth: 1,
      budget: defaultDelegationBudget(NOW, 10_000),
      task: 'Research the market.',
      createdAt: NOW,
    });
    const delegationReceipt = buildDelegationReceipt(scout, 'room-one', {
      version: 1,
      delegationId: JSON.parse(delegationEvent.content).delegationId,
      workItemId: JSON.parse(delegationEvent.content).workItemId,
      turnEventId: delegationEvent.id,
      status: 'working',
      at: NOW + 1,
    });
    const authority: ParseAuthority = {
      workspaceId: 'workspace-one',
      expectedChannelId: 'room-one',
      identities: {
        [agent.publicKey]: {
          kind: 'agent',
          pubkey: agent.publicKey as Pubkey,
          revision: 'agent',
        },
        [scout.publicKey]: {
          kind: 'agent',
          pubkey: scout.publicKey as Pubkey,
          revision: 'scout',
        },
        [admin.publicKey]: {
          kind: 'human',
          pubkey: admin.publicKey as Pubkey,
          revision: 'admin',
        },
      },
      channelAdmins: { 'room-one': [admin.publicKey] },
    };
    const parsed = parseRelayEvents(
      [permissionEvent, decisionEvent, executionEvent, revocationEvent, delegationEvent, delegationReceipt],
      authority,
    );
    expect(parsed.map((event) => event.type)).toEqual([
      'command',
      'command',
      'receipt',
      'command',
      'command',
      'receipt',
    ]);
    expect(parsed[0]).toMatchObject({ command: { kind: 'permission.request' } });
    expect(parsed[1]).toMatchObject({ command: { kind: 'permission.decision' } });
    expect(parsed[2]).toMatchObject({ receipt: { kind: 'permission.execution' } });
    expect(parsed[3]).toMatchObject({ command: { kind: 'permission.revocation' } });
    expect(parsed[4]).toMatchObject({ command: { kind: 'delegation.turn' } });
    expect(parsed[5]).toMatchObject({ receipt: { kind: 'delegation.receipt' } });

    const snapshot = reduceWorkspaceEvents(createWorkspaceSnapshot('workspace-one'), parsed);
    expect(selectTranscript(snapshot, 'room-one')).toEqual([]);
  });

  it('suppresses a reserved decision tag signed by an ordinary member', () => {
    const agent = createIdentity('Atlas');
    const member = createIdentity('Member');
    const requestEvent = buildPermissionRequest(
      agent,
      {
        version: 1,
        permissionId: randomUUID(),
        roomId: 'room-one',
        workspaceId: 'workspace-one',
        requesterAgentPubkey: agent.publicKey,
        audience: 'admin',
        summary: 'Create a room',
        scope: {
          type: 'room.create',
          workspaceId: 'workspace-one',
          roomId: randomUUID(),
          name: 'Outcome',
          visibility: 'workspace',
          participantPubkeys: [member.publicKey],
          agentPubkeys: [agent.publicKey],
        },
        provenance: { immediateTurnEventId: TURN, rootEventId: ROOT },
        requestedAt: NOW,
        requestExpiresAt: NOW + 3_600,
      },
      [member.publicKey],
    );
    const request = parsePermissionRequest(requestEvent)!;
    const decision = buildPermissionDecision(member, request, {
      version: 1,
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      decision: 'deny',
      decidedAt: NOW + 1,
    });
    const parsed = parseRelayEvents([requestEvent, decision], {
      workspaceId: 'workspace-one',
      expectedChannelId: 'room-one',
      identities: {
        [agent.publicKey]: { kind: 'agent', pubkey: agent.publicKey as Pubkey, revision: 'agent' },
        [member.publicKey]: { kind: 'human', pubkey: member.publicKey as Pubkey, revision: 'member' },
      },
      channelAdmins: { 'room-one': [] },
    });
    expect(parsed[1]).toMatchObject({ type: 'unknown', reason: 'unauthorized' });
  });
});

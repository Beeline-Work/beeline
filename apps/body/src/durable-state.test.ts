import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { signEvent } from '@beeline/nostr';
import { DurableBodyState } from './durable-state.js';
import {
  createWorkspaceSnapshot,
  parseRelayEvents,
  reduceWorkspaceEvents,
  type IdentityRecord,
  type Pubkey,
} from '@beeline/buzz-client';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('durable input inbox', () => {
  it('survives restart and keeps a failed older event pending after newer delivery', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-inbox-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const identity = newIdentity('human');
    const events = Array.from({ length: 101 }, (_, index) =>
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: 1_700_000_000 + Math.floor(index / 20),
          kind: 9,
          tags: [['h', 'corner']],
          content: `message-${index}`,
        },
        identity.secretKey,
      ),
    );
    const first = new DurableBodyState(path);
    expect(await first.enqueue('corner', events)).toBe(101);
    await first.failed('corner', events[0]!.id, new Error('temporary'));
    for (const event of events.slice(1)) await first.delivered('corner', event.id);

    const restarted = new DurableBodyState(path);
    const pending = await restarted.pending('corner');
    expect(pending.map((event) => event.id)).toEqual([events[0]!.id]);
    expect((await restarted.cursor('corner')).createdAt).toBe(events[100]!.created_at);
  });

  it('persists one reserved reply so a retry reuses its event id', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-inbox-reply-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const human = newIdentity('human');
    const agent = newIdentity('agent');
    const request = signEvent(
      {
        pubkey: human.publicKey,
        created_at: 1_700_000_000,
        kind: 9,
        tags: [['h', 'room']],
        content: 'Reply once.',
      },
      human.secretKey,
    );
    const reply = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 1_700_000_001,
        kind: 9,
        tags: [
          ['h', 'room'],
          ['e', request.id, '', 'reply'],
        ],
        content: 'One reply.',
      },
      agent.secretKey,
    );

    const first = new DurableBodyState(path);
    await first.enqueue('room', [request]);
    expect((await first.reserveReply('room', request.id, reply)).id).toBe(reply.id);

    const restarted = new DurableBodyState(path);
    expect((await restarted.reply('room', request.id))?.id).toBe(reply.id);
    const differentReply = signEvent(
      { ...reply, created_at: reply.created_at + 1, content: 'A duplicate reply.' },
      agent.secretKey,
    );
    expect((await restarted.reserveReply('room', request.id, differentReply)).id).toBe(reply.id);
  });

  it('recovers the latest completed agent summary after restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-corner-summary-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const human = newIdentity('summary-human');
    const agent = newIdentity('summary-agent');
    const first = new DurableBodyState(path);
    const identities = [
      { kind: 'human', pubkey: human.publicKey as Pubkey, displayName: 'Captain', revision: '1' },
      { kind: 'agent', pubkey: agent.publicKey as Pubkey, displayName: 'Buzzy', revision: '1' },
    ] satisfies IdentityRecord[];
    const raw = [
      signEvent(
        {
          pubkey: agent.publicKey,
          created_at: 1,
          kind: 9,
          tags: [
            ['h', 'corner'],
            ['t', 'agent-message'],
          ],
          content: 'Implemented the first change.',
        },
        agent.secretKey,
      ),
      signEvent(
        {
          pubkey: human.publicKey,
          created_at: 2,
          kind: 9,
          tags: [['h', 'corner']],
          content: 'Please also add tests.',
        },
        human.secretKey,
      ),
      signEvent(
        {
          pubkey: agent.publicKey,
          created_at: 3,
          kind: 9,
          tags: [
            ['h', 'corner'],
            ['t', 'agent-message'],
          ],
          content: 'Implemented the change and added regression tests.',
        },
        agent.secretKey,
      ),
    ];
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'room', identities }),
      parseRelayEvents(raw, {
        workspaceId: 'room',
        allowedChannelIds: ['corner'],
        identities: Object.fromEntries(identities.map((identity) => [identity.pubkey, identity])),
      }),
    );
    await first.replaceReadModel('corner', snapshot);

    const restarted = new DurableBodyState(path);
    expect(await restarted.latestAgentMessage('corner')).toBe(
      'Implemented the change and added regression tests.',
    );
    expect(await restarted.latestAgentMessage('empty-corner')).toBeUndefined();
  });

  it('keeps model-call attribution inspectable across restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-model-spend-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const first = new DurableBodyState(path);
    await first.recordModelTurn({
      agentPubkey: 'agent',
      channelId: 'corner',
      requestId: 'restart-1',
      originalRequestId: 'human-request',
      cause: 'restart-continuation',
      startedAt: '2026-08-20T12:00:00.000Z',
      status: 'complete',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      tokenSource: 'estimated',
      toolCalls: 3,
    });

    const restarted = new DurableBodyState(path);
    expect(await restarted.modelTurns()).toEqual([
      expect.objectContaining({
        cause: 'restart-continuation',
        originalRequestId: 'human-request',
        totalTokens: 120,
      }),
    ]);
    await first.recordSessionReprime({
      agentPubkey: 'agent',
      channelId: 'corner',
      processGeneration: 'restart-1',
      at: '2026-08-20T12:00:00.000Z',
      entries: 200,
      beforeChars: 114_000,
      afterChars: 8_000,
      beforeTokens: 28_500,
      afterTokens: 2_000,
    });
    const restartedAgain = new DurableBodyState(path);
    expect(await restartedAgain.sessionReprimes()).toEqual([
      expect.objectContaining({ processGeneration: 'restart-1', afterTokens: 2_000 }),
    ]);
  });
});

describe('factory capacity reservations', () => {
  it('atomically admits only one concurrent action into a one-use grant', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-permission-capacity-'));
    cleanup.push(root);
    const state = new DurableBodyState(resolve(root, 'state.json'));
    const base = {
      grantEventId: 'grant',
      at: 1_000,
      charge: { uses: 1 },
      usage: {
        uses: 0,
        minorUnits: 0,
        reservedTokens: 0,
        committedAt: [],
        actionStatuses: new Map(),
      },
      grant: {
        tier: 1 as const,
        mode: 'standing' as const,
        notBefore: 900,
        expiresAt: 2_000,
        maxUses: 1,
        budget: {},
        rate: { maxUses: 1, windowSeconds: 60 },
      },
    };
    const results = await Promise.all([
      state.reservePermissionCapacity({ ...base, key: 'a:1', actionId: 'a' }),
      state.reservePermissionCapacity({ ...base, key: 'b:1', actionId: 'b' }),
    ]);
    expect(results.sort()).toEqual(['claimed', 'exhausted']);
  });

  it('atomically admits only one concurrent turn into shared root and daily capacity', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-delegation-capacity-'));
    cleanup.push(root);
    const state = new DurableBodyState(resolve(root, 'state.json'));
    const base = {
      delegationId: 'delegation',
      agentPubkey: 'agent',
      day: '2030-01-01',
      phase: 'assign' as const,
      reservedTokens: 100,
      allocatedTurns: 1,
      observedTurnEventIds: [],
      observedRootTurns: 0,
      rootMaxAgentTurns: 1,
      observedDailyCalls: 0,
      observedDailyReservedTokens: 0,
      observedDailyTurnEventIds: [],
      dailyMaxCalls: 1,
      dailyMaxReservedTokens: 100,
      observedSiblingCount: 0,
      observedSiblingAllocatedTurns: 0,
      observedSiblingAllocatedTokens: 0,
    };
    const results = await Promise.all([
      state.reserveDelegationInbound({ ...base, eventId: 'turn-a' }),
      state.reserveDelegationInbound({ ...base, eventId: 'turn-b' }),
    ]);
    expect(results.sort()).toEqual(['claimed', 'over-turn-budget']);
  });
});

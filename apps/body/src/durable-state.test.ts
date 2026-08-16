import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { signEvent } from '@beeline/nostr';
import { DurableBodyState } from './durable-state.js';

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
        tags: [['h', 'room'], ['e', request.id, '', 'reply']],
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
    const first = new DurableBodyState(path);
    await first.appendConversation('corner', {
      role: 'agent',
      text: 'Implemented the first change.',
      at: new Date(1).toISOString(),
    });
    await first.appendConversation('corner', {
      role: 'user',
      text: 'Please also add tests.',
      at: new Date(2).toISOString(),
    });
    await first.appendConversation('corner', {
      role: 'agent',
      text: 'Implemented the change and added regression tests.',
      at: new Date(3).toISOString(),
    });

    const restarted = new DurableBodyState(path);
    expect(await restarted.latestAgentMessage('corner')).toBe(
      'Implemented the change and added regression tests.',
    );
    expect(await restarted.latestAgentMessage('empty-corner')).toBeUndefined();
  });
});

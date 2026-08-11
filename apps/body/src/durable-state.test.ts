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
});

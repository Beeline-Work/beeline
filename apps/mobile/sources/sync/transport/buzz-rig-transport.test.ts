import { describe, expect, it } from 'vitest';
import type { SessionEvent as BuzzSessionEvent } from '@buzzy/buzz-client';
import { toRigEvent } from './buzz-event-projection';

describe('Buzz branch-loop event projection', () => {
  it('preserves request and lifecycle tags for the mobile UI', () => {
    const event = {
      id: 'event-id',
      pubkey: 'a'.repeat(64),
      created_at: 42,
      kind: 9,
      tags: [
        ['h', 'channel'],
        ['t', 'buzz-agent-request'],
        ['p', 'b'.repeat(64)],
      ],
      content: 'Build it',
      sig: 'c'.repeat(128),
    };
    const projected = toRigEvent({
      kind: 'message',
      event,
      channelId: 'channel',
      content: event.content,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      id: event.id,
    } as BuzzSessionEvent);

    expect(projected.type).toBe('raw');
    expect((projected as { payload: { tags: string[][] } }).payload.tags).toEqual(event.tags);
  });
});

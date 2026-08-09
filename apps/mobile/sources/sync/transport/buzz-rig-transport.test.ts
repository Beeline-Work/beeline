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

  it('projects readable ACP message content instead of the raw JSON envelope', () => {
    const content = JSON.stringify({
      sessionId: 'ses_123',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'The work is complete.' },
      },
      projected: true,
    });
    const projected = toRigEvent({
      kind: 'agent-activity',
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      content,
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'activity-one',
    });

    expect(projected).toMatchObject({
      type: 'assistant_delta',
      id: 'activity-one',
      text: 'The work is complete.',
    });
  });

  it('extracts nested ACP tool output and keeps same-second events uniquely keyed', () => {
    const content = JSON.stringify({
      sessionId: 'ses_123',
      update: {
        sessionUpdate: 'tool_call_update',
        content: [
          { type: 'content', content: { type: 'text', text: 'LOOP_PROOF.md created' } },
        ],
      },
      projected: true,
    });
    const base = {
      kind: 'agent-activity' as const,
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      content,
      pubkey: 'a'.repeat(64),
      createdAt: 42,
    };
    const first = toRigEvent({ ...base, id: 'activity-one' });
    const second = toRigEvent({ ...base, id: 'activity-two' });

    expect(first).toMatchObject({ text: 'LOOP_PROOF.md created', id: 'activity-one', seq: 42 });
    expect(second).toMatchObject({ id: 'activity-two', seq: 42 });
    expect((first as { id?: string }).id).not.toBe((second as { id?: string }).id);
  });

  it('suppresses metadata-only ACP envelopes and preserves legacy plain text', () => {
    const base = {
      kind: 'agent-activity' as const,
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
    };
    const metadata = toRigEvent({
      ...base,
      id: 'metadata',
      content: JSON.stringify({
        sessionId: 'ses_123',
        update: { sessionUpdate: 'session_info_update', _meta: { activeRunId: 'run_1' } },
        projected: true,
      }),
    });
    const legacy = toRigEvent({ ...base, id: 'legacy', content: 'agent is thinking' });

    expect(metadata).toMatchObject({ text: '' });
    expect(legacy).toMatchObject({ text: 'agent is thinking' });
  });
});

import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import {
  projectChatEvent,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';

const viewer = 'a'.repeat(64);
const agent = 'b'.repeat(64);
const cornerId = 'corner-uuid-in-tags-only';

function raw(id: string, content: string, tags: string[][], createdAt: number): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: { id, content, pubkey: agent, createdAt, tags: [['h', 'room'], ...tags] },
  };
}

function displaySequence(events: SessionEvent[]): ChatDisplayMessage[] {
  return events.reduce<ChatDisplayMessage[]>((messages, event) => {
    const projected = projectChatEvent(event, viewer);
    return projected.message ? upsertChatMessages(messages, [projected.message]) : messages;
  }, []);
}

describe('Buzz Room screen event projection', () => {
  it('renders a first-class assistant answer while hiding ordinary body controls', () => {
    const events = [
      raw(
        'session-control',
        'Agent session started (read-only) — session=opaque',
        [['t', 'body-control'], ['mode', 'readonly']],
        1,
      ),
      raw(
        'assistant-answer',
        'The scheduler uses a bounded LRU of ACP sessions.',
        [['t', 'agent-message']],
        2,
      ),
    ];

    expect(displaySequence(events)).toMatchObject([
      {
        id: 'assistant-answer',
        text: 'The scheduler uses a bounded LRU of ACP sessions.',
        isUser: false,
      },
    ]);
  });

  it('collapses starting → working → ready into one tappable card after reload', () => {
    const events = [
      raw(
        'starting',
        'Agent is starting work.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['agent', agent],
          ['request', 'request-id'],
          ['status', 'starting'],
        ],
        3,
      ),
      raw(
        'working',
        'Agent is working.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['agent', agent],
          ['request', 'request-id'],
          ['status', 'working'],
        ],
        3,
      ),
      raw(
        'ready',
        'Work is ready for review.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['agent', agent],
          ['request', 'request-id'],
          ['status', 'ready'],
        ],
        3,
      ),
    ];

    const backfill = displaySequence(events);
    const sameSecondReplay = displaySequence([...events].reverse());
    expect(backfill).toHaveLength(1);
    expect(backfill[0]).toMatchObject({
      id: `corner-${cornerId}`,
      text: 'Work is ready for review.',
      corner: { subchannelId: cornerId, agentPubkey: agent, status: 'ready' },
    });
    expect(sameSecondReplay).toEqual(backfill);
    expect(backfill[0]!.text).not.toContain(cornerId);
  });

  it('projects a delivery failure onto the existing parent Room card', () => {
    const messages = displaySequence([
      raw(
        'working',
        'Agent is working.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['status', 'working'],
        ],
        4,
      ),
      raw(
        'failed',
        'Delivery failed. Open corner for details.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['status', 'failed'],
        ],
        5,
      ),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: 'Delivery failed. Open corner for details.',
      corner: { status: 'failed' },
    });
  });

  it('uses the same display classification for backfill and live delivery', () => {
    const event = raw(
      'live-working',
      'Agent is working.',
      [
        ['t', 'body-control'],
        ['subchannel', cornerId],
        ['status', 'working'],
      ],
      6,
    );
    const backfill = projectChatEvent(event, viewer, false);
    const live = projectChatEvent(event, viewer, true);

    expect({ ...live.message, isNew: undefined }).toEqual({
      ...backfill.message,
      isNew: undefined,
    });
  });
});

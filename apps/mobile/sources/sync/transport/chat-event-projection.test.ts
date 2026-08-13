import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import {
  projectChatEvent,
  transcriptMessages,
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
        [
          ['t', 'body-control'],
          ['mode', 'readonly'],
        ],
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

  it('projects an attachment as URL metadata without inline file content', () => {
    const event = raw(
      'attachment',
      'Here it is.',
      [
        ['t', 'agent-message'],
        ['t', 'buzz-attachment'],
        [
          'imeta',
          'url https://relay.example/media/mushroom.png',
          'm image/png',
          'size 24000000',
          'thumb https://relay.example/media/mushroom-thumb.jpg',
          'dim 1024x1024',
        ],
        ['attachment', 'https://relay.example/media/mushroom.png', 'mushroom.png'],
      ],
      2,
    );

    expect(projectChatEvent(event, viewer).message).toMatchObject({
      text: 'Here it is.',
      attachments: [
        {
          url: 'https://relay.example/media/mushroom.png',
          name: 'mushroom.png',
          mimeType: 'image/png',
          size: 24_000_000,
          thumbnailUrl: 'https://relay.example/media/mushroom-thumb.jpg',
          width: 1024,
          height: 1024,
        },
      ],
    });
    expect(JSON.stringify(event.payload)).not.toContain('base64');
  });

  it('drives and clears the Room thinking indicator from read-only agent turns', () => {
    const working = raw(
      'turn-working',
      'Agent is thinking…',
      [
        ['t', 'body-control'],
        ['t', 'agent-turn'],
        ['request', 'chat-request'],
        ['agent', agent],
        ['mode', 'readonly'],
        ['status', 'working'],
      ],
      2,
    );
    const complete = raw(
      'turn-complete',
      'Agent reply complete.',
      [
        ['t', 'body-control'],
        ['t', 'agent-turn'],
        ['request', 'chat-request'],
        ['agent', agent],
        ['mode', 'readonly'],
        ['status', 'complete'],
      ],
      3,
    );

    expect(displaySequence([working])).toMatchObject([
      { id: 'agent-turn-chat-request', agentTurn: { status: 'working' } },
    ]);
    const completed = displaySequence([working, complete]);
    expect(completed).toMatchObject([
      { id: 'agent-turn-chat-request', agentTurn: { status: 'complete' } },
    ]);
    expect(transcriptMessages(completed, false)).toEqual([]);
    expect(displaySequence([complete, working])).toEqual(completed);
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
          ['status', 'open'],
          ['display-status', 'starting'],
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

  it('projects write permission request and response into one stable prompt', () => {
    const permissionId = 'permission-1';
    const request = raw(
      'permission-request',
      'Lina wants to start editing files — allow?',
      [
        ['t', 'body-control'],
        ['t', 'buzz-write-permission-request'],
        ['permission', permissionId],
        ['request', 'human-request'],
        ['agent', agent],
        ['tool', 'str_replace README.md'],
        ['status', 'pending'],
      ],
      7,
    );
    const response = raw(
      'permission-response',
      'Allowed editing.',
      [
        ['t', 'buzz-write-permission-response'],
        ['permission', permissionId],
        ['request', 'human-request'],
        ['p', agent],
        ['decision', 'allow'],
      ],
      8,
    );
    const acknowledged = raw(
      'permission-acknowledged',
      'Editing allowed. Opening an isolated corner and worktree.',
      [
        ['t', 'body-control'],
        ['t', 'buzz-write-permission-request'],
        ['permission', permissionId],
        ['request', 'human-request'],
        ['agent', agent],
        ['tool', 'str_replace README.md'],
        ['status', 'allowed'],
        ['subchannel', cornerId],
      ],
      9,
    );

    const pending = projectChatEvent(request, viewer).message;
    expect(pending).toMatchObject({
      id: `write-permission-${permissionId}`,
      writePermission: {
        permissionId,
        requestId: 'human-request',
        agentPubkey: agent,
        tool: 'str_replace README.md',
        status: 'pending',
      },
    });
    expect(projectChatEvent(response, viewer)).toEqual({});
    expect(displaySequence([request, response, acknowledged])).toMatchObject([
      {
        id: `write-permission-${permissionId}`,
        writePermission: {
          tool: 'str_replace README.md',
          status: 'allowed',
          subchannelId: cornerId,
        },
      },
    ]);
    expect(displaySequence([acknowledged, request])).toMatchObject([
      {
        writePermission: { status: 'allowed', subchannelId: cornerId },
      },
    ]);
  });

  it('keeps telemetry, merge dumps, and lifecycle notices out of the Room', () => {
    const conversation: ChatDisplayMessage = {
      id: 'answer',
      text: 'The fix is ready.',
      isUser: false,
      timestamp: 1,
    };
    const activity: ChatDisplayMessage = {
      id: 'activity',
      text: 'rg -n scheduler',
      isUser: false,
      timestamp: 2,
      isAgentActivity: true,
    };
    const merge: ChatDisplayMessage = {
      id: 'merge',
      text: 'Merge summary — files changed',
      isUser: false,
      timestamp: 3,
      isMergeSummary: true,
    };
    const lifecycle: ChatDisplayMessage = {
      id: 'archived',
      text: 'corner archived',
      isUser: false,
      timestamp: 4,
      isArchivedNotice: true,
    };
    const corner: ChatDisplayMessage = {
      id: 'corner-1',
      text: 'Agent is working.',
      isUser: false,
      timestamp: 5,
      corner: { subchannelId: 'corner-1', status: 'working' },
    };

    expect(transcriptMessages([conversation, activity, merge, lifecycle, corner], false)).toEqual([
      conversation,
      corner,
    ]);
    expect(
      transcriptMessages([conversation, activity, merge, lifecycle, corner], true),
    ).toHaveLength(5);
  });
});

import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import {
  agentActivityDetails,
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

/** A live `#t=agent-draft` (kind 30078) delivery, shaped like the real relay event. */
function draft(id: string, text: string, requestId: string, createdAt: number): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: {
      id,
      content: text,
      pubkey: agent,
      createdAt,
      tags: [
        ['h', 'room'],
        ['d', 'agent-draft:room'],
        ['t', 'agent-draft'],
        ['agent', agent],
        ['session', 'session-1'],
        ['request', requestId],
      ],
    },
  };
}

function displaySequence(events: SessionEvent[]): ChatDisplayMessage[] {
  return events.reduce<ChatDisplayMessage[]>((messages, event) => {
    const projected = projectChatEvent(event, viewer);
    return projected.message ? upsertChatMessages(messages, [projected.message]) : messages;
  }, []);
}

describe('Buzz Room screen event projection', () => {
  it('projects corner process state without a transcript row', () => {
    const event = raw('state', 'waiting', [['t', 'body-control'], ['t', 'corner-session'], ['session', 'logical'], ['agent', agent], ['status', 'waiting-for-slot'], ['sequence', '2']], 1);
    const message = projectChatEvent(event, viewer).message!;
    expect(message.cornerProcess).toMatchObject({ state: 'waiting-for-slot', sequence: 2 });
    expect(transcriptMessages([message], true)).toEqual([]);
  });
  it('withdraws a stale merge target when Body reports uncommitted work', () => {
    expect(
      projectChatEvent(
        raw(
          'merge-not-ready',
          'Nothing ready to merge yet.',
          [
            ['t', 'body-control'],
            ['t', 'merge-not-ready'],
            ['status', 'needs-attention'],
          ],
          1,
        ),
        viewer,
      ),
    ).toMatchObject({ clearMergeTarget: true });
  });

  it('decodes percent escapes at the single funnel every surface reads through', () => {
    // `%3F` was reaching the slab literally. It decodes here rather than at a
    // dozen render sites, so the transcript and the Room-list preview agree.
    expect(
      projectChatEvent(
        raw('escaped', 'Should I rebase onto the new tip%3F', [['t', 'agent-message']], 1),
        viewer,
      ).message,
    ).toMatchObject({ text: 'Should I rebase onto the new tip?' });

    // ...including the streaming draft, which never passes through eventText.
    expect(
      projectChatEvent(draft('d1', 'Reading the scheduler%E2%80%A6', 'req-1', 2), viewer).message,
    ).toMatchObject({ text: 'Reading the scheduler…' });

    // A bare percent sign is not an escape and survives untouched.
    expect(
      projectChatEvent(
        raw('percent', 'Coverage is at 100% on that path.', [['t', 'agent-message']], 3),
        viewer,
      ).message,
    ).toMatchObject({ text: 'Coverage is at 100% on that path.' });
  });

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
        isAgentAuthor: true,
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

  it('preserves a NIP-10 reply target for conversational rendering', () => {
    const event = raw(
      'reply',
      '@Agent Can you expand on that?',
      [
        ['p', agent],
        ['e', 'original-agent-message', '', 'reply'],
      ],
      3,
    );

    expect(projectChatEvent(event, viewer).message).toMatchObject({
      id: 'reply',
      replyToId: 'original-agent-message',
    });
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
        ['generation', 'daemon-generation'],
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
      {
        id: 'agent-turn-chat-request',
        agentTurn: { status: 'working', generationId: 'daemon-generation' },
      },
    ]);
    const completed = displaySequence([working, complete]);
    expect(completed).toMatchObject([
      { id: 'agent-turn-chat-request', agentTurn: { status: 'complete' } },
    ]);
    expect(transcriptMessages(completed, false)).toEqual([]);
    expect(displaySequence([complete, working])).toEqual(completed);
  });

  it('projects presence as state without adding a transcript message', () => {
    const event = raw(
      'presence-online',
      'Agent online.',
      [
        ['t', 'body-control'],
        ['t', 'agent-presence'],
        ['agent', agent],
        ['status', 'online'],
      ],
      1_700_000_000,
    );

    expect(projectChatEvent(event, viewer)).toEqual({
      agentPresence: {
        agentPubkey: agent,
        status: 'online',
        observedAt: 1_700_000_000_000,
      },
    });
    expect(displaySequence([event])).toEqual([]);
  });

  it('coalesces activity only inside a turn and keeps final answers as separate units', () => {
    const thinkingOne: ChatDisplayMessage = {
      id: 'activity-1',
      text: 'Planning',
      isUser: false,
      isAgentActivity: true,
      activity: [{ kind: 'thinking', title: 'Thinking', text: '**Planning**' }],
      timestamp: 1,
    };
    const toolOne: ChatDisplayMessage = {
      id: 'activity-2',
      text: 'Read file',
      isUser: false,
      isAgentActivity: true,
      activity: [{ kind: 'tool', title: 'read apps/body/src/body.ts' }],
      timestamp: 2,
    };
    const firstFinal: ChatDisplayMessage = {
      id: 'final-1',
      text: 'First paragraph.\n\nSecond paragraph.',
      isUser: false,
      timestamp: 3,
    };
    const thinkingTwo: ChatDisplayMessage = {
      id: 'activity-3',
      text: 'Verifying',
      isUser: false,
      isAgentActivity: true,
      activity: [{ kind: 'thinking', title: 'Thinking', text: '**Verifying**' }],
      timestamp: 4,
    };
    const nextLifecycle: ChatDisplayMessage = {
      id: 'agent-turn-next',
      text: 'Agent is thinking…',
      isUser: false,
      timestamp: 3.5,
      agentTurn: { requestId: 'next', agentPubkey: agent, status: 'working' },
    };
    const secondFinal: ChatDisplayMessage = {
      id: 'final-2',
      text: 'Tests pass. The boundary remains intact.',
      isUser: false,
      timestamp: 5,
    };
    const lifecycle: ChatDisplayMessage = {
      id: 'agent-turn-2',
      text: 'Agent reply complete.',
      isUser: false,
      timestamp: 6,
      agentTurn: { requestId: '2', agentPubkey: agent, status: 'complete' },
    };

    const transcript = transcriptMessages(
      [thinkingOne, toolOne, firstFinal, nextLifecycle, thinkingTwo, secondFinal, lifecycle],
      true,
    );

    expect(transcript).toHaveLength(4);
    expect(transcript[0]).toMatchObject({
      id: 'activity-1',
      activity: [
        { kind: 'thinking', text: '**Planning**' },
        { kind: 'tool', title: 'read apps/body/src/body.ts' },
      ],
    });
    expect(transcript[1]).toEqual(firstFinal);
    expect(transcript[2]).toMatchObject({ id: 'activity-3' });
    expect(transcript[3]).toEqual(secondFinal);
  });

  it('uses agent-turn lifecycle as a hard boundary between activity runs', () => {
    const activity = (id: string, timestamp: number): ChatDisplayMessage => ({
      id,
      text: id,
      isUser: false,
      isAgentActivity: true,
      activity: [{ kind: 'thinking', title: 'Thinking', text: `**${id}**` }],
      timestamp,
    });
    const lifecycle: ChatDisplayMessage = {
      id: 'turn-boundary',
      text: 'Agent reply complete.',
      isUser: false,
      timestamp: 2,
      agentTurn: { requestId: 'one', agentPubkey: agent, status: 'complete' },
    };

    const transcript = transcriptMessages(
      [activity('one', 1), lifecycle, activity('two', 3)],
      true,
    );

    expect(transcript).toHaveLength(2);
    expect(transcript.map((message) => message.id)).toEqual(['one', 'two']);
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
      corner: { subchannelId: cornerId, agentPubkey: agent, status: 'open' },
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

  it('surfaces a corner-scoped delivery failure as a visible message, not a silently dropped event', () => {
    // Posted directly to the corner's own channel (no `subchannel` tag,
    // unlike the parent-Room status card above) by publishMergeReady's
    // push-failure, pollDirectRemoteApprovals's landing failure, or a
    // surfaced DurableMergeGate refusal — previously projected to `{}`
    // entirely, so neither a transcript bubble nor the approve button ever
    // learned the delivery had failed.
    const event = raw(
      'push-failed',
      'Feature push failed; merge approval is not available. connection refused',
      [
        ['t', 'body-control'],
        ['status', 'failed'],
        ['repo', 'ownerhex/project'],
        ['branch', 'refs/heads/main'],
        ['tip', 'a'.repeat(40)],
      ],
      10,
    );

    const projection = projectChatEvent(event, viewer);
    expect(projection.deliveryFailed).toBe(true);
    expect(projection.message).toMatchObject({
      id: 'push-failed',
      text: 'Feature push failed; merge approval is not available. connection refused',
    });
    expect(displaySequence([event])).toHaveLength(1);
  });

  it('carries the daemon’s own retry posture, and invents none when the daemon did not say', () => {
    // The screen used to hard-code "RETRYING AUTOMATICALLY" for every one of
    // these, which is a lie for a land nothing is re-attempting — the exact
    // reading that made a non-fast-forward refusal look like a dead end that
    // was also somehow still working on itself.
    const failure = (retry?: string) =>
      projectChatEvent(
        raw(
          `land-failed-${retry ?? 'none'}`,
          'Couldn’t land the approved change on main.',
          [
            ['t', 'body-control'],
            ['status', 'failed'],
            ...(retry ? [['retry', retry]] : []),
          ],
          11,
        ),
        viewer,
      );

    expect(failure('auto').deliveryRetry).toBe('auto');
    expect(failure('realigning').deliveryRetry).toBe('realigning');
    expect(failure('blocked').deliveryRetry).toBe('blocked');
    // Absent, or a value this client does not understand, is "unknown" — not
    // a default that lets the screen claim a retry nobody promised.
    expect(failure(undefined).deliveryRetry).toBeUndefined();
    expect(failure('sometime-maybe').deliveryRetry).toBeUndefined();
    expect(failure(undefined).deliveryFailed).toBe(true);
  });

  it('renders the daemon’s queued-steer acknowledgement as a quiet system line, not an agent turn', () => {
    // `postSteerQueuedNotice` (apps/body/src/activity.ts): the receipt for a
    // message sent while a turn was already running. It is a body-control
    // event, so before this branch existed it projected to `{}` — durably
    // published, invisible in the transcript, which is exactly the silence
    // that made a mid-turn steer read as swallowed.
    const event = raw(
      'steer-queued-1',
      'Got it — queued. I’ll pick this up as soon as the current step finishes.',
      [
        ['t', 'body-control'],
        ['t', 'steer-queued'],
        ['status', 'queued'],
        ['request', 'req-1'],
      ],
      12,
    );

    const projection = projectChatEvent(event, viewer);
    expect(projection.message).toMatchObject({
      id: 'steer-queued-1',
      isSystemNotice: true,
      isUser: false,
    });
    // Never an agent turn: it must not be attributed to the agent's voice.
    expect(projection.message?.isAgentAuthor).toBeUndefined();
    expect(projection.deliveryFailed).toBeUndefined();
    expect(displaySequence([event])).toHaveLength(1);
  });

  it('renders the daemon’s unknown-slash-command marker as a quiet system line', () => {
    // `postSlashCommandNotice` (apps/body/src/activity.ts): marks a message
    // that began with a slash verb Beeline does not run, so a harness's own
    // `/loop` vocabulary can no longer execute silently as if it were
    // Beeline's. Same shape as the queued-steer ack: body-control, system
    // line, never agent speech.
    const event = raw(
      'slash-notice-1',
      '/loop is not a Beeline command. Beeline understands: /open-corner, /approve, /change-target-branch, /add-agent, /invite, /close-corner — sent from the composer\'s slash menu. Your message was still passed to the agent as an ordinary request.',
      [
        ['t', 'body-control'],
        ['t', 'slash-command-notice'],
        ['command', 'loop'],
      ],
      13,
    );

    const projection = projectChatEvent(event, viewer);
    expect(projection.message).toMatchObject({
      id: 'slash-notice-1',
      isSystemNotice: true,
      isUser: false,
    });
    expect(projection.message?.text).toContain('/loop is not a Beeline command');
    expect(projection.message?.isAgentAuthor).toBeUndefined();
    expect(displaySequence([event])).toHaveLength(1);
  });

  it('does not confuse an archive notice or a parent-Room status card with a corner-scoped delivery failure', () => {
    // Archive notices also carry status=archived with no `subchannel` tag —
    // must not be misread as a delivery failure.
    expect(
      projectChatEvent(
        raw('archived', 'Subchannel archived.', [['t', 'body-control'], ['status', 'archived']], 1),
        viewer,
      ).deliveryFailed,
    ).toBeUndefined();
    // A parent-Room corner status card carries a `subchannel` tag and is
    // handled by the existing `corner` projection above, not this one.
    expect(
      projectChatEvent(
        raw(
          'parent-failed',
          'Delivery failed. Open corner for details.',
          [['t', 'body-control'], ['subchannel', cornerId], ['status', 'failed']],
          2,
        ),
        viewer,
      ).deliveryFailed,
    ).toBeUndefined();
  });

  it('replaces the parent Room card with an archived completion summary', () => {
    const messages = displaySequence([
      raw(
        'ready',
        'Work is ready for review.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['status', 'ready'],
        ],
        5,
      ),
      raw(
        'archived',
        'Implemented the fix and added regression tests.',
        [
          ['t', 'body-control'],
          ['subchannel', cornerId],
          ['status', 'archived'],
        ],
        6,
      ),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: `corner-${cornerId}`,
      text: 'Implemented the fix and added regression tests.',
      corner: { subchannelId: cornerId, status: 'archived' },
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
        ['repo', 'lunchboxfortwo/buzzy'],
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
        ['repo', 'lunchboxfortwo/buzzy'],
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
        ['repo', 'lunchboxfortwo/buzzy'],
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
        repository: 'lunchboxfortwo/buzzy',
        status: 'pending',
      },
    });
    expect(projectChatEvent(response, viewer)).toEqual({});
    expect(displaySequence([request, response, acknowledged])).toMatchObject([
      {
        id: `write-permission-${permissionId}`,
        writePermission: {
          tool: 'str_replace README.md',
          repository: 'lunchboxfortwo/buzzy',
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
      corner: { subchannelId: 'corner-1', status: 'live' },
    };
    const archivedCorner: ChatDisplayMessage = {
      id: 'corner-2',
      text: 'Implemented the fix and added regression tests.',
      isUser: false,
      timestamp: 6,
      corner: { subchannelId: 'corner-2', status: 'archived' },
    };

    // Live status is state and stays out of both transcripts. The archived
    // parent card is durable history because its text is the completion
    // summary Body wrote when it closed the corner.
    expect(
      transcriptMessages([conversation, activity, merge, lifecycle, corner, archivedCorner], false),
    ).toEqual([conversation, archivedCorner]);
    expect(
      transcriptMessages([conversation, activity, merge, lifecycle, corner, archivedCorner], true),
    ).toEqual([conversation, merge, lifecycle]);
  });

  it('streams a Room reply into one bubble that fills in place and finalizes without a second bubble', () => {
    const requestId = 'human-ask-1';

    // Streaming deltas arrive as live `#t=agent-draft` events, growing text.
    const afterFirstDelta = displaySequence([draft('draft-1', 'Hel', requestId, 10)]);
    expect(afterFirstDelta).toHaveLength(1);
    expect(afterFirstDelta[0]).toMatchObject({
      id: `agent-draft-${requestId}`,
      text: 'Hel',
      isAgentAuthor: true,
      isAgentDraft: true,
    });
    expect(afterFirstDelta[0]!.relayId).toBeUndefined();

    const afterMoreDeltas = displaySequence([
      draft('draft-1', 'Hel', requestId, 10),
      draft('draft-2', 'Hello wor', requestId, 10),
      draft('draft-3', 'Hello world!', requestId, 10),
    ]);
    // Still exactly one bubble in the transcript — no separate banner element
    // and no second bubble as the text keeps growing.
    expect(afterMoreDeltas).toHaveLength(1);
    expect(afterMoreDeltas[0]).toMatchObject({
      id: `agent-draft-${requestId}`,
      text: 'Hello world!',
      isAgentDraft: true,
    });
    expect(transcriptMessages(afterMoreDeltas, false)).toHaveLength(1);

    // The turn's final answer replies to the human's own request event —
    // the same id Body threads through the draft/turn `request` tag.
    const final = raw(
      'final-relay-event-id',
      'Hello world!',
      [
        ['t', 'agent-message'],
        ['e', requestId, '', 'reply'],
      ],
      11,
    );
    const settled = upsertChatMessages(afterMoreDeltas, [projectChatEvent(final, viewer, true).message!]);

    // The final reply reconciles onto the SAME bubble id in place — bubble
    // count does not increase, and it is no longer marked provisional.
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      id: `agent-draft-${requestId}`,
      text: 'Hello world!',
      isAgentAuthor: true,
      relayId: 'final-relay-event-id',
    });
    expect(settled[0]!.isAgentDraft).toBeUndefined();
    expect(settled[0]!.isNew).toBeUndefined();

    // A late-delivered draft flush for the same request (the draft and the
    // final message arrive over independent subscriptions with no ordering
    // guarantee) must not regress the finalized bubble back to provisional.
    const afterStaleDraft = upsertChatMessages(settled, [
      projectChatEvent(draft('draft-3', 'Hello world!', requestId, 10), viewer).message!,
    ]);
    expect(afterStaleDraft).toEqual(settled);
  });

  it('never lets a second agent message on the same request replace the first', () => {
    // Reconciliation exists for one draft becoming one final message. But a
    // turn can publish more than one `#t=agent-message` answering the same
    // request — the honest "still working on this" stall notice and then the
    // reply itself — and they all claim the same `agent-draft-<parent>` id.
    // In the captain's Room that is 13 of 50 reply-parents, and every later
    // message silently replaced the earlier one.
    const requestId = 'human-request-id';
    const stall = projectChatEvent(
      raw(
        'stall-relay-id',
        'Still working on this — my coding backend is taking longer than usual to respond.',
        [
          ['t', 'agent-message'],
          ['e', requestId, '', 'reply'],
        ],
        20,
      ),
      viewer,
      true,
    ).message!;
    const answer = projectChatEvent(
      raw(
        'answer-relay-id',
        'Found it — the misdiagnosis was upstream, in the daemon.',
        [
          ['t', 'agent-message'],
          ['e', requestId, '', 'reply'],
        ],
        21,
      ),
      viewer,
      true,
    ).message!;

    const transcript = upsertChatMessages(upsertChatMessages([], [stall]), [answer]);

    expect(transcript).toHaveLength(2);
    expect(transcript.map((message) => message.relayId ?? message.id)).toEqual([
      'stall-relay-id',
      'answer-relay-id',
    ]);
    // Redelivery of the same event is still an update in place, not a third
    // bubble: it carries the same relayId.
    expect(upsertChatMessages(transcript, [answer])).toHaveLength(2);
  });
});

describe('agent activity projection', () => {
  it('keeps the observational tool-call tally that only rides the summary event', () => {
    // Body deliberately never projects a read or a search as its own event —
    // that would blow the per-pubkey relay quota on a research-heavy turn — so
    // this tally is the single wire record that those calls happened at all.
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: {
            sessionUpdate: 'activity_summary',
            content: { type: 'text', text: 'Edited stats.py' },
            rollup: { read: 41, searched: 12 },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'summary',
        title: 'Summary',
        text: 'Edited stats.py',
        rollup: { read: 41, searched: 12 },
      },
    ]);
  });

  it("carries the agent's plan on the summary event, with no other content", () => {
    // Body publishes a plan change on the receipt event it was already
    // sending, so the corner's pinned objective panel costs no extra relay
    // write. A plan-only receipt carries nothing else at all.
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: {
            sessionUpdate: 'activity_summary',
            content: { type: 'text', text: '' },
            plan: {
              objective: 'Colour the code blocks',
              items: [
                { step: 'Find the renderer', status: 'completed' },
                { step: 'Wire the highlighter', status: 'in_progress' },
              ],
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'summary',
        title: 'Summary',
        plan: {
          objective: 'Colour the code blocks',
          items: [
            { step: 'Find the renderer', status: 'completed' },
            { step: 'Wire the highlighter', status: 'in_progress' },
          ],
        },
      },
    ]);
  });

  it('carries the compact per-call receipt that backs the review sheet\'s real detail', () => {
    // Body's `observed` array is the only source of per-call detail for a
    // folded call — the calls themselves never earn their own wire event, so
    // without this the review sheet has nothing beyond the tally to show.
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: {
            sessionUpdate: 'activity_summary',
            content: { type: 'text', text: '' },
            rollup: { read: 1, ran: 1 },
            observed: [
              { verb: 'read', target: 'src/foo.ts', result: 'export function foo() {}' },
              { verb: 'ran', target: 'npm test -- --run' },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'summary',
        title: 'Summary',
        rollup: { read: 1, ran: 1 },
        observed: [
          { verb: 'read', target: 'src/foo.ts', result: 'export function foo() {}' },
          { verb: 'ran', target: 'npm test -- --run' },
        ],
      },
    ]);
  });

  it('drops a malformed observed entry rather than rendering a verbless row', () => {
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: {
            sessionUpdate: 'activity_summary',
            content: { type: 'text', text: '' },
            rollup: { read: 1 },
            observed: [{ target: 'src/foo.ts' }, { verb: 'read', target: 'src/foo.ts' }],
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'summary',
        title: 'Summary',
        rollup: { read: 1 },
        observed: [{ verb: 'read', target: 'src/foo.ts' }],
      },
    ]);
  });

  it('carries a reads-only batch, which used to project as nothing at all', () => {
    // No major action means no summary text, and the whole batch used to be
    // dropped — the corner went silent during the exact stretch the agent was
    // working hardest. The tally alone is enough to keep the turn legible.
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: { sessionUpdate: 'activity_summary', content: { type: 'text', text: '' }, rollup: { read: 8 } },
        }),
      ),
    ).toEqual([{ kind: 'summary', title: 'Summary', rollup: { read: 8 } }]);
  });

  it('carries the reasoning receipt, and projects a batch that is only a receipt', () => {
    // The reasoning text itself never reaches the wire. The span does, and it
    // is enough on its own to be worth a row — a turn that spent eight seconds
    // thinking and nothing else still happened.
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: { sessionUpdate: 'activity_summary', content: { type: 'text', text: '' }, thoughtMs: 8_200 },
        }),
      ),
    ).toEqual([{ kind: 'summary', title: 'Summary', thoughtMs: 8_200 }]);
  });

  it('ignores a malformed or empty reasoning span rather than rendering a zero', () => {
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: { sessionUpdate: 'activity_summary', content: { type: 'text', text: '' }, thoughtMs: 0 },
        }),
      ),
    ).toEqual([]);
    expect(
      agentActivityDetails(
        JSON.stringify({
          update: { sessionUpdate: 'activity_summary', content: { type: 'text', text: '' }, thoughtMs: 'soon' },
        }),
      ),
    ).toEqual([]);
  });

  it('never mistakes the agent’s own prose for a tool receipt', () => {
    // `progress_update` is the agent narrating, so it projects as `output` —
    // the kind the corner renders on the slab rather than folding away.
    expect(
      agentActivityDetails(
        JSON.stringify({ update: { sessionUpdate: 'progress_update', text: 'Both bugs are fixed.' } }),
      ),
    ).toEqual([{ kind: 'output', title: 'Update', text: 'Both bugs are fixed.' }]);
  });
});

describe('a merge-ready tip that has a preview deployment', () => {
  function mergeReady(tags: string[][]): SessionEvent {
    return raw(
      'merge-ready-1',
      'Work is ready for human merge approval — abc123def456…',
      [
        ['t', 'body-control'],
        ['t', 'merge-ready'],
        ['status', 'ready'],
        ['repo', 'owner/repo'],
        ['branch', 'refs/heads/main'],
        ['tip', 'c'.repeat(40)],
        ['agent', agent],
        ...tags,
      ],
      1_000,
    );
  }

  it('carries the preview URL alongside the merge target', () => {
    const projected = projectChatEvent(
      mergeReady([['preview', 'https://repo-git-feature.vercel.app']]),
      viewer,
    );
    expect(projected.mergeTarget).toEqual({
      repo: 'owner/repo',
      branch: 'refs/heads/main',
      tip: 'c'.repeat(40),
    });
    expect(projected.previewUrl).toBe('https://repo-git-feature.vercel.app');
    // Never folded INTO the signed approval binding.
    expect(projected.mergeTarget).not.toHaveProperty('preview');
  });

  it('has no preview when the daemon published no tag', () => {
    expect(projectChatEvent(mergeReady([]), viewer).previewUrl).toBeUndefined();
  });

  it('drops a preview tag that is not an https URL', () => {
    for (const value of ['javascript:alert(1)', 'http://insecure.example', 'not a url', '']) {
      expect(
        projectChatEvent(mergeReady([['preview', value]]), viewer).previewUrl,
        value,
      ).toBeUndefined();
    }
  });

  it('never attaches a preview to an event that is not merge-ready', () => {
    const projected = projectChatEvent(
      raw(
        'not-ready',
        'Nothing ready to merge yet.',
        [
          ['t', 'body-control'],
          ['t', 'merge-not-ready'],
          ['status', 'needs-attention'],
          ['preview', 'https://stale.example'],
        ],
        1_001,
      ),
      viewer,
    );
    expect(projected.previewUrl).toBeUndefined();
    expect(projected.clearMergeTarget).toBe(true);
  });
});

describe('a proposed target-branch change', () => {
  const requester = 'd'.repeat(64);

  function proposal(tags: string[][]): SessionEvent {
    return raw(
      'proposal-1',
      'Change target branch: main → staging',
      [
        ['t', 'body-control'],
        ['t', 'buzz-target-branch-proposal'],
        ['agent', agent],
        ['requester', requester],
        ['repo', 'owner/repo'],
        ...tags,
      ],
      2_000,
    );
  }

  it('projects a card carrying both ends of the change', () => {
    const projected = projectChatEvent(
      proposal([
        ['from', 'main'],
        ['to', 'staging'],
      ]),
      viewer,
    );
    expect(projected.message?.targetBranchProposal).toEqual({
      proposalId: 'proposal-1',
      from: 'main',
      to: 'staging',
      repository: 'owner/repo',
      agentPubkey: agent,
      requesterPubkey: requester,
    });
    expect(projected.message?.text).toBe('Change target branch: main → staging');
    // A proposal is never a merge target and never archives anything.
    expect(projected.mergeTarget).toBeUndefined();
    expect(projected.archiveChannel).toBeUndefined();
  });

  it('renders nothing for a malformed proposal rather than a half card', () => {
    expect(projectChatEvent(proposal([['from', 'main']]), viewer).message).toBeUndefined();
    expect(projectChatEvent(proposal([['to', 'staging']]), viewer).message).toBeUndefined();
  });

  it('survives the transcript filter, since it is something to act on', () => {
    const projected = projectChatEvent(
      proposal([
        ['from', 'main'],
        ['to', 'staging'],
      ]),
      viewer,
    );
    expect(transcriptMessages([projected.message!])).toHaveLength(1);
    expect(transcriptMessages([projected.message!])[0]!.targetBranchProposal?.to).toBe('staging');
  });
});

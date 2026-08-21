import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/sync/transport';
import {
  projectChatEvent,
  transcriptMessages,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';
import { latestRoomMessage, latestRoomMessageSummary } from './room-list-summary';
import { roomRowPresentation } from './room-list-row';
import {
  RETIRED_AGENT_STATE_NOTICES,
  isRetiredAgentStateNotice,
} from './retired-agent-notices';

const viewer = 'a'.repeat(64);
const agent = 'b'.repeat(64);

function agentMessage(id: string, content: string, createdAt: number, replyTo?: string): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: {
      id,
      content,
      pubkey: agent,
      createdAt,
      tags: [
        ['h', 'room'],
        ['t', 'agent-message'],
        ...(replyTo ? [['e', replyTo, '', 'reply']] : []),
      ],
    },
  };
}

function humanMessage(id: string, content: string, createdAt: number): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: { id, content, pubkey: viewer, createdAt, tags: [['h', 'room']] },
  };
}

function display(events: SessionEvent[]): ChatDisplayMessage[] {
  return events.reduce<ChatDisplayMessage[]>((messages, event) => {
    const projected = projectChatEvent(event, viewer);
    return projected.message ? upsertChatMessages(messages, [projected.message]) : messages;
  }, []);
}

/**
 * The captain's live Room, reconstructed from what it actually held: the
 * daemon republished `relay-disconnected` on every restart, so ~17 restarts in
 * one day left the same sentence stacked through the transcript, interleaved
 * with the real conversation.
 */
const CAPTAIN_WALL: SessionEvent[] = (() => {
  const events: SessionEvent[] = [humanMessage('human-1', 'how is the corner going?', 1_000)];
  for (let restart = 0; restart < 17; restart += 1) {
    events.push(
      agentMessage(
        `wall-${restart}`,
        'I lost my connection to the relay — reconnecting.',
        1_100 + restart,
      ),
    );
  }
  events.push(agentMessage('real-1', 'The corner is on the rebase now.', 1_200, 'human-1'));
  // The other four retired states, each of which could also stack.
  events.push(
    agentMessage('wall-auth', "I can't reach my model — my host's credentials need a refresh.", 1_300),
    agentMessage('wall-harness', "My coding backend won't start — the host may need attention.", 1_301),
    agentMessage('wall-repo', "I can't get to this room's repo — check the repo link or my access.", 1_302),
    agentMessage('wall-rate', "I've hit a usage limit for now.", 1_303),
  );
  return events;
})();

describe('the retired daemon state notices never reach a person', () => {
  it('recognizes every sentence the deleted daemon feature could publish', () => {
    expect(RETIRED_AGENT_STATE_NOTICES).toHaveLength(5);
    for (const notice of RETIRED_AGENT_STATE_NOTICES) {
      expect(isRetiredAgentStateNotice(notice)).toBe(true);
      // A relay round-trip can leave surrounding whitespace on the content.
      expect(isRetiredAgentStateNotice(`\n${notice}  `)).toBe(true);
    }
  });

  it("renders the captain's wall transcript with none of it left", () => {
    const messages = display(CAPTAIN_WALL);

    for (const notice of RETIRED_AGENT_STATE_NOTICES) {
      expect(messages.some((message) => message.text.includes(notice))).toBe(false);
    }
    // The real conversation on either side of the wall survives intact.
    expect(messages.map((message) => message.text)).toEqual([
      'how is the corner going?',
      'The corner is on the rebase now.',
    ]);
    // …and so does the transcript surface built on top of the projection.
    const rendered = transcriptMessages(messages);
    expect(rendered.map((message) => message.text)).toEqual([
      'how is the corner going?',
      'The corner is on the rebase now.',
    ]);
  });

  it('never lets a wall notice claim a real turn\'s reconciled bubble', () => {
    // A state notice carried a NIP-10 reply-to, so it projects onto the same
    // `agent-draft-<parent>` id the turn's real answer reconciles into. Left in
    // the transcript it would not merely add a row — it would take one.
    const messages = display([
      humanMessage('ask', 'are you there?', 2_000),
      agentMessage('notice', 'I lost my connection to the relay — reconnecting.', 2_001, 'ask'),
      agentMessage('answer', 'Yes — reading the diff now.', 2_002, 'ask'),
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      'are you there?',
      'Yes — reading the diff now.',
    ]);
  });

  it('keeps a real answer that merely quotes one of the sentences', () => {
    const text = "I've hit a usage limit for now. That means the rebase has to wait an hour.";
    const messages = display([agentMessage('real', text, 3_000)]);
    expect(messages.map((message) => message.text)).toEqual([text]);
  });

  it('never advertises a wall notice as a Room\'s latest word', () => {
    expect(latestRoomMessage(CAPTAIN_WALL)).toBe('The corner is on the rebase now.');
    expect(latestRoomMessageSummary(CAPTAIN_WALL)?.id).toBe('real-1');
  });

  it('drops a wall notice already stored as a Room-list preview', () => {
    const row = roomRowPresentation(
      { latestMessage: 'I lost my connection to the relay — reconnecting.' },
      new Map(),
    );
    expect(row.fact).not.toContain('lost my connection');
  });
});

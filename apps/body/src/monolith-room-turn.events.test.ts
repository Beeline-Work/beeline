import { describe, expect, it } from 'vitest';
import { SCHEDULE_RAN_VERB, SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { formatGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import {
  inboxItemAuthorName,
  inboxItemPromptBody,
  isScheduledPrompt,
} from './monolith-room-turn.js';

const AGENT = 'a'.repeat(64);
const OTHER_AGENT = 'b'.repeat(64);
const NEWCOMER = 'c'.repeat(64);
const OWNER = 'd'.repeat(64);

/**
 * An event line is a system line the SERVER authored, carrying a machine
 * `kind` beside its prose verb. A subscriber hears it because the server put
 * it in the line's mentions; a daemon acts on it because of the kind, never
 * because of the wording.
 */
const line = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    authorId: NEWCOMER,
    createdAt: 0,
    type: 'system',
    body: 'Ada joined',
    systemEvent: {
      subject: { kind: 'person', id: NEWCOMER, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    },
    mentionIds: [AGENT],
    attachments: [],
    ...over,
  }) as import('@beeline/api-contract/daemon').RoomInboxResult['items'][number];

describe('an event line that woke a subscriber', () => {
  it('shows the harness the line as written, so the greeting has a name', () => {
    expect(inboxItemPromptBody(line(), AGENT)).toBe('Ada joined');
  });

  it('names the newcomer from the event, not from a roster read before they arrived', () => {
    // The roster this turn was built from predates the arrival, so a lookup by
    // author id finds nothing — and a greeting addressed to a truncated public
    // key is not a greeting.
    expect(inboxItemAuthorName(line(), AGENT, new Map())).toBe('Ada');
    // An ordinary message still reads its author from the roster, and falls
    // back to the short key when even that is unknown.
    const message = line({ type: 'message', systemEvent: undefined, body: 'hello' });
    expect(inboxItemAuthorName(message, AGENT, new Map([[NEWCOMER, 'Ada']]))).toBe('Ada');
    expect(inboxItemAuthorName(message, AGENT, new Map())).toBe(NEWCOMER.slice(0, 12));
  });

  it('prompts an agent-emitted event with the whole sentence, so the reader sees WHO said it', () => {
    // A6: an agent event's payload is the formatted line, not the bare
    // consequence. A model handed "the branch is ready" and nothing else
    // cannot tell which agent it is answering.
    const emitted = line({
      authorId: OTHER_AGENT,
      body: 'Bee emitted handoff · the branch is ready',
      systemEvent: {
        subject: { kind: 'agent', id: OTHER_AGENT, name: 'Bee' },
        verb: 'emitted',
        object: { text: 'handoff' },
        consequence: 'the branch is ready',
        kind: 'agent:handoff',
      },
    });
    expect(inboxItemPromptBody(emitted, AGENT)).toBe('Bee emitted handoff · the branch is ready');
    expect(inboxItemAuthorName(emitted, AGENT, new Map())).toBe('Bee');
  });
});

describe('a scheduled prompt across the kind cutover', () => {
  const scheduled = (over: Record<string, unknown> = {}) =>
    line({
      authorId: SCHEDULE_SCHEDULER_ID,
      body: 'Beeline Scheduler ran a schedule for Bee · ping',
      systemEvent: {
        subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: 'Beeline Scheduler' },
        verb: SCHEDULE_RAN_VERB,
        object: { text: 'Bee', id: AGENT },
        consequence: 'ping',
        kind: 'schedule-ran',
      },
      ...over,
    });

  it('is not a scheduled prompt when the kind says it is something else', () => {
    // A kind, once present, is the answer: the verb no longer gets a vote.
    const mislabelled = scheduled({
      systemEvent: {
        subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: 'Beeline Scheduler' },
        verb: SCHEDULE_RAN_VERB,
        consequence: 'ping',
        kind: 'joined',
      },
    });
    expect(isScheduledPrompt(mislabelled, AGENT)).toBe(false);
    expect(inboxItemPromptBody(mislabelled, AGENT)).toBe(
      'Beeline Scheduler ran a schedule for Bee · ping',
    );
  });
});

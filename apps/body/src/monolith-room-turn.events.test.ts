import { describe, expect, it } from 'vitest';
import { SCHEDULE_RAN_VERB, SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { formatGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import {
  inboxItemPromptBody,
  inboxItemSkipsSenderPolicy,
  inboxItemTriggersTurn,
  isGrantDecisionLine,
  isScheduledPrompt,
  isSubscribedEvent,
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
  }) as Parameters<typeof inboxItemTriggersTurn>[0];

describe('an event line that woke a subscriber', () => {
  it('starts a turn for the agent it mentions', () => {
    expect(isSubscribedEvent(line(), AGENT)).toBe(true);
    expect(inboxItemTriggersTurn(line(), AGENT)).toBe(true);
  });

  it('leaves an agent it does not mention asleep', () => {
    expect(isSubscribedEvent(line(), OTHER_AGENT)).toBe(false);
    expect(inboxItemTriggersTurn(line(), OTHER_AGENT)).toBe(false);
    expect(inboxItemTriggersTurn(line({ mentionIds: [] }), AGENT)).toBe(false);
  });

  it('reads the kind, never the wording', () => {
    // The same sentence with no kind is an ordinary system line.
    expect(
      inboxItemTriggersTurn(
        line({ systemEvent: { subject: { kind: 'person', name: 'Ada' }, verb: 'joined' } }),
        AGENT,
      ),
    ).toBe(false);
    // A reworded verb under the same kind still triggers: verbs are prose.
    expect(
      inboxItemTriggersTurn(
        line({
          body: 'Ada arrived',
          systemEvent: { subject: { kind: 'person', name: 'Ada' }, verb: 'arrived', kind: 'joined' },
        }),
        AGENT,
      ),
    ).toBe(true);
  });

  it('never wakes an agent on its own row', () => {
    expect(inboxItemTriggersTurn(line({ authorId: AGENT }), AGENT)).toBe(false);
  });

  it('shows the harness the line as written, so the greeting has a name', () => {
    expect(inboxItemPromptBody(line(), AGENT)).toBe('Ada joined');
  });

  it('skips the per-sender policy, because the server authored the fact', () => {
    // CRITICAL (C1): the join line's author is the NEWCOMER, and the default
    // `creator` access policy would refuse them — a greeter gated on the
    // sender never wakes for the very people it exists to greet.
    expect(inboxItemSkipsSenderPolicy(line(), AGENT)).toBe(true);
  });

  it('keeps an agent-emitted kind gated on its emitter', () => {
    const emitted = line({
      authorId: OTHER_AGENT,
      systemEvent: {
        subject: { kind: 'agent', id: OTHER_AGENT, name: 'Bee' },
        verb: 'handed off',
        kind: 'agent:handoff',
      },
    });
    expect(inboxItemTriggersTurn(emitted, AGENT)).toBe(true);
    expect(inboxItemSkipsSenderPolicy(emitted, AGENT)).toBe(false);
  });
});

describe('the kinds that must not start a turn', () => {
  const decision = formatGrantDecisionLine({
    deciderName: 'Ada',
    decision: 'always',
    kind: 'command',
    target: 'npm test',
  });
  const grantLine = () =>
    line({
      authorId: OWNER,
      body: decision,
      systemEvent: {
        subject: { kind: 'person', id: OWNER, name: 'Ada' },
        verb: 'approved',
        kind: 'grant-decided',
      },
    });

  it('leaves a grant decision to its own resume path, not the event path (CRITICAL)', () => {
    // The decision reaches the loop exactly once, through `isGrantDecisionLine`,
    // which prompts the paused turn's session with the decision and the resume
    // instruction. Were it ALSO an ordinary event, the generic path would prompt
    // the granted work a second time.
    expect(isGrantDecisionLine(grantLine(), AGENT)).toBe(true);
    expect(isSubscribedEvent(grantLine(), AGENT)).toBe(false);
    expect(inboxItemTriggersTurn(grantLine(), AGENT)).toBe(true);
    // A decision the agent is not mentioned on reaches nothing at all.
    expect(inboxItemTriggersTurn({ ...grantLine(), mentionIds: [] }, AGENT)).toBe(false);
    // It skips the sender policy: the owner's decision was the authority.
    expect(inboxItemSkipsSenderPolicy(grantLine(), AGENT)).toBe(true);
  });

  it('drops a resume kind that carries no decision line the agent can act on', () => {
    // A `grant-decided` row whose text is not a decision matches neither path:
    // the event path excludes RESUME kinds and the grant path cannot parse it.
    const unparseable = line({
      authorId: OWNER,
      body: 'Ada did something else entirely',
      systemEvent: {
        subject: { kind: 'person', id: OWNER, name: 'Ada' },
        verb: 'approved',
        kind: 'grant-decided',
      },
    });
    expect(inboxItemTriggersTurn(unparseable, AGENT)).toBe(false);
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

  it('still triggers, now through its kind (CRITICAL)', () => {
    expect(isScheduledPrompt(scheduled(), AGENT)).toBe(true);
    expect(inboxItemTriggersTurn(scheduled(), AGENT)).toBe(true);
    expect(inboxItemSkipsSenderPolicy(scheduled(), AGENT)).toBe(true);
    expect(inboxItemPromptBody(scheduled(), AGENT)).toBe('ping');
  });

  it('still triggers from a line written before the server stamped kinds', () => {
    // The one-release fallback. A row already in a Room carries the verb only.
    const legacy = scheduled({
      systemEvent: {
        subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: 'Beeline Scheduler' },
        verb: SCHEDULE_RAN_VERB,
        object: { text: 'Bee', id: AGENT },
        consequence: 'ping',
      },
    });
    expect(isScheduledPrompt(legacy, AGENT)).toBe(true);
    expect(inboxItemTriggersTurn(legacy, AGENT)).toBe(true);
    expect(inboxItemSkipsSenderPolicy(legacy, AGENT)).toBe(true);
    expect(inboxItemPromptBody(legacy, AGENT)).toBe('ping');
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

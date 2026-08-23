import { describe, expect, it } from 'vitest';
import {
  CONCLUDE_NUDGE_SPACING_MS,
  CONCLUDE_PROMPT,
  MAX_CONCLUDE_NUDGES_PER_EPISODE,
  concludeEpisodeExhausted,
  concludeNudgeDue,
  freshConcludeEpisode,
  standingAskFromEvents,
} from './conclude-watch.js';

describe('conclude watch episode rules', () => {
  it('a fresh episode is due immediately once a quiet turn end is marked', () => {
    const episode = freshConcludeEpisode();
    expect(concludeNudgeDue(episode, Date.now())).toBe(false);
    episode.quietSince = Date.now() - 1;
    expect(concludeNudgeDue(episode, Date.now())).toBe(true);
  });

  it('spacing blocks a second nudge until the window passes', () => {
    const now = 1_000_000;
    const episode = { ...freshConcludeEpisode(), quietSince: now, lastNudgeAt: now - 1 };
    expect(concludeNudgeDue(episode, now)).toBe(false);
    expect(concludeNudgeDue(episode, now + CONCLUDE_NUDGE_SPACING_MS)).toBe(true);
  });

  it('the bound is exactly two nudges per episode', () => {
    expect(MAX_CONCLUDE_NUDGES_PER_EPISODE).toBe(2);
    const episode = freshConcludeEpisode();
    expect(concludeEpisodeExhausted(episode)).toBe(false);
    episode.nudges = 1;
    expect(concludeEpisodeExhausted(episode)).toBe(false);
    episode.nudges = 2;
    expect(concludeEpisodeExhausted(episode)).toBe(true);
  });

  it('the conclude prompt names all three honest conclusions', () => {
    expect(CONCLUDE_PROMPT).toMatch(/review/i);
    expect(CONCLUDE_PROMPT).toMatch(/ask one clear question/i);
    expect(CONCLUDE_PROMPT).toMatch(/done|failed/s);
  });
});

describe('standingAskFromEvents', () => {
  const agent = 'agent-pubkey';
  const human = 'human-pubkey';
  const event = (overrides: {
    id: string;
    pubkey: string;
    created_at: number;
    content: string;
    t?: string;
  }) => ({
    id: overrides.id,
    pubkey: overrides.pubkey,
    created_at: overrides.created_at,
    content: overrides.content,
    tags: overrides.t ? [['t', overrides.t]] : [],
  });

  it('sees an unanswered agent question as standing', () => {
    const events = [
      event({ id: 'a', pubkey: agent, created_at: 10, content: 'Should I use tabs?', t: 'agent-message' }),
      event({ id: 'b', pubkey: agent, created_at: 5, content: 'Working on it.', t: 'agent-message' }),
    ];
    expect(standingAskFromEvents(events, agent)).toBe(true);
  });

  it('a later human message answers the ask', () => {
    const events = [
      event({ id: 'a', pubkey: agent, created_at: 10, content: 'Should I use tabs?', t: 'agent-message' }),
      event({ id: 'c', pubkey: human, created_at: 20, content: 'use spaces', t: '' }),
    ];
    expect(standingAskFromEvents(events, agent)).toBe(false);
  });

  it('daemon control chatter never asks and never masks a newer ask', () => {
    const events = [
      event({ id: 'x', pubkey: agent, created_at: 30, content: 'status: working', t: 'body-control' }),
      event({ id: 'a', pubkey: agent, created_at: 10, content: 'Which branch?', t: 'agent-message' }),
    ];
    expect(standingAskFromEvents(events, agent)).toBe(true);
  });

  it('an empty channel has no standing ask', () => {
    expect(standingAskFromEvents([], agent)).toBe(false);
  });

  it('narration without a question mark is not an ask', () => {
    const events = [
      event({ id: 'a', pubkey: agent, created_at: 10, content: 'Refactored the module. All green.', t: 'agent-message' }),
    ];
    expect(standingAskFromEvents(events, agent)).toBe(false);
  });
});

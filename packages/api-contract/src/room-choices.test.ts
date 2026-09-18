import { describe, expect, it } from 'vitest';
import {
  CHOICE_POLL_ELECTORATE_MAX,
  CHOICE_POLL_ELECTORATE_MIN,
  CHOICE_TTL_SECONDS,
  choiceClosedFooter,
  choiceOptionShare,
  decorateChoiceOptions,
  formatChoiceClock,
  isChoiceTtlSeconds,
  normalizeChoiceConstraint,
  normalizeChoiceOptions,
  normalizeChoicePrompt,
  normalizeChoiceTtl,
  tallyChoiceVotes,
} from './room-choices.js';

describe('choice option normalisation', () => {
  it('assigns A–D and flattens whitespace before judging length', () => {
    expect(
      normalizeChoiceOptions([
        { label: '  Kraken paper  ', consequence: 'Works with plugin auth' },
        { label: 'Keep waiting', consequence: 'Blocked on CDP JWT', costly: true },
      ]),
    ).toEqual([
      {
        optionId: 'A',
        letter: 'A',
        label: 'Kraken paper',
        consequence: 'Works with plugin auth',
      },
      {
        optionId: 'B',
        letter: 'B',
        label: 'Keep waiting',
        consequence: 'Blocked on CDP JWT',
        costly: true,
      },
    ]);
  });

  it('refuses fewer than two options, more than four, and over-long copy', () => {
    expect(() => normalizeChoiceOptions([{ label: 'A', consequence: 'one' }])).toThrow(
      '2 to 4 options',
    );
    expect(() =>
      normalizeChoiceOptions([
        { label: 'A', consequence: 'a' },
        { label: 'B', consequence: 'b' },
        { label: 'C', consequence: 'c' },
        { label: 'D', consequence: 'd' },
        { label: 'E', consequence: 'e' },
      ]),
    ).toThrow('2 to 4 options');
    expect(() =>
      normalizeChoiceOptions([
        { label: 'x'.repeat(33), consequence: 'ok' },
        { label: 'B', consequence: 'ok' },
      ]),
    ).toThrow('label is too long');
    expect(() =>
      normalizeChoiceOptions([
        { label: 'A', consequence: 'x'.repeat(81) },
        { label: 'B', consequence: 'ok' },
      ]),
    ).toThrow('consequence is too long');
  });

  it('owns prompt, constraint, and the ttl enum', () => {
    expect(normalizeChoicePrompt(' How do we ship? ')).toBe('How do we ship?');
    expect(() => normalizeChoicePrompt('x'.repeat(121))).toThrow('prompt is too long');
    expect(normalizeChoiceConstraint('  one line  ')).toBe('one line');
    expect(normalizeChoiceConstraint(undefined)).toBeUndefined();
    expect(CHOICE_TTL_SECONDS).toEqual([300, 900, 3600, 14_400, 86_400]);
    expect(isChoiceTtlSeconds(300)).toBe(true);
    expect(isChoiceTtlSeconds(60)).toBe(false);
    expect(normalizeChoiceTtl(900, true)).toBe(900);
    expect(() => normalizeChoiceTtl(undefined, true)).toThrow('ttlSeconds is required');
    expect(normalizeChoiceTtl(undefined, false)).toBeUndefined();
  });
});

describe('a closed poll tally is width, not permission', () => {
  const options = normalizeChoiceOptions([
    { label: 'Kraken', consequence: 'plugin auth' },
    { label: 'CDP', consequence: 'wait', costly: true },
    { label: 'Pause', consequence: 'stop' },
  ]);

  it('gives the unique leader full width and denser wash metadata', () => {
    const tally = tallyChoiceVotes(options, { A: 2, B: 1, C: 0 });
    expect(tally).toEqual({
      votesByOption: { A: 2, B: 1, C: 0 },
      leadingVotes: 2,
      uniqueLeaderId: 'A',
      outcome: 'winner',
    });
    expect(decorateChoiceOptions(options, tally)).toEqual([
      expect.objectContaining({ letter: 'A', votes: 2, share: 1, leader: true }),
      expect.objectContaining({ letter: 'B', votes: 1, share: 0.5 }),
      expect.objectContaining({ letter: 'C', votes: 0, share: 0 }),
    ]);
    expect(choiceClosedFooter(tally, 3, 4)).toBe('closed · 3 of 4 voted');
  });

  it('treats a tie as equal widths with no winner', () => {
    const tally = tallyChoiceVotes(options, { A: 1, B: 1, C: 0 });
    expect(tally.outcome).toBe('tie');
    expect(tally.uniqueLeaderId).toBeUndefined();
    expect(decorateChoiceOptions(options, tally).every((option) => !option.leader)).toBe(true);
    expect(choiceOptionShare(1, 1)).toBe(1);
    expect(choiceClosedFooter(tally, 2, 4)).toBe('tied · 1 and 1');
  });

  it('leaves empty tracks when nobody voted', () => {
    const tally = tallyChoiceVotes(options, {});
    expect(tally.outcome).toBe('no-votes');
    expect(decorateChoiceOptions(options, tally).every((option) => option.share === 0)).toBe(true);
    expect(choiceClosedFooter(tally, 0, 4)).toBe('closed · no votes');
  });

  it('keeps the poll electorate caps the server refuses on', () => {
    expect(CHOICE_POLL_ELECTORATE_MIN).toBe(2);
    expect(CHOICE_POLL_ELECTORATE_MAX).toBe(50);
  });

  it('formats a still close clock without travelling', () => {
    expect(formatChoiceClock(Date.UTC(2026, 8, 18, 16, 4) / 1000)).toMatch(/^\d{2}:\d{2}$/);
  });
});

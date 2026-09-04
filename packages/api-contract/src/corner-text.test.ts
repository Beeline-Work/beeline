import { describe, expect, it } from 'vitest';
import {
  CORNER_NAME_MAX_WORDS,
  CORNER_OBJECTIVE_MAX_WORDS,
  cornerDisplayName,
  cornerTextRefusal,
  normalizeCornerText,
} from './corner-text.js';

describe('corner text normalisation', () => {
  it('flattens the untidy shapes that used to be refused outright', () => {
    // The exact brief that silently killed two grok turns (C90).
    expect(
      normalizeCornerText(
        'Ship the corner name parameter.\nMake grok able to open a corner.\nUpdate every surface.',
      ),
    ).toBe('Ship the corner name parameter. Make grok able to open a corner. Update every surface.');
    expect(normalizeCornerText('  two  spaces\tand a tab ')).toBe('two spaces and a tab');
    expect(normalizeCornerText('\r\nleading and trailing\r\n')).toBe('leading and trailing');
  });

  it('accepts a normalised objective that only looked malformed', () => {
    expect(cornerTextRefusal('objective', 'Fix the ledger drift\nin the room list')).toBeUndefined();
    expect(cornerTextRefusal('name', ' ledger  drift ')).toBeUndefined();
  });
});

describe('corner text refusals', () => {
  it('names the limit and the actual count', () => {
    const objective = Array.from({ length: 61 }, (_, index) => `word${index}`).join(' ');
    expect(cornerTextRefusal('objective', objective)).toBe(
      'the objective is 61 words; the limit is 24',
    );
    expect(cornerTextRefusal('name', 'far too many words here')).toBe(
      'the name is 5 words; the limit is 3',
    );
  });

  it('names a missing text rather than staying silent', () => {
    expect(cornerTextRefusal('name', undefined)).toBe(
      'the name is required; give a title of at most 3 words',
    );
    expect(cornerTextRefusal('objective', '   \n  ')).toBe(
      'the objective is required; give one statement of at most 24 words',
    );
  });

  it('names an over-long text by its character count', () => {
    expect(cornerTextRefusal('name', 'a'.repeat(200))).toBe(
      'the name is 200 characters; the limit is 120',
    );
  });

  it('holds the two limits apart', () => {
    expect(CORNER_NAME_MAX_WORDS).toBe(3);
    expect(CORNER_OBJECTIVE_MAX_WORDS).toBe(24);
  });
});

describe('cornerDisplayName', () => {
  it('leaves a real name alone', () => {
    expect(cornerDisplayName('ledger drift fix')).toBe('ledger drift fix');
  });

  it('stands in for a legacy corner by cutting on a word boundary', () => {
    expect(
      cornerDisplayName(
        'Rework the room list so every corner row carries its own state mark and preview',
      ),
    ).toBe('Rework the room');
  });

  it('never renders a blank title as something', () => {
    expect(cornerDisplayName(undefined)).toBe('');
    expect(cornerDisplayName('   ')).toBe('');
  });
});

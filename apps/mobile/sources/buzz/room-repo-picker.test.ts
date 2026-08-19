import { describe, expect, it } from 'vitest';
import {
  dedupeRepoCandidates,
  looksLikeCornerOpenIntent,
  roomRepoChipLabel,
} from './room-repo-picker';

describe('dedupeRepoCandidates', () => {
  it('dedupes by key, keeping the first-seen name, sorted by name', () => {
    const result = dedupeRepoCandidates([
      { key: 'k2', name: 'zeta', remote: 'git://example.com/zeta' },
      { key: 'k1', name: 'alpha', remote: 'git://example.com/alpha' },
      { key: 'k1', name: 'alpha-dupe', remote: 'git://example.com/alpha' },
    ]);
    expect(result).toEqual([
      { key: 'k1', name: 'alpha', remote: 'git://example.com/alpha' },
      { key: 'k2', name: 'zeta', remote: 'git://example.com/zeta' },
    ]);
  });

  it('drops entries with no key', () => {
    expect(dedupeRepoCandidates([{ key: '', name: 'nope' }])).toEqual([]);
  });
});

describe('roomRepoChipLabel', () => {
  it('returns the binding name for a bound Room', () => {
    expect(
      roomRepoChipLabel({ binding: { key: 'k', name: 'widget', localOnly: false } }),
    ).toBe('widget');
  });

  it('returns null for a chat-only Room', () => {
    expect(roomRepoChipLabel(null)).toBeNull();
  });

  it('returns null for a blank name', () => {
    expect(roomRepoChipLabel({ binding: { key: 'k', name: '  ', localOnly: false } })).toBeNull();
  });
});

describe('looksLikeCornerOpenIntent', () => {
  it('matches common open-a-corner phrasings', () => {
    expect(looksLikeCornerOpenIntent('open a corner and fix the bug')).toBe(true);
    expect(looksLikeCornerOpenIntent('Can you open a new corner for this?')).toBe(true);
    expect(looksLikeCornerOpenIntent('start working on this in a corner')).toBe(true);
    expect(looksLikeCornerOpenIntent('CREATE CORNER')).toBe(true);
  });

  it('does not match ordinary chat', () => {
    expect(looksLikeCornerOpenIntent('what do you think about this corner case?')).toBe(false);
    expect(looksLikeCornerOpenIntent('hey, how is it going')).toBe(false);
  });
});

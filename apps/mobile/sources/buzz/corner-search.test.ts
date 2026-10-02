import { describe, expect, it } from 'vitest';
import type { CornerListItem } from '@beeline/buzz-client';
import { cornerMatchesSearch } from './corner-search';

const item = {
  corner: { name: 'Menu search mock' },
  initiator: { pubkey: 'p', name: 'Lunchbox', kind: 'human' },
  agent: { pubkey: 'a', name: 'Niglet', kind: 'agent' },
} as unknown as CornerListItem;

describe('cornerMatchesSearch', () => {
  it('matches the corner name, its opener and its agent, ignoring case and edges', () => {
    expect(cornerMatchesSearch(item, ' SEARCH ')).toBe(true);
    expect(cornerMatchesSearch(item, 'lunch')).toBe(true);
    expect(cornerMatchesSearch(item, 'niglet')).toBe(true);
    expect(cornerMatchesSearch(item, 'paging')).toBe(false);
  });
  it('matches every corner on a blank search, and one with no opener or agent by name', () => {
    expect(cornerMatchesSearch(item, '  ')).toBe(true);
    const bare = { corner: { name: 'Fix focus' } } as unknown as CornerListItem;
    expect(cornerMatchesSearch(bare, 'focus')).toBe(true);
    expect(cornerMatchesSearch(bare, 'niglet')).toBe(false);
  });
});

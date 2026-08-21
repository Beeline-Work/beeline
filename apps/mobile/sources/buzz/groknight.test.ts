import { describe, expect, it } from 'vitest';
import { beelineThemes, groknight } from './groknight';

describe('Beeline appearance themes', () => {
  it('ships Obsidian Refined as the default token set', () => {
    expect(groknight).toMatchObject({
      name: 'obsidian',
      bgTerminal: '#070708',
      bgBase: '#070708',
      textPrimary: '#f0f0f3',
      textSecondary: '#c9c9d1',
      textMuted: '#83838d',
      border: '#1c1c21',
      accent: '#c9a24b',
      diffAdded: '#3FB950',
      diffRemoved: '#F85149',
      proseRegular: 'IBMPlexSans-Regular',
    });
  });

  it('keeps content brighter than chrome and reserves mono for identity in every theme', () => {
    expect(Object.keys(beelineThemes)).toEqual(['obsidian', 'editorial', 'ledger']);
    for (const theme of Object.values(beelineThemes)) {
      expect(theme.textPrimary).not.toBe(theme.textMuted);
      expect(theme.ledgerBright).toBe(theme.textPrimary);
      expect(theme.monoRegular).toBe('IBMPlexMono-Regular');
    }
    expect(beelineThemes.editorial.proseRegular).toBe('IBMPlexSerif-Regular');
    expect(beelineThemes.ledger.proseRegular).toBe('IBMPlexMono-Regular');
    expect(beelineThemes.ledger.turnGap).toBeLessThan(beelineThemes.obsidian.turnGap);
  });
});

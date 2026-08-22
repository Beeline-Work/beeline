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
      accent: '#b08a4a',
      diffAdded: '#3FB950',
      diffRemoved: '#F85149',
      proseRegular: 'SpaceGrotesk-Regular',
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
    // The Editorial direction is the most generous rhythm: one-size type with
    // wide turn padding, while the dense mono theme stays tight.
    expect(beelineThemes.ledger.turnPaddingVertical).toBeLessThan(
      beelineThemes.obsidian.turnPaddingVertical,
    );
    // ONE message size holds in every theme: no lead/prose size split.
    for (const theme of Object.values(beelineThemes)) {
      expect(theme.leadSize).toBe(theme.proseSize);
      expect(theme.proseMedium).toBeTruthy();
    }
  });
});

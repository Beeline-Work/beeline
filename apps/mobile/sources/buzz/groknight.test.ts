import { describe, expect, it } from 'vitest';
import { beelineThemes, groknight } from './groknight';

describe('Beeline appearance themes', () => {
  it('ships Obsidian Refined as the default token set', () => {
    expect(groknight).toMatchObject({
      name: 'obsidian',
      // Speakeasy brand canvas — the app-wide background at the token level.
      bgTerminal: '#14091A',
      bgBase: '#14091A',
      textPrimary: '#f0f0f3',
      textSecondary: '#c9c9d1',
      textMuted: '#83838d',
      border: '#291e33',
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

describe('Speakeasy canvas alignment', () => {
  it('sets the app-wide background to the Speakeasy brand canvas in every theme', () => {
    for (const theme of Object.values(beelineThemes)) {
      expect(theme.bgVoid).toBe('#14091A');
      expect(theme.bgTerminal).toBe('#14091A');
      expect(theme.bgBase).toBe('#14091A');
      expect(theme.avatarGround).toBe('#14091A');
    }
  });

  it('keeps every elevation stop at or above the canvas, in ladder order', () => {
    // Luminance proxy: the green channel dominates perceived brightness here
    // and every stop shares a near-identical hue direction, so ordering on it
    // is a faithful check that no stop was pushed BELOW its canvas.
    const lum = (hex: string) => {
      const value = hex.replace('#', '');
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const theme of Object.values(beelineThemes)) {
      const canvas = lum(theme.bgBase);
      expect(lum(theme.bgRaised)).toBeGreaterThanOrEqual(canvas);
      expect(lum(theme.bgHighlight)).toBeGreaterThan(canvas);
      // Ledger deliberately shares one stop for highlight and hover.
      expect(lum(theme.bgHover)).toBeGreaterThanOrEqual(lum(theme.bgHighlight));
      expect(lum(theme.bgPressed)).toBeGreaterThan(lum(theme.bgHighlight));
      expect(lum(theme.bgTexturePeak)).toBeGreaterThan(lum(theme.bgPressed));
      // Hairlines must stay visible against both the canvas and raised surfaces.
      expect(lum(theme.border)).toBeGreaterThan(canvas);
    }
  });
});
